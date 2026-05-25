# Engine Baseline Database Contract

## Purpose

This document defines the database boundary Greenhaven should use before
release:

- the database baseline creates the empty engine;
- cartridges install authored world content;
- playthroughs store what happened to a hero in one installed world.

There are no released player databases yet, so the project can replace the
historical migration chain with a clean baseline.

## Fresh Database Shape

A freshly created Greenhaven database should contain:

- engine schema tables;
- indexes and constraints;
- database extension setup;
- empty cartridge registry tables;
- empty player/session/runtime tables;
- minimal engine-owned metadata needed for startup.

It should not contain:

- authored cartridge entities;
- authored locations;
- NPCs;
- item definitions;
- quests;
- scenes;
- dialogue pools;
- localized cartridge prose;
- image/audio/media rows for authored content.

Those belong to cartridge install.

## Runtime Startup

```text
open data directory
if no database:
  create engine baseline
if no installed cartridge:
  open Worlds & Heroes / install default cartridge
if user chooses hero + cartridge:
  preview playthrough
  launch or new game
```

FEAT-ENGINE-BASELINE-3 (2026-05-17) cut `runMigrations()` over to this
flow. The runner now branches on the `schema_migrations` shape:

- **Fresh DB** (no rows) → apply
  `packages/web-server/baseline/0001_engine_baseline.sql`. The baseline
  itself records `baseline-0001-engine` in `schema_migrations`.
- **Baseline-bootstrapped DB** (`baseline-0001-engine` already present)
  → apply only post-baseline deltas (top-level
  `packages/web-server/migrations/*.sql` files not listed in
  `PREBASELINE_MANIFEST.txt`).
- **Legacy dev DB** (historical migration names present, no baseline
  row) → log a clear compatibility warning and apply only the
  post-baseline deltas; the historical chain is treated as already
  applied because the DB already holds the equivalent schema.

The 128 historical migrations now live under
`packages/web-server/migrations/archive-prebaseline/`. They stay on
disk for two reasons: migration invariant tests under
`packages/web-server/src/__tests__/migrations/` still replay the
chain via `withPristineDb()` to exercise per-migration body behaviour,
and the prebaseline manifest reads from the same directory.

## Content Startup

```text
Obsidian vault
  -> compile to Cartridge Forge project
  -> validate
  -> preview diff
  -> apply cartridge
  -> mark install cache ready
```

Starting a new game with an installed cartridge must not call the Obsidian
compiler, import preview, or cartridge apply path. It only creates or resets
playthrough state.

## Migration Policy Before Release

Before Greenhaven ships to players:

- regenerate the engine baseline when schema changes;
- archive historical development migrations;
- do not preserve compatibility migrations for unreleased local databases;
- keep deterministic tests proving the baseline and cartridge install path.

After release, schema migrations may return for engine-only changes. Authored
world changes should still ship as cartridge versions/reimports, not engine
migrations.

## Table Ownership

### Engine-Owned

Examples:

- `entities` table shape;
- `players`;
- sessions/chat;
- runtime fields;
- quests tables;
- inventory tables;
- memory/status/relationship tables;
- cartridge registry tables;
- playthrough tables;
- telemetry/logging/audit tables.

### Cartridge-Owned Static Content

Examples:

- world locations;
- NPC definitions;
- item definitions;
- scene definitions;
- quest definitions;
- default state declarations;
- cartridge-scoped metadata;
- source records;
- asset manifests.

### Playthrough-Owned Runtime Content

Examples:

- current location;
- current scene;
- visited/opened/closed location state;
- moved/dead/missing actors;
- player inventory;
- player quest progress;
- NPC/player memories;
- relationship strings;
- dynamic spawned entities;
- session transcript and notices.

## Migration Cutover Inventory

The per-file classification of every existing
`packages/web-server/migrations/*.sql` (engine_schema /
engine_system_seed / cartridge_world_content / dev_repair_audit /
obsolete_compatibility) and the cutover action for each lives in
[`engine-baseline-migration-inventory.md`](engine-baseline-migration-inventory.md).
That document is the input for the next subpass (build the clean
baseline SQL) and is enforced by
`packages/web-server/src/__tests__/scripts/engineBaselineMigrationInventory.test.ts`.

## Baseline Artifact

FEAT-ENGINE-BASELINE-2 (2026-05-17) added the first real baseline at
`packages/web-server/baseline/0001_engine_baseline.sql`. It is generated
by `packages/web-server/src/scripts/build-engine-baseline.ts`, which:

- reads
  [`engine-baseline-migration-inventory.md`](engine-baseline-migration-inventory.md);
- concatenates every `engine_schema` + `engine_system_seed` migration in
  inventory order;
- applies targeted elisions to seven mixed migrations (0010, 0018, 0029,
  0032, 0033, 0104, 0107, 0125) so authored quickgrin content + the
  grinhaven-full density-rebuild call do not land;
- records the baseline version
  (`schema_migrations.name = 'baseline-0001-engine'`).

Regenerate via:

```powershell
npm --prefix packages/web-server exec -- tsx `
  packages/web-server/src/scripts/build-engine-baseline.ts
