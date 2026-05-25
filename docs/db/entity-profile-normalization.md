# Entity profile normalization (ARCH-19)

`entities.profile` historically holds 10+ heterogeneous concepts in one
JSONB blob: `cartridge_id`, `topology_parent_id`, `origin`, identity,
physical, background, exits, `local_density`, etc. ON CONFLICT used to
clobber the whole blob (M-2 plugged that for the forge re-import path
via `gh_forge_merge_entity_profile`). ARCH-19 lifts the hottest read
fields out of JSONB into normalized columns so cartridge-scope
predicates, topology lookups, and the dynamic/static partition can use
real indexes instead of `jsonb_path_ops` GIN scans.

The migration sequence is **staged**, not big-bang. Each phase ships in
its own forward-only migration so dev/prod can soak between cuts.

## Phase 1 — add columns + backfill (migration `0105`)

**Status: shipped.**

`0105_normalize_entity_profile_phase1_add_columns.sql` adds three
columns and a helper:

| Column                | Type             | Constraint                                                                 |
| --------------------- | ---------------- | -------------------------------------------------------------------------- |
| `cartridge_id`        | `text NULL`      | Indexed where NOT NULL.                                                    |
| `topology_parent_id`  | `bigint NULL`    | FK to `entities(id) ON DELETE SET NULL`. Indexed where NOT NULL.           |
| `dynamic_origin`      | `boolean NOT NULL DEFAULT false` | Indexed where `dynamic_origin = true`.                  |

A small immutable helper `safe_to_bigint(value text) RETURNS bigint`
returns NULL for malformed or out-of-range input so the
`topology_parent_id` backfill cannot abort the transaction on a stale
profile value.

Backfill rules (semantics-preserving):

1. `cartridge_id := profile->>'cartridge_id'` when present.
2. `dynamic_origin := true` when `profile->>'origin' = 'dynamic'` OR
   `'dynamic' = ANY(tags)`.
3. `topology_parent_id := safe_to_bigint(profile->>'topology_parent_id')`
   when the value parses AND points at an existing
   `kind IN ('location', 'district')` row.
4. Unmarked static entities (no `profile->>'cartridge_id'`, not players,
   not dynamic, not `support-smoke` tagged) get
   `cartridge_id = 'quickgrin-lane'` to mirror the existing
   `cartridgeScope.ts` fallback predicate at line 19. The
   `support-smoke` tag carve-out is preserved because the live reader
   still uses it; Phase 3 will replace tag-based scoping with explicit
   `cartridge_id = 'support-smoke'` rows.

Phase 1 **does not** modify writers and **does not** modify
`cartridgeScope.ts`. Legacy `profile` keys remain. The columns are
populated in parallel.

## Phase 2 — switch writers (in progress)

Phase 2 splits into two slices.

### Phase 2A — gameplay/runtime + forge writers (shipped)

`packages/web-server/src/entities/profileProjection.ts` exports
`projectEntityNormalizedColumns({profile, tags})`, the single source
of derivation. Migrated writers:

- `packages/web-server/src/tools/entity.ts` —
  `create_entity` INSERT now includes `cartridge_id`,
  `topology_parent_id`, `dynamic_origin`. The
  `topology_parent_id` column uses a `(SELECT id FROM entities
  WHERE id = $X AND kind IN ('location', 'district'))` subquery so a
  dangling profile id projects to NULL instead of breaking the
  insert under the new FK. `update_entity` re-derives the three
  columns in SQL from the post-patch `(profile || patch)` and
  post-replacement `tags` expressions whenever either changes —
  this keeps the columns in lockstep with JSONB across the
  dual-write window without re-reading the row.
- `packages/web-server/src/tools/quest.ts` —
  spawn-entity INSERTs inside `start_quest` and the quest's own
  INSERT use the projection helper.
- `packages/web-server/src/devtools/livePlaytestControlPlane.ts` —
  the three debug-NPC / debug-quest / grant-item INSERTs all use the
  projection helper. These are still gated by the
  `/api/debug/live-*` routes, so they only fire in dev/support
  smoke runs.
