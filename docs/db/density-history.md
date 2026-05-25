# Local density history (M-1)

Greenhaven cartridges cache "what is directly here" on every location and
district as `entities.profile.local_density` (id arrays) and
`entities.profile.local_density_summary` (counts). Districts and hubs
also cache `entities.profile.transitive_density_summary` — the rolled-up
counts of the location plus all its descendants.

These fields exist so the UI can render a "this place contains N people,
M scenes, K activities" rail without recomputing the runtime UNION used
by `loadPresentPeopleAtLocation`. The runtime UNION reaches further
(scenes, activities, quests can pull NPCs in transitively), but the
cached density is **direct ownership only**.

This document records why the rebuild went through four sequential
fix-it migrations before landing on the M-1 stored function in
`0104_density_rebuild_function.sql`.

## Migration timeline

### `0091_density_runtime_compile.sql`

First attempt to rebuild density from runtime contracts.

**Bug.** The CTE that produced the new density `UNION`-ed the existing
`local_density.npc_ids` back in. Power-center duplicates — for example,
NPCs of every district stuffed into Guildhall, scenes/activities of
every venue stuffed into Ale & Eats — survived the "rebuild" because
they were in the row's old array before 0091 ran.

### `0092_density_strict_rebuild.sql`

Partial repair pass. Removed some of the surviving duplicates but did
not change the union-with-old-values algorithm, so drift remained on
districts that had been touched between 0091 and 0092 by the cartridge
re-importer.

### `0093_strict_local_density_and_transitive_rollup.sql`

Final correct algorithm. **0093 is the source of truth** for the rebuild
contract:

- `npc_ids` = persons with `home_id = this location`.
- `scene_ids` = scenes with `location_id = this location`.
- `event_ids` = events with `location_id = this location`.
- `activity_ids` = activities with `location_id = this location`.
- `quest_ids` = quests with `location_id = this location`.
- `child_location_ids` = locations/districts whose `topology_parent_id =
  this location`.
- `transitive_density_summary` = sum of `local_density_summary` counts
  over this location plus every descendant reachable via
  `topology_parent_id`, depth-capped at 8.

Caps: 16 npcs, 12 scenes / events / activities, 8 quests, 24
child_locations. (Parameterisation is M-3 work.)

No `UNION` with previous values. The density JSON is fully derived from
the rest of the row set.

### `0094_district_name_topology_repair.sql`

Per-record repair pass for district names / topology parents that the
cartridge importer had clobbered. Needed because `0082` (and the
`packages/desktop-electron/web-server/migrations/0078_*` /
`0082_grinhaven_full_dataset_cartridge.sql` /
`0096_grinhaven_market_square_demo_start.sql` /
`0099_mikka_companion_offer.sql` /
`0100_test_bench_items.sql` snapshots) used raw `ON CONFLICT (id) DO
UPDATE SET ... profile = EXCLUDED.profile, ...` upserts. That `profile =
EXCLUDED.profile` line overwrote runtime-computed fields
(`topology_parent_id`, `local_density`, `local_density_summary`) with
whatever the cartridge author had shipped.

### `0103_forge_upsert_protected_fields.sql` (M-2)

Defines `gh_forge_merge_entity_profile(existing, incoming)`. The
Cartridge Forge exporter
(`packages/cartridge-forge/src/exporters/exportGrinhavenSql.ts`) now
emits

```sql
profile = gh_forge_merge_entity_profile(entities.profile, EXCLUDED.profile)
```

on `ON CONFLICT (id)`, so future re-imports preserve
`topology_parent_id`, `local_density`, and `local_density_summary`
instead of clobbering them. 0094-style repairs are no longer needed in
fresh environments.

### `0104_density_rebuild_function.sql` (M-1)

Extracts the 0093 algorithm into a reusable stored function:

```sql
rebuild_local_density(target_cartridge text)
RETURNS TABLE(location_id bigint, npc_count int, child_count int)
```