```

FEAT-ENGINE-BASELINE-3 (2026-05-17) wired `runMigrations()` to this
artifact: a fresh PGlite now applies the baseline once and records
`baseline-0001-engine` in `schema_migrations`. FEAT-ENGINE-BASELINE-4
(2026-05-17) added `cartridge:default:build` +
`cartridge:default:install-smoke` which compile the Obsidian vault via
`compile_vault_to_forge.py`, validate the generated Forge project, and
prove install through the FEAT-CART-LIB preview/apply pipeline. The
historical migration chain is no longer the source-of-truth for the
default world.

## Cartridge Asset Contract (FEAT-ENGINE-BASELINE-5)

Cartridge apply persists a per-cartridge visual-asset manifest into
`cartridge_meta_scoped.forge_visual_assets` (schema
`greenhaven.cartridge_assets.v1`). Source files referenced by the
Forge project's `audit/visual-assets.jsonl` are content-hashed and
copied into a deterministic per-cartridge cache:

```
<data-dir>/cartridges/<cartridge-id>/assets/<sha256>.<ext>
```

Image bytes are never stored in DB rows. On reimport the scoped meta
row is replaced (ON CONFLICT), so removed assets do not leave stale
DB references; cache files are content-addressed so a retried apply
reuses bytes without re-copying.

Runtime serving:

- `GET /api/assets/cartridges/:cartridgeId/world/:kind/:slug/:role?`
  resolves `(kind, slug, role?)` against the cartridge's scoped
  manifest and streams from the installed cache. Returns 404 when
  the cartridge has no scoped manifest yet.
- `GET /api/assets/world/:kind/:slug/:role?` is the legacy
  default-cartridge surface. It prefers the scoped cache when the
  active default cartridge has a manifest, then falls back to the
  OWV-17 vault bridge so dev/test paths without an installed
  cartridge keep working.

Both surfaces enforce the OWV-17 hardening: ASCII-slug path
guards, file-extension allowlist, cache-root containment check,
`x-content-type-options: nosniff` on every response, and a strict
SVG CSP (`default-src 'none'; img-src 'self' data:; style-src
'unsafe-inline'; sandbox`) when streaming `image/svg+xml`.

The scoped manifest is **authoritative across reimports**:

- An apply (or reimport) writes the scoped row even when
  `counts.total === 0` — a Forge project that drops every asset (or
  ships no `audit/visual-assets.jsonl`) replaces the previous
  non-empty manifest with an empty v1 row so the runtime route
  stops resolving the removed entries.
- When the active default cartridge has a scoped manifest, the
  default `/api/assets/world/...` route consults only that
  manifest. An `unknown_entry` against the scoped manifest returns
  `404 unknown_asset` directly — it does NOT fall back to the
  OWV-17 vault bridge, so a stale vault file cannot be served for
  an asset a reimport removed. The vault-bridge fallback applies
  only when no scoped manifest row exists at all (legacy/dev paths
  without an installed cartridge).

## First-Run / New-Game Contract (FEAT-ENGINE-BASELINE-6)

FEAT-ENGINE-BASELINE-6 (2026-05-17) makes first-run + per-hero New
Game flow through the clean baseline → installed cartridge →
hero/playthrough contract instead of legacy global metadata + global
world reset:

- **Cartridge apply persists the launch anchor.**
  `CartridgeImportApplyService.apply()` now reads the Forge manifest's
  `starting_location_slug` and resolves it to an entity id via
  `cartridge_records` inside the apply transaction. Both
  `starting_location_slug` and `starting_location_id` land in
  `cartridge_meta_scoped` for any cartridge whose manifest declares a
  starting location — not only the `cartridge:default:install-smoke`
  script.
  - A reimport that **fails to resolve** the slug (typo / removed
    record) keeps the declared slug row but deletes any stale scoped
    `starting_location_id` row + emits
    `gameplay:cartridge.starting_location_unresolved` telemetry, so
    `CartridgePlaythroughService.preview` returns
    `no_starting_location` rather than launching against a wrong
    entity.
  - A reimport that **removes** `starting_location_slug` from the
    manifest entirely (FEAT-ENGINE-BASELINE-6 corrective, 2026-05-17)
    deletes BOTH scoped rows
    (`starting_location_slug` + `starting_location_id`) so a stale
    launch anchor cannot survive a cartridge that no longer declares
    one. Same `no_starting_location` repair gate engages.

- **Hero creation is cartridge-independent.** `createAnonymousPlayer`
  no longer requires global `cartridge_meta.starting_location_id` /
  `default_class_id` / `currency_item_id`. On a clean baseline (no
  cartridge installed yet) a hero is minted with null
  `current_location_id` + null `class_id` + no starting currency
  purse; playthrough launch / new-game assigns the cartridge-scoped
  starting location when the player picks a hero+cartridge pair in
  Worlds & Heroes. Legacy seeded-default behaviour is preserved when
  those keys exist.

- **First-run library status API.**
  `GET /api/cartridges/library/status` returns `cartridgeCount`,
  `readyCartridgeCount`, `heroCount`, and
  `defaultForgeProject.{path, available}`. In dev it falls back to
  `DEFAULT_GENERATED` from `scripts/cartridge-default-build.ts`; in
  packaged desktop it points at the copied data-folder default
  cartridge via `GREENHAVEN_DEFAULT_FORGE_PROJECT`. It is read-only
  and requires no auth, so the GUI calls it BEFORE any player
  bootstrap to decide whether to enter gameplay or route into Worlds
  & Heroes.

- **Boot menu no longer reads player profile.** `BootGate` fetches
  library status once and routes to Worlds & Heroes when
  `readyCartridgeCount === 0` or `heroCount === 0`. `MainMenu` reads
  Continue affordance from library status (`heroCount > 0 &&
  readyCartridgeCount > 0`) instead of calling `GetCurrentPlayerId()`
  / `GetPlayerProfile()`. The legacy global "New game" button that
  called `ResetGame()` / `/api/player/reset-local-game` is removed
  from the boot menu — per-hero New Game now lives entirely in
  Worlds & Heroes and goes through `/api/playthroughs/new-game`
  (which only resets the selected (player_id, cartridge_id)
  playthrough state, preserving installed cartridge content + other
  heroes' playthrough rows).
- **In-game settings no longer expose global New Game.**
  FEAT-ENGINE-BASELINE-6 corrective (2026-05-17) — the
  `SettingsModal` `New game` row that posted to
  `/api/player/reset-local-game` is removed, along with the dead
  `useResetGame` hook + `resetting` UI state in `App.tsx` /
  `GameScreen.tsx`. The only player-facing New Game surface is now
  the Worlds & Heroes per-hero / per-cartridge button.

- **Packaged default-world bootstrap.** The desktop asset-prep step
  compiles the visible Obsidian source folder
  `GreenhavenWorld/GreenhavenNoir` into a Forge project whose target
  cartridge id is `greenhaven-world`, then precompiles a ready
  local data template from it. Packaged assets contain:
  `web-server/default-cartridge/source/GreenHavenWorld`,
  `WORLD_MANIFEST.md`, and only
  `.greenhaven-agent-manual/generated/cartridge-forge-project`, plus
  `web-server/default-cartridge/data-template/{pgdata,cartridges}`.
  It deliberately does not copy local agent state, backups, old
  references, or `.greenhaven-agent-manual/local`.

  On desktop startup, Electron copies that curated source into the
  selected data root at
  `<data>/cartridges/default-greenhaven/source`, sets
  `GREENHAVEN_DEFAULT_FORGE_PROJECT` to the copied Forge project, and
  prepends the copied source root to `GREENHAVEN_VAULT_ROOTS` so
  authored assets resolve from the data folder. If `<data>/pgdata` is
  empty, Electron also copies the precompiled `data-template/pgdata`
  and cartridge asset cache into the selected data root before the
  backend opens PGlite. The template DB stores build-source fields as
  portable `greenhaven://default-cartridge/...` URIs; startup rewrites
  those fields to the current machine's copied data-folder source path
  before the GUI reads library status. A later start reuses that ready
  DB/install cache and does not run preview/apply again. The
  `ensureDefaultCartridgeInstalled()` runtime path remains only as a
  fallback when the precompiled template is missing or deliberately
  disabled.