- `packages/cartridge-forge/src/exporters/exportGrinhavenSql.ts` —
  forge SQL INSERTs include `cartridge_id` and `dynamic_origin`
  derived inline per row. `topology_parent_id` is **not** in the
  initial INSERT (the self-FK fires per row and parents may live
  later in the same VALUES list); instead the exporter emits a
  post-INSERT `UPDATE entities child SET topology_parent_id = ... `
  that projects from `safe_to_bigint(profile->>'topology_parent_id')`
  joined against an existing location/district. The forge
  `ON CONFLICT (id) DO UPDATE` clause is **unchanged** — it still
  refreshes `kind`/`display_name`/`summary`/`profile (via
  gh_forge_merge_entity_profile)/tags/updated_at` only, so existing
  normalized columns are preserved across re-imports (matches the
  M-2/ARCH-19 acceptance criterion).
- `packages/cartridge-forge/src/importers/grinhavenMigration.ts` —
  `parseEntities` now accepts both 6-column legacy fixtures and
  8-column current forge output, so historical round-trip tests keep
  working alongside the new INSERT shape.

Phase 2A coverage:

- `packages/web-server/src/__tests__/entities/profileProjection.test.ts`
  — unit tests for the projection helper (cartridge_id extraction +
  empty/trim/non-string rejection, numeric/string
  topology_parent_id parsing, rejection of zero / negative /
  fractional / non-numeric, dynamic_origin truthy paths via
  `profile.origin = 'dynamic'` and `'dynamic'` tag, falsy default,
  and end-to-end projections for a dynamic spawn vs a cartridge
  entity).
- `packages/cartridge-forge/tests/project.test.ts` — asserts the new
  forge INSERT column list, the post-INSERT topology UPDATE that
  uses `safe_to_bigint`, and that the ON CONFLICT clause does not
  touch any of the three normalized columns.

### Phase 2B — fixture seeders + writer-hardening (shipped)

- `packages/web-server/src/entities/profileProjection.ts` —
  `parseTopologyParentId` now rejects malformed, negative, zero,
  fractional, **and** JS-unsafe / pg-bigint-overflow values via a
  `BigInt`-based guard so no caller can pass a silently rounded
  `Number(...)` into `$N::bigint`. `cartridge_id` is now trimmed,
  matching the `update_entity` SQL `NULLIF(TRIM(...), '')` behavior.
- `packages/web-server/src/tools/quest.ts` — the
  exact-duplicate `spawn_entities` UPDATE branch now re-derives
  `cartridge_id`, `topology_parent_id`, and `dynamic_origin` from the
  post-patch profile and the existing tags inside the SQL (the same
  pattern `update_entity` uses), so the columns stay in sync with
  JSONB even when the projection is computed from a partial spawn
  payload merged into a pre-existing row.
- `packages/web-server/src/devtools/supportSmoke.ts` — the central
  `insertEntity` helper now lands non-player support-smoke fixtures
  with `cartridge_id = 'support-smoke'` (plus the legacy
  `'support-smoke'` tag), so the Phase 3 reader switch can drop the
  tag-based carve-out from `cartridgeScope.ts`. Players keep
  `cartridge_id = NULL` because the reader's `kind = 'player'`
  branch already scopes them across cartridges. The
  `support-smoke-i18n` quest INSERT also explicitly writes
  `cartridge_id = 'support-smoke'`.
- `packages/web-server/src/devtools/simulateSpecialist.ts` — the
  `upsertEntity` helper dual-writes on INSERT and re-derives the
  columns from the post-merge profile on UPDATE.
- `packages/web-server/src/devtools/orderedQueueFixture.ts` — the
  ordered-queue support quest insert lands with
  `cartridge_id = 'support-smoke'`.
- `packages/web-server/src/devtools/generateMigrationSnippet.ts` —
  generated migration `INSERT INTO entities` snippets now include
  `cartridge_id` and `dynamic_origin` derived from the input
  payload. `topology_parent_id` is left for the existing Phase 1
  backfill / `rebuild_local_density` path because a batch migration
  snippet cannot guarantee parent rows land before children.