The function rewrites `local_density` and `local_density_summary` for
locations/districts in the target cartridge, then re-runs the
recursive-CTE transitive rollup. It is **idempotent** by construction —
the output is fully derived from the row set; running it twice produces
the same JSON.

The migration calls the function once against the active fixture
cartridge:

```sql
SELECT rebuild_local_density('grinhaven-full');
```

On a fresh database that has just applied 0091-0094 and 0103, this call
is a state-preserving no-op: the inputs are unchanged, so the produced
density JSON equals the existing density JSON.

### `0107_density_caps_parameterized.sql` (M-3)

Replaces the 0104 function with a parameterised variant:

```sql
rebuild_local_density(
  target_cartridge text,
  max_npcs int DEFAULT 16,
  max_child_locations int DEFAULT 24,
  max_scenes int DEFAULT 12,
  max_events int DEFAULT 12,
  max_activities int DEFAULT 12,
  max_quests int DEFAULT 8
)
RETURNS TABLE(location_id bigint, npc_count int, child_count int)
```

Defaults match 0104 exactly so a one-argument call
(`SELECT rebuild_local_density('grinhaven-full')`) preserves
existing behavior. Operators or cartridge authors can override any
cap by updating `cartridge_meta.density_caps`:

```sql
UPDATE cartridge_meta
   SET value = COALESCE(value, '{}'::jsonb) || '{"npcs": 24}'::jsonb
 WHERE key = 'density_caps';
```

0107 seeds `cartridge_meta.density_caps` with the 0104 defaults via
`ON CONFLICT (key) DO NOTHING` so existing operator values are
preserved.

The body also switches the cartridge/topology filters off the legacy
JSONB keys onto the ARCH-19 Phase 3 normalized columns
(`entities.cartridge_id`, `entities.topology_parent_id`). Phase 4
will eventually drop the JSONB keys; the function does not consult
them.

The TypeScript wrapper in `packages/web-server/src/density/index.ts`
(`rebuildLocalDensity`, `loadDensityCaps`, `normalizeDensityCaps`,
`DEFAULT_DENSITY_CAPS`) reads the meta value via `getMeta`,
sanitises each cap (positive integers only, falls through to the
default per-key), and calls the function with explicit parameters.
There is no `quickgrin-lane` shortcut in the wrapper; the active
cartridge id comes from `activeCartridgeId()` (which itself uses
`getMetaRequired`).

The 0107 migration calls `rebuild_local_density('grinhaven-full')`
once with default caps. Idempotent on a database that already passed
through 0104.

### `0108_density_depth_cap_diagnostics.sql` (M-4)

Wraps 0107 with structured depth-cap diagnostics. The recursive
descendants CTE in 0093/0104/0107 silently truncates at `depth < 8`;
0108 makes that truncation observable without changing density JSON.

The migration adds an append-only `migration_diagnostics` table
(`id`, `recorded_at`, `level` ∈ `info|warn|error`, `source`,
`payload jsonb`) and replaces `rebuild_local_density` with a body
that is byte-for-byte identical to 0107 for the two data-mutating
phases, plus a tail block:

```sql
INSERT INTO migration_diagnostics (level, source, payload)
SELECT 'warn', 'rebuild_local_density.depth_cap',
       jsonb_build_object(
         'target_cartridge',      target_cartridge,
         'root_id',               d8.root_id,
         'depth_cap',             8,
         'depth_cap_hit',         true,
         'truncated_child_count', d8.truncated_child_count
       )
  FROM ( ... walks the same topology and counts children whose
         topology_parent_id is a depth-8 node ... ) d8;
```

The diagnostic CTE deliberately only emits when a root reaches the
depth-7→depth-8 frontier AND has immediate children one step
beyond (which would be depth 9 and which the rollup CTE drops). A
root that simply happens to end at depth 8 with no deeper
descendants does **not** warn — the cap was not exercised.

The signature, defaults, normalized-column reads, and one-argument
call compatibility are preserved. Direct SQL callers (e.g. ad-hoc
DBA queries) still get diagnostics rows even though they cannot
emit telemetry.