- **One-click default-world import fallback.** When automatic desktop
  bootstrap is disabled or the operator runs a dev build, Worlds &
  Heroes can still surface an "Import default world" button that
  opens the import wizard with the path pre-filled. No hardcoded
  `C:\Greenhaven` reference lives in the frontend; the path comes
  from the library-status API.

The legacy debug endpoint `/api/player/reset-local-game` (and the
`ResetGame()` bridge function) is intentionally preserved for dev
diagnostics — it just no longer appears in the player-facing menu.

### Global `cartridge_meta` Mirror at Launch (FEAT-CART-LIB-6)

FEAT-CART-LIB-6 (2026-05-17) wired
`CartridgePlaythroughService.launch()` and `.newGame()` to mirror the
launched cartridge id (and its scoped `starting_location_id`) into
legacy global `cartridge_meta` keys (`cartridge_id`,
`starting_location_id`). Pre-FEAT-CART-LIB gameplay routes
(`SessionLifecycleService.loadLocationsView` and friends) still read
`getMetaRequired('cartridge_id')` from the global table to decide
which cartridge a turn happens in. On a clean baseline + GUI install,
those keys are empty and any session bootstrap 500s with
`cartridge_meta missing required key: 'cartridge_id'`. The mirror
keeps the global view in sync with whichever `(player, cartridge)`
pair is currently `status='active'`. The scoped table remains
authoritative; the global mirror is the back-compat surface and will
retire once those callers consult `hero_cartridge_states` /
`cartridge_meta_scoped` directly.

### Player-Scoped Session Cartridge Resolution (FEAT-CART-LIB-7)

FEAT-CART-LIB-7 (2026-05-17) moved gameplay session location
resolution off the global `cartridge_meta.cartridge_id` mirror and
onto the per-hero `hero_cartridge_states.status = 'active'` row.

A new helper
`resolveActivePlayerCartridgeId(playerId)` lives next to
`CartridgePlaythroughService` (same module, exported separately so
session readers can import it without pulling the whole service
class). It selects the `cartridge_id` of the hero's most-recently
updated `status='active'` row, then falls back to the legacy
`activeCartridgeId()` only when the player has no active playthrough
(pre-launch first boot, or any non-player caller). The
`syncGlobalCartridgeMeta()` mirror added in FEAT-CART-LIB-6 stays in
place as the fallback path; the difference is that no session reader
trusts it anymore.

`SessionLifecycleService.loadLocationsView()` resolves the context
once per request and threads it through:

- `loadVisibleReachableLocations(currentLocationId, cartridgeId)` —
  optional `cartridgeId` parameter added in `locationGraph.ts`. When
  supplied, both the topology-child sweep and the result-row fetch
  gate on `activeCartridgeEntityPredicate('entities', cartridgeId)`,
  so a hero in cartridge A never sees exits belonging to cartridge
  B even if A's authored `profile.exits` references a B-side id.
- `loadNearbyForLocation(locationId, playerId, cartridgeId)` — the
  per-NPC sweep already accepted a cartridge id through
  `loadPresentPeopleAtLocation`; the direct `activeCartridgeId()`
  call inside `SessionLifecycleService.ts` is gone.
- `loadCityMapNodes(currentLocationId, cartridgeId)` — map nodes are
  now filtered to the active cartridge so multi-cartridge installs
  don't render a sibling cartridge's authored map.

The `location.snapshot` gameplay-channel telemetry payload gains a
`cartridge_id` field so cross-cartridge leakage regressions are
auditable from the gameplay log without having to reproduce them
live.

Regression coverage lives in
`packages/web-server/src/__tests__/services/sessionLocationsCartridgeIsolation.test.ts`.
It seeds two cartridges with overlapping authored exits, density NPC
ids, and map nodes; activates cartridge A for the hero via
`hero_cartridge_states`; then deliberately points the global
`cartridge_meta.cartridge_id` mirror at cartridge B before calling
`loadLocationsView`. The view returns only cartridge A's exits,
nearby NPCs, and map nodes — proof that the player-scoped resolver
overrides the global mirror.

### Cartridge-Scoped Movement + Current Location (FEAT-CART-LIB-8)

FEAT-CART-LIB-8 (2026-05-17) closed the residual gap from
FEAT-CART-LIB-7: `players.current_location_id` was still trusted
as-is by `loadLocationsView` (so a foreign id could surface as the
current bubble), and `move_player` updated only the player row (so
`hero_cartridge_states.current_location_id` would silently go stale
across cartridge switches).

The resolver in `CartridgePlaythroughService.ts` grew two new
exported helpers next to `resolveActivePlayerCartridgeId`:

- `resolveActivePlayerCartridgeContext(playerId)` returns
  `{cartridgeId, playthroughLocationId, playthroughSceneId,
  hasActivePlaythrough}`. The `hasActivePlaythrough` flag is `true`
  only when the hero has an `active` row in `hero_cartridge_states`
  — callers that need to refuse the legacy global-mirror fallback
  (e.g. the `move_player` sync write) gate on this.
- `entityBelongsToCartridge(entityId, cartridgeId)` runs the same
  `cartridge_id = $param OR dynamic_origin = true OR kind = 'player'`
  predicate `activeCartridgeEntityPredicate` emits, returning
  `false` when the entity does not exist or is foreign.
- `resolveScopedStartingLocationId(cartridgeId)` exposes the scoped
  meta's `starting_location_id` so the session view has a final
  recovery anchor when neither `players.current_location_id` nor the
  active playthrough row points at a same-cartridge place.

`SessionLifecycleService.loadLocationsView()` now resolves the full
context once, then runs `pickCurrentLocationId()` to choose the
location id used for the current bubble + every downstream sweep:

1. `players.current_location_id` if it passes
   `entityBelongsToCartridge`.
2. Otherwise the active playthrough's `current_location_id`.
3. Otherwise the cartridge's scoped `starting_location_id`.
4. Otherwise `null` → empty view (no foreign name leak).

The `location.snapshot` telemetry payload now carries
`player_current_location_id` and a
`foreign_current_location_recovered` boolean so a regression that
re-introduces stale-row leakage is visible in the gameplay log
without rerunning the live smoke.

`move_player` (`packages/web-server/src/tools/movement.ts`) gained
two gates:

1. **Cross-cartridge target rejection.** Before opening the
   `withTransaction`, the tool calls
   `resolveActivePlayerCartridgeContext(playerId)` +
   `entityBelongsToCartridge(target_location_id, cartridgeId)` and
   throws when the target is foreign. The cartridge gate is
   evaluated before reachability so an authored
   `profile.exits` value naming a foreign id is rejected even if it
   would otherwise have been "reachable".