### Phase 2 entries that are intentionally **not** Phase 2B targets

- `packages/web-server/src/adventure/adventureArbiter.ts` — three
  `UPDATE entities` sites (`attachAdventureQuestItems`,
  situation-link patch, encounter-introduction patch) patch only
  `quest_items`, `situation_links`, encounter metadata. None touch
  ARCH-19 source concepts. Adventure-driven entity creation goes
  through `dispatch('create_entity', ...)` which is the Phase 2A
  path.
- `packages/web-server/src/tools/quest.ts` —
  `stampSpawnedEntitiesWithQuest` and stage-reveal UPDATE patches
  patch `source_quest_id` and `hidden_until_stage` / remove
  `hidden` tags only.
- `packages/web-server/src/tools/inventoryCommon.ts` — inventory
  mirror entity insert writes `{inventory_item_slug}` profile and
  `['item', 'inventory', category]` tags only.
- `packages/web-server/src/devtools/cartridgeI18nAuthoring.ts` —
  emits `UPDATE entities SET i18n = ...` snippets only. Does not
  touch profile/tags/cartridge_id/topology/origin source concepts.
- Historic / immutable migration files (e.g. `0082`, `0096`, `0099`,
  `0100`) are out of scope; Phase 1's one-shot backfill and the
  M-2/ARCH-19 forge fix cover their re-applications.

## Phase 3 — switch readers (migration 0106 + code) — shipped

**Status: shipped 2026-05-15.**

- `packages/web-server/migrations/0106_normalize_entity_profile_phase3_reader_cleanup.sql`
  is an idempotent forward-only cleanup that catches rows added
  between Phase 1's one-shot backfill and Phase 2's writer migrations.
  Steps (each WHERE-bounded to skip already-correct rows):
  1. Trim whitespace around any existing `cartridge_id` column
     value; copy `NULLIF(TRIM(profile->>'cartridge_id'), '')` into
     the column for rows still NULL.
  2. Stamp any non-player `'support-smoke'`-tagged row that still
     lacks a `cartridge_id` with `cartridge_id = 'support-smoke'` so
     the Phase 3 reader no longer needs the tag carve-out.
  3. Set `dynamic_origin = true` for every row with
     `profile->>'origin' = 'dynamic'` or `'dynamic' = ANY(tags)`
     that was still `false`.
  4. Compute `topology_parent_id` for rows that still have NULL but
     whose `profile->>'topology_parent_id'` resolves through
     `safe_to_bigint` to an existing location/district.
  5. Mirror the Phase 1 `quickgrin-lane` fallback for any non-player
     non-dynamic non-support-smoke entity still unmarked.
- `packages/web-server/src/cartridgeScope.ts` is rewritten:
  `activeCartridgeId` uses `getMetaRequired<string>('cartridge_id')`
  with no `'quickgrin-lane'` fallback; the predicate is the
  three-line column-only form:
  ```sql
  (alias.cartridge_id = $cartridge
    OR alias.dynamic_origin = true
    OR alias.kind = 'player')
  ```
  No `profile->>...` consults, no `'dynamic'` tag check, no
  `'support-smoke'` carve-out.
- Reader call sites swept:
  - `agents/adventureMaterializerInput.ts` (3 SELECTs +
    `ANY($1::text[]::bigint[])` topology filter).
  - `locationGraph.ts` location-children query uses
    `topology_parent_id = $1::bigint`.
  - `resetWorld.ts` `DYNAMIC_ENTITY_WHERE_SQL` is now
    `'dynamic_origin = true'`.
  - `services/SessionLifecycleService.ts` map-nodes query uses
    `topology_parent_id::text`.
  - `tools/entity.ts` `derivePlacementFromPlayer` uses
    `e.topology_parent_id` directly.
  - `devtools/livePlaytestControlPlane.ts` debug-entity reset
    predicate uses `e.dynamic_origin = true`.
  - `services/DebugDiagnosticsService.ts` dynamic-quest snapshot
    uses `dynamic_origin = true`.
  - `devtools/validateCartridge.ts` reads `cartridge_id` /
    `dynamic_origin` columns and throws when
    `cartridge_meta.cartridge_id` is missing (no `quickgrin-lane`
    fallback).