The wrapper (`packages/web-server/src/density/index.ts`) snapshots
`MAX(migration_diagnostics.id)` before the SQL call and, after the
rebuild returns, reads warn rows where `id > snapshot AND source =
'rebuild_local_density.depth_cap' AND payload->>'target_cartridge'
= <cartridgeId>`. When at least one row matches it calls
`telemetry.record({channel: 'gameplay', name:
'gameplay:density_depth_cap_hit', data: {...}})` **exactly once**
with the aggregate payload (root ids + total truncated child
count). The pre-call snapshot is the per-call isolation boundary —
concurrent rebuilds against different cartridges do not bleed warn
rows into each other.

0108 does **not** re-run `rebuild_local_density('grinhaven-full')`
at migration time. 0107 already does that, and the data-mutating
phases are unchanged in 0108, so re-running would be a
state-preserving no-op for the density JSON and would lengthen
every cold migration template build.

### `0109_density_depth_cap_diagnostics_guard.sql` (M-4 hardening)

Wraps the 0108 diagnostic INSERT in a PL/pgSQL sub-block with
`EXCEPTION WHEN undefined_table THEN NULL`. The motivation is
operator drift: if `migration_diagnostics` is dropped or renamed
after 0108 applied, every subsequent `SELECT
rebuild_local_density(...)` would otherwise fail even though the
rebuild itself does not depend on the table. The guard preserves
all other failure modes — anything that isn't `undefined_table`
still propagates.

Data-mutating Phase 1 + Phase 2 blocks are byte-for-byte identical
to 0108. Signature, defaults, return shape, normalized-column
reads, and one-argument call compatibility are preserved. No tail
rebuild call.

The TS wrapper in `packages/web-server/src/density/index.ts`
carries the same best-effort discipline at the application layer:

- The pre-rebuild `MAX(migration_diagnostics.id)` snapshot is now
  inside a `try/catch`. If it throws, `beforeId` stays `null`, the
  rebuild still runs, and the post-rebuild telemetry path is
  skipped (no isolation boundary).
- The post-rebuild diagnostics read and telemetry emit stay inside
  a `try/catch`. A failure logs a bounded warning and returns the
  rebuild rows.
- Real `rebuild_local_density(...)` SQL failures still propagate —
  only diagnostic/telemetry paths are swallowed.

## Authoring rules

- **Do not edit** 0091, 0092, 0093, or 0094. They are applied immutable
  migrations.
- **Do not** add new ad-hoc density-rebuild SQL in future migrations.
  Call `SELECT rebuild_local_density('<cartridge_id>');` after the data
  changes that require a refresh.
- **Do not** force `rebuild_local_density` on server startup. The
  recursive CTE is not free; the function should run only when a
  cartridge ships new density-affecting entities.
- Density-affecting fields are: a person's `home_id`, a
  scene/event/activity/quest's `location_id`, or a location/district's
  `topology_parent_id`. Anything else can be edited without calling the
  rebuilder.

## Why the four-migration chain still ships

The repository retains 0091, 0092, 0093, and 0094 even though their
behaviour is now subsumed by 0103 + 0104. Applied migrations are
immutable by repository policy: a fresh database must reach the same final
state as the dev/prod databases that have already run the chain in
order. Removing 0091-0094 would cause migration-numbering drift and a
divergent schema-migrations table.

The legacy raw `profile = EXCLUDED.profile` clobber pattern is still
present in the following immutable migrations (web-server tree):

- `0082_grinhaven_full_dataset_cartridge.sql` — initial bulk Grinhaven
  data load.
- `0096_grinhaven_market_square_demo_start.sql` — Market Square demo
  data.
- `0099_mikka_companion_offer.sql` — Mikka companion offer data.
- `0100_test_bench_items.sql` — test-bench items.

Plus the desktop-electron mirror tree (`packages/desktop-electron/web-server/migrations/0078_*`,
`0082_*`, etc.). These are accepted historic state, not regressions; the
M-2 helper protects against the pattern recurring in **new** cartridge
re-imports.