2. **Foreign current-location reachability fence.** Inside the
   transaction, if the read `players.current_location_id` itself is
   foreign, the local `safeFromId` is forced to `null` before the
   reachability sweep, preventing the alien location's
   `profile.exits` / topology edges from authorizing the move.

On a successful, same-cartridge move, the transaction now
additionally runs:

```sql
UPDATE hero_cartridge_states
   SET current_location_id = $new,
       current_scene_id    = NULL,
       updated_at          = now()
 WHERE player_id = $player
   AND cartridge_id = $cartridge
   AND status = 'active'
```

so the playthrough state is committed atomically with the
`players` UPDATE. The scene anchor resets on movement; a fresh
scene anchor will be set by the next narrate that opens one.

Regression coverage lives in
`packages/web-server/src/__tests__/tools/movePlayerCartridgeIsolation.test.ts`:
foreign target rejected pre-write (no `players` / no
`hero_cartridge_states` mutation), same-cartridge move syncs both
rows (location updated, scene reset to NULL, status remains
`active`), and `loadLocationsView` recovers via the active
playthrough when `players.current_location_id` and the global meta
mirror both point at a foreign cartridge.

`syncGlobalCartridgeMeta()` from FEAT-CART-LIB-6 stays untouched as
the fallback for non-player callers. No migrations were added.

### Movement Anchor Recovery (FEAT-CART-LIB-9)

FEAT-CART-LIB-9 (2026-05-17) closed a residual gap inside the
FEAT-CART-LIB-8 movement gate. When `players.current_location_id`
held a foreign id, `move_player` set the local `safeFromId` to
`null` before reachability validation — but
`validateMovementReachability(null, …)` returns `{ok: true}`
unconditionally (it is the legitimate first-spawn / specialist-seed
shortcut). The combination meant a stale foreign row could let the
hero "move" to any same-cartridge target without an authored exit
graph authorizing the hop, and the emitted `player:moved` /
`dialogue:partner_switched` events still carried the foreign
location id and name.

The fix centralizes the priority chain that `loadLocationsView`
already used and applies it on the write side. The previous local
`pickCurrentLocationId` helper inside `SessionLifecycleService.ts`
is now a thin delegate to a new exported helper:

```
pickActiveCartridgeLocationAnchor({
  cartridgeId,
  playerCurrentLocationId,
  playthroughCurrentLocationId,
}) → {locationId, source, recoveredFromForeign}
```

declared next to `entityBelongsToCartridge` /
`resolveScopedStartingLocationId` in
`packages/web-server/src/services/CartridgePlaythroughService.ts`.
The `source` field reports which branch supplied the id
(`'player_row' | 'playthrough' | 'scoped_start' | null`); the
`recoveredFromForeign` flag is true when the player row carried a
non-null id that failed the cartridge predicate and a later branch
fired.

`move_player` now calls the helper from inside the
`withTransaction` block (the player row is already locked via
`SELECT … FOR UPDATE`), then:

- **Active playthrough + recovered anchor:** uses the recovered
  id as `fromId`, reads its display name as `fromName`,
  validates reachability from it, and surfaces the same recovered
  id/name in the return value, `player:moved` SSE payload,
  `dialogue:partner_switched` envelope, telemetry, and the
  `recordLocationVisit({previousLocationId})` argument. The
  foreign player-row id is never leaked.
- **Active playthrough + no anchor:** rejects deterministically
  with `move_player rejected: no valid same-cartridge anchor for
  player <id> in cartridge <cartridge> …` rather than falling
  through to the null-anchor reachability bypass.
- **No active playthrough (legacy / first-spawn callers):** keeps
  the previous null-anchor behavior. FEAT-CART-LIB-8's
  cross-cartridge target gate still rejects foreign targets, so
  this path is only reached on callers that have no
  `hero_cartridge_states.active` row yet.

Regression coverage in
`packages/web-server/src/__tests__/tools/movePlayerCartridgeIsolation.test.ts`
adds two FEAT-CART-LIB-9 cases on top of the existing three
FEAT-CART-LIB-8 cases:

- **Unreachable target via recovered anchor:** player row points
  at cartridge B, active playthrough anchored at A-Spawn,
  attempted target is A-Unreachable (same cartridge, no authored
  exit). Move rejects with a reachability error that mentions
  the target id but never the foreign cartridge B id.
- **Reachable target via recovered anchor:** same setup but the
  attempted target is A-Side, authored as an exit of A-Spawn.
  Move succeeds; both `players.current_location_id` and the
  active `hero_cartridge_states` row commit at A-Side; the
  returned `fromId/fromName` reflect A-Spawn (not the foreign B
  row).

No migrations were added. `syncGlobalCartridgeMeta()` from
FEAT-CART-LIB-6 remains as the fallback path for non-player
callers.

### Hero Continuity Preview (FEAT-HERO-CONTINUITY-1)

FEAT-HERO-CONTINUITY-1 (2026-05-17) adds the first read-only piece of
the hero-continuity stack: a `HeroContinuityService` that classifies
hero state against a target cartridge and produces a player-facing
`ContinuityPreview` packet. The service does **not** mutate any rows.

The taxonomy follows
`docs/specs/hero-continuity-parallel-universes.md`:

- `hero_core` — carries by default. Sources:
  `players.current_xp`, `players.current_level`, `player_stats`,
  `player_proficient_skills`, `player_skills`, `player_titles`,
  `player_progression_tracks`, and `player_progression_wallets`.
- `universe_local` — stays in the source world. Counted sources:
  `player_inventory`, `player_quests`, `player_journal_entries`,
  `npc_memories(owner_entity_id = playerId)`,
  `gui_events(event_type = 'string:changed')` for relationship
  signal, and `players.metadata.companions[]`.
- `portable_artifact` / `portable_companion` — not yet emitted; the
  durable ledger lands in FEAT-HERO-CONTINUITY-3.
- `cartridge_static` / `derived_projection` — never carried by the
  hero; the install pipeline and per-turn projections own them.

The cartridge-side opt-in lives at
`cartridge_meta_scoped.key = 'hero_continuity_policy'`. When absent,
the service falls back to the documented default policy: level and
titles visible; inventory, quests, and relationships local-only;
memories `summary_only`; companions `local_only`. The raw policy is
preserved on the preview so future passes can read fields that this
version of the service does not understand yet.

`CartridgePlaythroughService.preview()` now calls the helper as an
additive read after the existing mode/blockers logic and surfaces the
result as `continuityPreview` on the returned DTO (and through the
`POST /api/playthroughs/preview` response unchanged). The helper is
guarded with `try/catch + console.warn` so any future fault inside the
continuity helper degrades to `continuityPreview: null` without
breaking the BootGate flow Worlds & Heroes depends on. Launch and
new-game are unchanged.