- `devtools/supportSmoke.ts` `seedSupportWorld` now sets
  `cartridge_meta.cartridge_id = 'support-smoke'` and clears the
  `getMeta` cache at fixture setup, so the predicate matches the
  seeded fixtures without needing the tag carve-out.

ARCH-8 cartridge-scope cleanup is closed by Phase 3: no
`'quickgrin-lane'` literal remains in `packages/web-server/src/`
outside of the cleanup-migration backfill and historic migration
files; no production predicate consults the `'support-smoke'` tag.

## Phase 4 — drop legacy JSONB keys (migration ~0108)

**Status: todo, gated on soak.**

Remove the now-redundant `profile.cartridge_id`,
`profile.topology_parent_id`, `profile.origin`, and any retired
`'dynamic'` / `'support-smoke'` tags from `entities`. This is the
**non-reversible** step; once the JSONB keys are gone, any reader still
using `profile->>'cartridge_id'` will silently return NULL.

Requirements before Phase 4 can ship:

1. **Soak window** on dev — at least one full content audit cycle plus
   a manual playtest pass after Phase 3 ships, with no reader bug
   reports.
2. **Soak window** on prod — at least one release shipped with Phase 3
   active before the JSONB drop runs.
3. **Verification grep** — `grep -rn "profile->>'cartridge_id'\\|profile->>'topology_parent_id'\\|profile->>'origin'" packages/web-server/src` returns no production callers.
4. **Forge regeneration** — Cartridge Forge SQL exports verified to
   stop writing the dropped keys.

The first three are checklist gates; the fourth is enforced by a
cartridge-forge test that asserts the generated SQL does not include
the dropped keys.

### Phase 4 readiness CLI

`packages/web-server/src/scripts/arch19-phase4-readiness.ts` makes
the gate machine-readable. It runs the source sweep
(`devtools/arch19SourceSweep.ts`) plus optional DB parity / null-
cartridge / legacy-count queries, evaluates the pure policy helper
`devtools/arch19Phase4Readiness.ts`, and prints a typed
`Arch19Phase4ReadinessDecision` with `ready_for_phase4_drop`,
stable `blockers`, informational `warnings`, the policy thresholds,
and observed counts. Exit code is `0` only when every clause is
satisfied; `1` for any blocker; `2` for usage / IO error.

Default policy: `min_dev_soak_days: 14`, `require_prod_release: true`,
`require_forge_export_clean: true`. Phase 3 shipped 2026-05-15, so on
2026-05-17 the gate blocks with `dev_soak_window_not_elapsed:2/14_days`
+ `prod_release_not_confirmed` + `forge_export_still_writes_dropped_keys`.

**`--no-db` is advisory only.** Source-only runs cannot authorize the
destructive Phase 4 drop. The CLI sets `database_safety_checked: false`
whenever `--no-db` is passed, and the evaluator then emits the
`database_counts_not_checked` blocker so `ready_for_phase4_drop` stays
false and the exit code stays `1`. Even after 2026-05-29 with
`--prod-release-confirmed` and `--forge-export-clean`, a `--no-db`
invocation still blocks — the parity / null-cartridge / legacy-count
queries MUST come from a real pgdata before authorization. To flip
true, drop `--no-db` and supply `--pgdata <dir>` (or `--fixture-mode
temp`); `database_safety_checked` is only set true after
`loadDbCounts()` returns successfully. DB load/query errors propagate
out as exit code `2`, never as a silent ready=true.