Companion classification in this pass is informational only — every
NPC id in `players.metadata.companions[]` is emitted as
`status: 'native_local'` with `reason: 'no_bond_contract'`, because
`hero_companion_bonds` does not exist yet. Raw NPC memory text,
private relationship text, local quest state, and local inventory
contents are never copied into the preview; the `staysInSourceWorld`
section carries only counts plus a stable summary code that the GUI
localizes.

Audit shape (`preview.audit`):

- `readsFrom` — explicit list of every SQL table the service touches
  (`players`, `entities`, `player_stats`,
  `player_proficient_skills`, `player_skills`, `player_titles`,
  `player_progression_tracks`, `player_progression_wallets`,
  `player_inventory`, `player_quests`, `player_journal_entries`,
  `npc_memories`, `gui_events`, `cartridge_meta_scoped`).
- `mutatesRows: false` — invariant the regression test asserts.

Regression coverage at
`packages/web-server/src/__tests__/services/heroContinuityService.test.ts`
covers: unknown-player / unknown-cartridge rejects, default policy on
empty scoped meta, custom policy parsed (including the
`companions: 'portable_contracts'` carry hint), `universe_local` count
warnings (companions roster, journal entries, etc.), and an
end-to-end no-mutation check (`current_xp` unchanged,
`hero_cartridge_states` still empty after the preview).
`cartridgePlaythroughService.test.ts` gained one assertion that the
additive `continuityPreview` field flows through preview with the
expected default-policy shape.
`cartridgePlaythroughRoutes.test.ts` gained a mock + assertion that
`POST /api/playthroughs/preview` passes the new field through
verbatim.

Backend-only. No migrations were added by FEAT-HERO-CONTINUITY-1; the
`universe_instances` backbone lands in
[Universe Instances (FEAT-HERO-CONTINUITY-2)](#universe-instances-feat-hero-continuity-2)
below. Companion-bond, portable-artifact, capsule, and projection
tables remain the explicit scope of FEAT-HERO-CONTINUITY-3 / -4.

### Universe Instances (FEAT-HERO-CONTINUITY-2)

FEAT-HERO-CONTINUITY-2 (2026-05-17) adds the universe-instance
backbone the FEAT-HERO-CONTINUITY-1 scope boundary deferred. Each
installed cartridge gets exactly one default `local_single_player`
universe row; every `hero_cartridge_states` playthrough is attached
to that universe. Non-default rows (`local_party`, future network
modes) are allowed but stay outside the default-per-cartridge
contract. Migration `0129_hero_universe_instances.sql` is the first
post-baseline delta after the engine baseline cutover.

Table shape — `universe_instances` (see `migrations/0129_hero_universe_instances.sql`):

- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`.
- `cartridge_id TEXT NOT NULL REFERENCES cartridges(id) ON DELETE
  CASCADE`.
- `content_hash TEXT NOT NULL` mirroring `cartridges.content_hash` at
  ensure-time so a re-applied cartridge can detect drift without
  reading the cartridges table again.
- `title TEXT` (nullable) mirroring `cartridges.title` for display.
- `mode TEXT NOT NULL CHECK (mode IN ('local_single_player',
  'local_party', 'network_shard'))`.
- `owner_player_id BIGINT NULL REFERENCES players(entity_id) ON DELETE
  SET NULL` for future network-shard ownership; null on every default
  row today.
- `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active',
  'paused', 'archived', 'incompatible'))`.
- `is_default BOOLEAN NOT NULL DEFAULT false`.
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb` for future cross-world
  bookkeeping.
- `created_at` / `updated_at` `TIMESTAMPTZ` with `now()` defaults.

Indexes:

- `idx_universe_instances_cartridge` on `(cartridge_id)` for FK
  joins.
- `idx_universe_instances_cartridge_default` partial unique index on
  `(cartridge_id)` `WHERE is_default` so each cartridge has at most
  one default row.

`hero_cartridge_states.universe_instance_id` is a new nullable
`UUID REFERENCES universe_instances(id) ON DELETE CASCADE` column
backfilled to the cartridge's default row by the migration. A
partial unique index
`idx_hero_cartridge_states_player_universe (player_id,
universe_instance_id) WHERE universe_instance_id IS NOT NULL` keeps
the (hero, universe) pair unique without breaking any pre-link rows
(none exist after backfill).

Service contract — `packages/web-server/src/services/UniverseInstanceService.ts`:

- `getDefaultForCartridge(cartridgeId)` returns the row or `null`.
  Read-only.
- `ensureDefaultForCartridge(cartridgeId)` is the idempotent ensure
  path. INSERTs the default row keyed off the cartridge's current
  `title` + `content_hash`; on conflict it does nothing and selects
  back; concurrent callers converge on the same row. Throws on an
  unknown cartridge so no orphan universe is created.

Call sites:

- `CartridgeImportApplyService` invokes `ensureDefaultForCartridge`
  right after the `cartridge_install_cache` row is written. Re-apply
  is a no-op.
- `CartridgePlaythroughService.preview` returns `universeInstanceId:
  string | null` from `getDefaultForCartridge` (read-only; never
  creates a row during preview).
- `CartridgePlaythroughService.launch` and `.newGame` both invoke
  `ensureDefaultForCartridge` before the `hero_cartridge_states`
  INSERT/UPDATE, write the resolved id into the row, and return
  `universeInstanceId: string` in `PlaythroughLaunchResult`.

Continuity preview corrective — `HeroContinuityService.previewTransfer`
now classifies `players.current_location_id` and
`players.current_scene_id` as `universe_local`. The `staysInSourceWorld`
array gains `current_location` and `current_scene` rows reporting
`count` + `nonEmpty` only (no raw payload); a
`current_location_local_only` warning fires whenever the count is
non-zero. Raw scene coordinates, descriptions, or scene state never
leak into the player-facing DTO.

Regression coverage:

- `src/__tests__/migrations/heroUniverseInstances.test.ts` — table
  shape, CHECK rejection on invalid mode, partial unique-default
  contract (second default rejected, second non-default allowed), FK
  cascade from `universe_instances` to `hero_cartridge_states`.
- `src/__tests__/services/universeInstanceService.test.ts` —
  `getDefault` null pre-ensure, `ensureDefault` create with
  cartridge title + content hash, idempotency across repeated calls,
  unknown-cartridge rejection, concurrent ensure convergence on a
  single row.
- `cartridgePlaythroughService.test.ts` — launch test asserts
  `result.universeInstanceId` is a non-empty string and
  `hero_cartridge_states.universe_instance_id` (cast to text) equals
  that id.
- `heroContinuityService.test.ts` — default-policy test asserts
  `current_location` + `current_scene` appear in the
  `universe_local` list; local-state test seeds a real
  `entities(kind='location')` row, points
  `players.current_location_id` at it, and asserts `count === 1` /
  `nonEmpty === true` plus the `current_location_local_only`
  warning.
- `engineBaselineRunMigrations.test.ts` — fresh-baseline
  `result.applied` is now `[BASELINE_VERSION,
  '0129_hero_universe_instances.sql']`. Future post-baseline deltas
  append to this list.

Test-framework note — `setupTurnTestEnvironment` in
`packages/web-server/src/__tests__/turn/framework.ts` now invokes
`runMigrations()` after the prebaseline template is copied so post-
baseline deltas apply to every suite using the framework. The
cleanup helper also drains the telemetry facade and retries
`rm -rf dataDir` on `ENOTEMPTY` / `EBUSY` / `EPERM` to close the
Windows `gameplay-logs/` rmdir race noted under
FEAT-HERO-CONTINUITY-1.

`hero_continuity_events`, `hero_portable_artifacts`,
`hero_companion_bonds`, `companion_universe_projections`, and
`hero_companion_capsules` land in
[Hero Continuity Ledger (FEAT-HERO-CONTINUITY-3)](#hero-continuity-ledger-feat-hero-continuity-3)
below. Launch / new-game carryover policy stays the explicit scope of
FEAT-HERO-CONTINUITY-4.

### Hero Continuity Ledger (FEAT-HERO-CONTINUITY-3)

FEAT-HERO-CONTINUITY-3 (2026-05-17) lands the durable ledger that
backs cross-world hero identity and companion travel without yet
changing launch/new-game carryover behavior. Migration
`0130_hero_continuity_ledger.sql` adds five tables:

- `hero_continuity_events` — append-only audit ledger for cross-world
  events. Indexes on `(player_id, created_at DESC)`,
  `(target_universe_instance_id)`, and `(event_type)`.
- `hero_portable_artifacts` — whitelist of things that travel with
  the hero. Deduped by `UNIQUE (player_id, artifact_key)`. `kind` is
  one of `title | scar | achievement | memory_summary | relic |
  skill_mark`; `portability` is one of `portable | local_locked |
  suppressed | requires_adapter`.
- `hero_companion_bonds` — persistent hero ↔ companion contract.
  Deduped by `UNIQUE (player_id, companion_key)`. `status` ∈ `bonded
  | traveling | world_bound | departed | suppressed`; `portability` ∈
  `portable | local_locked | requires_adapter | suppressed`.
- `companion_universe_projections` — per-universe materialization
  state for a bonded companion. Deduped by `UNIQUE (companion_bond_id,
  universe_instance_id)`. Status ∈ `available | following | waiting |
  suppressed | departed`. `ON DELETE CASCADE` from both
  `hero_companion_bonds` and `universe_instances`.
- `hero_companion_capsules` — versioned snapshots of the companion's
  transferable state. Deduped by `UNIQUE (companion_bond_id,
  capsule_version)`. Append-only `state_hash` lets future networking
  reconcile divergent worlds.

Service contract — `packages/web-server/src/services/HeroContinuityLedgerService.ts`:

- `recordContinuityEvent(input)` appends a typed event row.
- `listHeroUniverseTimeline(playerId, {limit})` returns the newest
  events.
- `upsertPortableArtifact(input)` / `listPortableArtifacts(playerId)`
  manage the artifact ledger.
- `upsertCompanionBond(input)` / `listCompanionBonds(playerId)` manage
  bond rows.
- `listCompanionCarryoverCandidates(playerId)` is a **read-only**
  projection that pairs each `players.metadata.companions[]` roster
  entry with the matching bond (if any). It does NOT mutate the
  metadata roster or the bond table.
- `buildCompanionCapsule(companionBondId)` builds a
  `greenhaven.companion_capsule.v1` payload from canonical state
  owned by the contracted companion entity: identity fields,
  `npc_stats`, `actor_statuses` keyed on the companion, the
  companion's `runtime_fields` / `runtime_values`,
  `inventory_entries` whose holder is the companion, companion-owned
  `npc_memories`, and the relationship-string value the companion
  holds *toward* the hero. The capsule includes counts only for
  memories that are NOT about the hero so unrelated world prose
  does not leak. The capsule version increments per bond.
  Runtime fields pass through unchanged **except** the
  `field_key='strings'` JSON map: it is reduced to the hero entry
  only by `sanitizeCapsuleRuntimeField()` so foreign source-world
  NPC ids and the relationship values the companion holds toward
  them never leak through `payload.runtimeFields`. The canonical
  hero string still rides on `payload.stringTowardHero` as the
  single source of truth.

Preview surface — `HeroContinuityService.previewTransfer` gains two
additive fields:

- `portableArtifacts: ContinuityPortableArtifactSummary[]` — mirrors
  the artifact ledger minus timestamps. Empty until
  FEAT-HERO-CONTINUITY-4 launch carryover (or future explicit
  awards) starts writing rows.
- `companionCandidates: ContinuityCompanionCandidate[]` — merges the
  live `players.metadata.companions[]` roster with persistent
  `hero_companion_bonds` rows. Each candidate carries `hasBond` and
  `companionKey` so the GUI can render bonded vs roster-only entries
  distinctly. Roster entries without a bond stay `native_local` to
  match the FEAT-HERO-CONTINUITY-1 contract; bonded entries surface
  `portable_companion` / `world_bound` / `requires_adapter` /
  `suppressed` derived from `(status, portability)`.

`previewTransfer` continues to be **read-only** —
`audit.mutatesRows === false` still holds; it just gains
`hero_portable_artifacts` and `hero_companion_bonds` in the
`readsFrom` list.

Character State surface — `CharacterStateService.snapshot()` returns
an additive `continuity` section with `schemaVersion:
'greenhaven.character_state_continuity.v1'` containing:

- `portableArtifacts` — same shape as the preview summary.
- `travelingCompanions` — bonds where `portability === 'portable'`
  and `status !== 'suppressed'`.
- `worldBoundCompanions` — every other bond, including
  `world_bound`, `local_locked`, `requires_adapter`, `departed`, and
  suppressed entries. UI renders them as story/history, not as
  active in-world equipment.

Launch / new-game carryover (`CartridgePlaythroughService.launch`,
`.newGame`) is the explicit owner of writing artifacts/bonds/events
on launch and materializing companion projections in the target
world; that backbone lands in
[Hero Continuity Carryover (FEAT-HERO-CONTINUITY-4)](#hero-continuity-carryover-feat-hero-continuity-4)
below.

### Hero Continuity Carryover (FEAT-HERO-CONTINUITY-4)

FEAT-HERO-CONTINUITY-4 (2026-05-17) makes the
[continuity ledger](#hero-continuity-ledger-feat-hero-continuity-3)
do real runtime work on every playthrough launch and new-game.
The mutating service lives at
`packages/web-server/src/services/HeroContinuityCarryoverService.ts`
and runs inside the existing `CartridgePlaythroughService` transaction
(no nested `withTransaction()` — `query()` routes through the active
tx automatically).

What `applyLaunchCarryover()` does, in order:

1. **Snapshot the departing world's roster** —
   `players.metadata.companions[]` is copied into the SOURCE
   `hero_cartridge_states.world_snapshot.companions` so a future
   return restores the local-world cast. The playthrough service
   has already flipped the source row to `'available'` immediately
   before calling carryover. No-op on a fresh hero / re-launch into
   the same world.
2. **Read target policy** from
   `cartridge_meta_scoped.hero_continuity_policy.carry.companions`.
   `'portable_contracts'` (or
   `{portable_contracts: 'allow'}`) is required for a bond to travel.
3. **Restore target locals on continue.** `launch_continue` reads
   `hero_cartridge_states(target).world_snapshot.companions[]` and
   keeps only ids that pass the target cartridge scope
   (`entities.cartridge_id = target OR dynamic_origin = true`).
   `launch_first_spawn` and `new_game` start with an empty roster.
4. **Classify every bond.** Verdicts: `traveling` (portable +
   non-suppressed bond, target policy allows portable contracts);
   `world_bound` (`bond.status='world_bound'` or
   `portability='local_locked'`); `requires_adapter`; `suppressed`
   (any suppressed flag or policy that disallows portable
   contracts); `no_contract`.
5. **For accepted bonds** the carryover rebuilds the latest capsule
   via `HeroContinuityLedgerService.buildCompanionCapsule()`, then
   ensures a target-world projection entity via
   `entities(kind='person', dynamic_origin=true,
   cartridge_id=target)`. Identity (`display_name`,
   `persona_slug`, `summary`, `i18n`) is copied from the capsule.
   `profile` is intentionally NOT copied in this pass —
   source-world profile keys can carry source-cartridge ids that
   mean nothing in the target; the deferral is tracked in
   `arrival_payload.deferred_slices`.
6. **Safe capsule slices applied to the projection:**
   `npc_stats(npc_entity_id=projection)`,
   `runtime_fields(field_key='strings')` set to the hero-only
   sanitized map, and companion-owned `npc_memories(about_entity_id
   = heroId)` rows. Inventory and source-world general statuses are
   counted in `arrival_payload.slice_counts` but NOT copied.
7. **`companion_universe_projections`** upserted with
   `status='following'`, `projection_entity_id=…`, and the structured
   `arrival_payload` (schema `greenhaven.companion_arrival.v1`).
8. **`actor_statuses(player_id, projection_entity_id,
   status_kind='companion', status_value='following')`** written so
   presence enrichment / dialogue participants / location presence
   readers all see the traveling companion next to the hero from
   turn 1.
9. **New live roster** written to `players.metadata.companions[]` —
   restored target-world locals (continue) plus accepted projection
   ids, de-duped. Source-world entity ids never appear unless they
   are also valid in the target cartridge.
10. **`hero_continuity_events`** appended with
    `event_type='continuity:launch'` (or `'continuity:new_game'`) and
    a structured payload containing the schema version, mode,
    playthrough id, reset generation, every companion outcome with
    its reason code, every portable artifact verdict, the
    departing roster, and the live roster after carryover.

`CartridgePlaythroughService.{launch,newGame}` return an additive
`continuityCarryover: ContinuityCarryoverSummary | null` field. The
web-ui bridge (`packages/web-ui/src/bridge/playthrough.ts`) exposes
the same shape as optional fields so current Worlds & Heroes callers
keep working.

**Per-launch artifact verdicts.** The portable-artifact ledger
itself is read-only here; carryover classifies each row as
`carried` (portability `'portable'`) or `suppressed` with a reason
code so the GUI can render "Carries with hero" / "Suppressed by
this world" without mutating ledger rows. Per-cartridge artifact
whitelists (`carry.portable_artifacts`) remain future work.

**Applied capsule slices (FEAT-HERO-CONTINUITY-4-FOLLOWUP).** Every
accepted projection now receives the full safe slice set, with
applied/suppressed counts surfaced in
`companion_universe_projections.arrival_payload.slice_counts` (schema
`greenhaven.companion_arrival.v2`):

- `profile` JSON — sanitized through `sanitizeProfileForProjection`:
  trait/voice/oath/mood/personality keys carry, while the
  PROFILE_DENY_KEYS set (`home_id`, `location_id`,
  `current_location_id`, `scene_id`, `exits`, `participant_entity_ids`,
  `dialogue_partner_id`, `target_*_id`, `entity_id`, `npc_id`,
  `quest_*_id`, `source_id`, `source_entity_id`,
  `source_location_id`, `depart_when`, `companion_of`) plus any
  `*_ids?` / `companions` / `participants` / `locations?` /
  `scenes?` / `quests?` named keys are dropped.
- `runtime_fields` — non-`strings` fields copy with their
  `value_type` preserved, except `entity_ref` fields which would
  carry source-world ids (counted as `suppressedRuntimeFields`).
  The `strings` field is always reset to the hero-only sanitized
  map.
- `inventory` — companion-owned `inventory_entries` are remapped
  via `cartridge_records(cartridge_id=target, kind='item', slug)`
  or `entities.profile->>'source_slug'` matches in the target
  cartridge. Unresolved items are counted as
  `suppressedInventory` and dropped (no projection write).
- `general_statuses` — non-`companion` `actor_statuses` rows copy
  with sanitized metadata (entity-id-shaped keys dropped). The
  `companion='following'` status is always authored fresh by
  `writeFollowingStatus()`.

The arrival payload's `slice_counts` carries six numeric fields the
GUI can render: `stats`, `aboutHeroMemories`, `appliedRuntimeFields`
+ `suppressedRuntimeFields`, `appliedInventory` +
`suppressedInventory`, `appliedStatuses` + `suppressedStatuses`.

**State isolation invariants.** Carryover guarantees that:

- A departing world's `world_snapshot.companions` is always
  rewritten (even when the live roster is empty) so a stale prior
  snapshot can never re-hydrate later.
- Re-launching the same already-active world preserves the live
  roster instead of overwriting it from a potentially-stale target
  snapshot. The playthrough service threads
  `targetAlreadyActive: existing?.status === 'active'` so carryover
  can detect this case.
- `launch_continue` restores roster ids only when they survive a
  strict filter: either `entities.cartridge_id = target` OR they are
  the `projection_entity_id` of a row in
  `companion_universe_projections` for the **exact**
  target_universe_instance_id. A foreign `dynamic_origin = true`
  source-world person is rejected.
- Companion projection reuse is keyed on
  `(companion_bond_id, universe_instance_id)`, not on
  `(bond, cartridge)`. Two universes that share a cartridge (e.g.
  future `local_party` + `local_single_player`) each get their own
  projection entity.

**What carryover never touches.** Player inventory, quest progress,
player-owned `npc_memories`, current scene, the hero's relationship
strings toward other NPCs, map state, and ordinary NPCs are
deliberately left in their source world. The cartridge import/apply
pipeline and the read-only `HeroContinuityService.previewTransfer()`
are unchanged.

## Stable Baseline → Cartridge Smoke (FEAT-ENGINE-BASELINE-7)

FEAT-ENGINE-BASELINE-7 (2026-05-17) wired a repeatable repository
command that exercises the full clean-engine → Obsidian-vault →
cartridge install → hero launch → per-hero new game chain against a
temp PGlite, without booting an HTTP listener or touching the live
`pgdata` directory. The smoke drives the same `cartridge-library`
Hono routes the boot-phase GUI calls, so contract drift surfaces
here.

```powershell
npm --prefix packages/web-server run live:engine-baseline-cartridge
```

The script
(`packages/web-server/src/scripts/engine-baseline-cartridge-smoke.ts`):

- Boots a temp PGlite + runs `runMigrations()`; asserts
  `mode === 'fresh-baseline'`.
- Confirms every authored-content table (`entities`, `cartridges`,
  `cartridge_records`, `cartridge_meta_scoped`,
  `cartridge_install_cache`, `cartridge_import_runs`) is empty before
  any cartridge install.
- Generates a tiny Obsidian vault under
  `<tmp>/.../engine-baseline-smoke-vault-XXXX/` with
  `WORLD_MANIFEST.md` (start block linking to `[[SmokeLandingMind]]`)
  and `GreenHavenWorld/Locations/@Smoke Landing/SmokeLandingMind.md`.
- POSTs `/api/cartridges/import/jobs` with
  `sourceKind: 'obsidian_vault'` so the real
  `compile_vault_to_forge.py` runs against the fixture vault, then
  polls until `ready`.
- Applies via `POST /api/cartridges/import/jobs/:jobId/apply`
  (`acceptWarnings: true`).
- Asserts post-apply state: `cartridges` row exists, `cartridge_records`
  populated, `cartridge_install_cache.state === 'ready'`, and
  `cartridge_meta_scoped` carries both `starting_location_slug` +
  resolved `starting_location_id` (FEAT-ENGINE-BASELINE-6 contract).
- Creates a hero via `POST /api/heroes`.
- Drives `POST /api/playthroughs/preview` → `mode !== 'repair_required'`,
  then `POST /api/playthroughs/launch` and snapshots the playthrough
  result.
- Snapshots
  `cartridge_import_preview_jobs` + `cartridge_import_runs` +
  `entities` + `cartridge_records` BEFORE the new-game step.
- Calls `POST /api/playthroughs/new-game`, asserts the returned
  `playthroughId` differs from launch and `resetGeneration` bumps by 1.
- Re-snapshots the same tables and asserts NO new import preview job
  / import run / entity / record was created across new-game — the
  install cache is reused without a reimport.
- Writes
  `.codex/run-logs/live-playtest/engine-baseline-cartridge-smoke/result.json`
  with pre/post counts, cartridge id, content hash, scoped start
  rows, hero ids, launch + new-game modes, reset generation, and the
  pre/post new-game count snapshots. Exits non-zero on any blocker.

Clean engine contract preserved: no archived migration replay, no
raw vault SQL, no `obsidian-dev-apply`. The smoke runs the
transformer once per pass; the generated Forge project for the
fixture vault is temp-only and deleted alongside the temp PGlite
unless `--keep-temp` is set.

## Default Cartridge Build + Install

FEAT-ENGINE-BASELINE-4 (2026-05-17) added two npm scripts that compile
and install the default Greenhaven cartridge from the human vault
through the FEAT-CART-LIB pipeline, without touching archived
migration SQL:

```powershell
npm --prefix packages/web-server run cartridge:default:build
npm --prefix packages/web-server run cartridge:default:install-smoke
```

`cartridge:default:build` runs
`GreenhavenWorld/.greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/compile_vault_to_forge.py`
then `@greenhaven/cartridge-forge validate` against the generated
project. `cartridge:default:install-smoke` boots a temp PGlite via
`runMigrations()` (must report `mode === 'fresh-baseline'`), asserts
every cartridge-content table is pre-install empty, drives
`CartridgeImportPreviewService` + `CartridgeImportApplyService` against
the generated Forge project, and persists
`starting_location_slug` + `starting_location_id` (resolved from
`forge.project.json`) into `cartridge_meta_scoped` so a later
playthrough launch has a real anchor. Both scripts write a
`result.json` under `.codex/run-logs/` for audit.

## Baseline Test Contract

`packages/web-server/src/__tests__/migrations/engineBaseline.test.ts`
applies the baseline directly to a fresh PGlite (vector extension
enabled, `schema_migrations` bookkeeping pre-created) and asserts:

- the baseline records its bookkeeping row;
- every engine table from the post-0128 surface exists;
- cartridge-content tables (entities, players, cartridges,
  cartridge_meta_scoped, runtime_values, npc_memories, …) are empty;
- engine-default `cartridge_meta` knobs (`density_caps`, `world_clock`)
  are present, but cartridge-scoped quickgrin keys
  (`cartridge_id`, `starting_location_id`, `atmosphere_presets`, …)
  are absent;
- engine persona archetypes + mechanical-vocab i18n are seeded
  (`narrator_parchment`, `condition.bleeding` = "Bleeding", etc.);
- no per-cartridge entity i18n lands (entities table is empty);
- `runtime_fields` holds zero rows (all engine cross-cutting
  registrations use `SELECT FROM entities` patterns that naturally
  produce zero rows on an empty entities table);
- engine functions (`rebuild_local_density`, `safe_jsonb_array`) are
  installed.

Recommended checks:

```powershell
npm --prefix packages/web-server run typecheck
npm --prefix packages/web-server exec -- vitest run src/__tests__/migrations/engineBaseline*.test.ts --maxWorkers=1 --minWorkers=1
npm --prefix packages/web-server run live:engine-baseline-cartridge
```