**Forge cleanliness is evidence-driven via `--forge-sql <path>`.**
Pass the generated artifact (e.g.
`GreenhavenWorld/.greenhaven-agent-manual/generated/obsidian-world-preview.sql`)
and the CLI parses every per-entity `profile` JSONB literal in the
entity VALUES block. `forge_export_clean: true` only when every
literal omits the retired ARCH-19 keys (`cartridge_id`,
`topology_parent_id`, `origin`) AND there are zero JSON parse
errors. The legacy `--forge-export-clean` boolean is preserved as the
explicit operator override (recorded as
`forge_evidence.source: 'manual'`) for cases where no SQL artifact is
available; when both flags are supplied the SQL-derived verdict wins
so an honest operator self-report cannot mask a dirty artifact. CLI
JSON output gains a `forge_evidence` block with `source` (`none` /
`manual` / `forge_sql`), `path`, `profile_literal_count`, per-key
`retired_key_hits`, `parse_errors`, and the derived
`forge_export_clean`. File-read errors land in `parse_errors` and
force the gate closed — never silently authorize the drop.

Typical operator invocations:

```sh
# Today's verdict (blocked by dev-soak + prod-release + forge-export AND
# by `database_counts_not_checked`, because every `--no-db` run sets
# `database_safety_checked: false` regardless of date — pre-soak and
# post-soak alike):
npx tsx packages/web-server/src/scripts/arch19-phase4-readiness.ts \
  --as-of 2026-05-17 --phase3-shipped 2026-05-15 --min-dev-soak-days 14 --no-db

# After dev soak elapses, count parity against a fresh dev pgdata:
npx tsx packages/web-server/src/scripts/arch19-phase4-readiness.ts \
  --as-of 2026-05-29 --pgdata C:\Users\<you>\AppData\Roaming\GreenHaven\pgdata \
  --prod-release-confirmed --forge-export-clean

# Post-soak --no-db is STILL blocked (database_counts_not_checked):
npx tsx packages/web-server/src/scripts/arch19-phase4-readiness.ts \
  --as-of 2026-06-01 --phase3-shipped 2026-05-15 --min-dev-soak-days 14 \
  --prod-release-confirmed --forge-export-clean --no-db

# Forge cleanliness from a generated SQL artifact (replaces the
# manual --forge-export-clean boolean with parsed evidence; today's
# verdict still blocks on dev-soak / prod-release / DB, but
# forge_export_clean is now derived from the artifact):
npx tsx packages/web-server/src/scripts/arch19-phase4-readiness.ts \
  --as-of 2026-05-17 --phase3-shipped 2026-05-15 --min-dev-soak-days 14 --no-db \
  --forge-sql GreenhavenWorld/.greenhaven-agent-manual/generated/obsidian-world-preview.sql
```

Legacy `profile->>'cartridge_id'` etc. counts are emitted as
informational warnings, not blockers — the whole point of Phase 4 is
to drop them. Parity mismatches are what actually block, because they
would lose information the normalized column has not already mirrored.

## Why we keep dual write/read between phases

Phase 1 backfills the column but the reader still uses the JSONB key.
Phase 2 starts populating the column on write but the reader still
uses the JSONB key. Phase 3 flips the reader. Each phase is a no-op for
any consumer except the one being migrated. If Phase 3 ships with a
bug, the JSONB key is still authoritative and we can revert the reader
without re-backfilling. After Phase 4 the JSONB key is gone and that
escape hatch closes — hence the soak requirement.

## Related fixspecs

- `critique-report/fixspecs/11_tier0_arch.md#arch-19` — primary spec.
- `critique-report/fixspecs/11_tier0_arch.md#arch-8` — `cartridgeScope.ts`
  cleanup that follows Phase 3.
- `critique-report/fixspecs/12_tier1_data.md#m-5` — broader audit of
  unsafe bigint regex-then-cast patterns. The `safe_to_bigint` helper
  added in Phase 1 may be promoted to the public utility set when M-5
  closes.
- `critique-report/fixspecs/12_tier1_data.md#m-2` — `gh_forge_merge_entity_profile`,
  which guarantees the new columns survive forge re-imports during
  the staging window.
