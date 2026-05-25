# Character State

`FEAT-STATE-1` adds a typed Character State surface (P hotkey)
backed by `/api/player/:id/character-state`. The previous
FEAT-SHELL placeholder reused `HeroVitals` / `PlayerStateRail` /
`CurrencyBadge` rail components that parsed hero status / state
strings; this surface reads only the typed
`CharacterStateSnapshot` DTO and renders five tabs (Overview /
Attributes / Skills / Titles / Progression Log).

## Server contract

- Migration `packages/web-server/migrations/0121_character_state_progression.sql`
  adds four durable structures behind the surface:
  `player_titles` (deduped by `(player_id, title_key)`, FK to
  `players(entity_id)` cascading on delete), `progression_tracks`
  (catalog), `player_progression_tracks` (per-player ladder
  keyed on `(player_id, track_key)` with CHECKs `xp >= 0` and
  `level >= 1`), and `player_progression_wallets` (one row per
  player, non-negative CHECKs on `stat_points` / `skill_points`
  / `title_slots`).
- Service: `packages/web-server/src/services/CharacterStateService.ts`.
  `snapshot(playerId, language?)` returns `null` for unknown
  players and otherwise a typed `CharacterStateSnapshot` DTO
  with `identity`, `vitals`, `stats`, `proficientSkills`,
  `rankedSkills`, `equipment` (delegated to
  `InventoryReadService.snapshot`), `titles`, `progression`
  (`tracks` + `wallet`), `recentXpLog` (newest 20 rows of
  `player_xp_log`), `conditions`, and `trauma`. All structured
  fields come from durable tables — no prose parsing, no chat-
  text scraping, no rail-string decoding.
- XP math: the canonical curve lives in migration 0002.
  `xp_required_for_level(L) = 100 * L^2`, inverse
  `level_for_xp(xp) = floor(sqrt(xp / 100))` (clamped to 1).
  The service surfaces level 1 with `thisLevelFloor = 0`
  (the inverse clamps everything below xp 400 to level 1) and
  does NOT unilaterally cap `nextLevelXp` at level 20 — the
  quadratic curve continues past the `xp_thresholds` table and
  `award_xp` writes still target it. The surface shows the bar
  as "max level reached" only when SQL itself returns NULL for
  `nextLevelXp`.
- Route: `GET /api/player/:id/character-state?language=<code>`
  in `packages/web-server/src/routes/characterState.ts`,
  protected by `ownsPlayer()` mounted on
  `/api/player/:id/character-state` in `index.ts`. Returns
  `{playerId, identity, vitals, ...}`; 400 on invalid id, 404
  on unknown player.

## Frontend

- Bridge: `packages/web-ui/src/bridge/characterState.ts`. Owns
  the `fetch` call and the full typed DTO (`CharacterStateSnapshot`
  + sub-types); the surface never touches the network directly.
- Hook: `packages/web-ui/src/hooks/useCharacterState.ts`. Loads
  on mount and refreshes when any event in
  `CHARACTER_STATE_REFRESH_TYPES` (`xp:awarded`, `xp:levelup`,
  `inventory:changed`, `currency:changed`, plus the future
  `character:*` / `damage:dealt` / `actor:status_changed` /
  `equipment:changed` channels documented in the fixspec for
  when their emitters land) reaches the `system:event` bus that
  `bridge/eventTimeline.ts` feeds. Debounces refresh bursts in
  a 150 ms window. Uses a monotonic `generationRef` stale-write
  guard so a late response from a previous player / language /
  baseUrl generation never mutates state in a newer one; an
  identity change always clears the previous snapshot, and a
  404 / network error clears it too so an old player's sheet
  cannot remain visible under a new player / error state.
- Surface:
  `packages/web-ui/src/components/surfaces/CharacterStateSurface.tsx`.
  Accepts `{playerId, language, t}`. Renders the loading /
  error / empty states first, then the always-visible header
  (avatar + name + class + HP bar + level/XP bar with
  `xp_progress` text or `xp_max` when SQL returns null) and the
  five tabs. Each tab handles its own empty placeholder so the
  shell never collapses on a new player.
  - **Overview** — equipment summary, point wallet, conditions
    pill list, trauma pill list.
  - **Attributes** — `player_stats` grid showing each `(key,
    current, base)` triple. Cells render `base N` only when
    `current ≠ base`.
  - **Skills** — proficient skills (with Proficient /
    Expertise label) and ranked skills (with `Rank N`).
  - **Titles** — full title roster, equipped-first. Source and
    description render when the server provides them; each row
    has an Equip / Unequip button that dispatches the
    `equip_title` action through the bridge (see "Player
    actions" below).
  - **Progression log** — side-track ladder rows + recent XP
    log (newest 20).

  Each tab also wires the player-clickable mutation surface:

  - **Attributes** — every `(key, current, base)` row gets a
    `Spend point` button. The button is disabled when
    `wallet.statPoints` is zero (server still validates) and
    when any other action is pending. Click dispatches
    `spend_stat_point` for that `statKey`.
  - **Skills** — ranked-skill rows get a `Rank up` button
    disabled while `wallet.skillPoints` is zero. Click
    dispatches `spend_skill_point` for that skill name.

  Proficient skills don't carry an action button (the broker
  decides what is proficient; the player can't unlock
  proficiency directly).

## Refresh taxonomy

The hook listens on **two** real transports because the bridge
splits Character State traffic between them:

1. `EventsOn('system:event', …)` — the channel
   `bridge/eventTimeline.ts` re-emits every released gui_event
   envelope on. The hook filters this against
   `CHARACTER_STATE_REFRESH_TYPES`, which scopes the refresh
   strictly to envelopes the server actually emits today:
   - `xp:awarded` / `xp:levelup` — `tools/progression.ts`
     `award_xp`
   - `character:skill_progressed` — `tools/progression.ts`
     `award_progression_xp` and `spend_skill_point` (when
     bumping rank)
   - `character:skill_unlocked` — `tools/progression.ts`
     `spend_skill_point` (first rank)
   - `character:stat_changed` — `tools/progression.ts`
     `spend_stat_point`
   - `character:title_awarded` — `tools/progression.ts`
     `award_title`
   - `character:title_equipped` — `tools/progression.ts`
     `equip_title`
   - `damage:dealt` / `actor:status_changed` — combat / status
     tools that move HP or conditions
2. Direct named bus channels listed in
   `CHARACTER_STATE_DIRECT_REFRESH_TYPES`:
   `inventory:changed` and `currency:changed` are re-emitted by
   `sseClient.ts` as their own keys (not wrapped in
   `system:event`), so the hook adds `EventsOn(name, …)`
   listeners for each. `equipment:changed` is reserved for a
   future server emitter and listens here without any wiring
   edit when that channel lands.

The Phase 9 fixspec also names `character:title_awarded` /
`character:title_equipped` / `character:skill_progressed` /
`character:stat_changed` as the canonical bus channels, and
the five FEAT-STATE-1 mutation tools emit them through
`emitGuiEvent` (the canonical `gui_events` writer), so they
flow through both replay and live SSE without any extra
plumbing.

## Tests

- `packages/web-server/src/__tests__/services/characterStateService.test.ts`
  (13 cases on mocked `query()` + mocked `InventoryReadService`)
  pins the typed DTO contract: null on unknown player, fresh-
  player empty shape (level 1 floor = 0 per the canonical
  inverse), XP math for levels 2 and 20, the explicit drop of
  the service-only level-20 cap, deterministic ordering on
  stats / proficient / ranked skills, equipped-first title
  ordering, progression-track ↔ catalog join + wallet defaults,
  XP-log limit 20, conditions/trauma flattening, equipment
  delegation, and the static SQL guarantee that no query
  references rail-status strings or chat prose.
- `packages/web-server/src/__tests__/migrations/characterStateProgression.test.ts`
  (5 cases on real PGlite) pins the 0121 migration: column
  shape, primary keys, foreign-key cascades, CHECK constraints,
  and the dedupe + cascade behavior the materializer relies on.

## Mutation tools

The five Character State mutation tools live in
`packages/web-server/src/tools/progression.ts` and all share
the same discipline: `resolvePlayerTarget` for ownership,
`withTransaction` for race-safe wallet / title / track / skill
row-level locking, `ToolExecutionError({rejected: true})` for
broker-retryable rejections, and a replayable `emitGuiEvent`
call on success:

- `award_progression_xp(track_key, amount, reason)` — side-
  track XP grant. Requires the `progression_tracks` catalog
  row; derives level from the `xp_curve` JSONB (supports
  `xpPerLevel` cumulative arrays and `{kind:'linear', step:N}`,
  falls back to a step=100 linear curve, clamps at
  `max_level`). Emits `character:skill_progressed`.
- `award_title(title_key, display_name, description?, source?, metadata?)`
  — title award. Deduped by `(player_id, title_key)` via the
  partial unique index from migration 0121. Returns
  `newly_awarded:true` only on the first grant; the duplicate
  path re-reads the existing row id and emits no event.
- `equip_title(title_key, equip)` — locks the wallet +
  title rows, enforces `title_slots`, supports
  equip / unequip, emits `character:title_equipped`. Rejects
  when the player has not earned the title or the slot cap
  is hit.
- `spend_stat_point(stat_key, reason?)` — locks the wallet,
  rejects on zero `stat_points`, ensures a default
  `player_stats` row exists, increments base + current by 1,
  decrements the wallet, emits `character:stat_changed` with
  `statPointsRemaining`.
- `spend_skill_point(skill)` — `resolveEntityId(skill)`
  resolves the skill entity (rejects unknowns), locks the
  wallet + skill row, increments rank, emits
  `character:skill_unlocked` (first rank) or
  `character:skill_progressed` (rank-up).

All five are registered in `tools/batchMutate.ts:ALLOWED_BATCH_TOOLS`
(can be fanned out from `batch_mutate_world`),
`agents/finalizationGuards.ts:CANON_AFTER_PAYMENT_TOOLS`
(count toward the post-payment canon budget), and
`tools/narrate/controlText.ts:TOOL_FUNCTION_NAMES` (an LLM
hallucinating a tool call inside narrate text is detected and
stripped).

## Player actions

The four player-clickable mutations go through a dedicated
action route + bridge helper that mirrors `FEAT-INV-1`:

- Server: `POST /api/player/:id/character-state/action` in
  `packages/web-server/src/routes/characterState.ts`. Mounted
  under the same `ownsPlayer()` + `rateLimitStateChanges()`
  chain as the GET. Body is a zod `discriminatedUnion('action',
  ...)` of `equip_title` / `unequip_title` / `spend_stat_point`
  / `spend_skill_point`. The handler validates the body, then
  re-validates the supplied `sessionId` against the
  authenticated player via `SessionLifecycleService.getOwned`
  (404 `unknown_session`, 403 `session_forbidden`), then maps
  the action into the matching tool (`equip_title` with
  `equip:true/false`, `spend_stat_point`, `spend_skill_point`)
  and dispatches via `runWithContext` + `executeTool` so all
  validation, transactional state mutation, and the
  `character:*` SSE fan-out are shared with the LLM-driven
  path. Returns `{ok, action, result?, error?}` with the same
  `400` / `403` / `404` / `429` shape as the inventory route.
  `award_progression_xp` and `award_title` are deliberately NOT
  exposed — those stay broker / GM concerns and live on the
  tool / live-ops paths.
- Bridge: `packages/web-ui/src/bridge/characterState.ts` exports
  `postCharacterStateAction(req)` (typed
  `CharacterStateActionRequest` / `CharacterStateActionResult`)
  so the surface never `fetch`'es directly. The helper builds
  the body conditionally by action kind (only includes
  `titleKey` for title actions, `statKey` / optional `reason`
  for stat point spend, `skill` for skill point spend) and
  surfaces a structured `{ok:false, error}` for both HTTP and
  payload failures, including a synthesised
  `character_state_action_failed_<status>` fallback when the
  server returns no JSON body.
- Surface: `CharacterStateSurface` tracks a single in-flight
  `ActionState` (`pending: {kind, target}`, `error`,
  `successKind`). The buttons disable themselves while any
  action is pending, render an inline `Loader2` spinner on
  the pending row, and show a single trailing chip at the
  bottom of the body — `character-state-action-error` or
  `character-state-action-success` — keyed by the last
  attempted action. Snapshot refresh arrives through
  `useCharacterState`'s `character:*` SSE listeners, so the
  surface never mutates local state optimistically.

The action route is covered by
`packages/web-server/src/__tests__/routes/characterStateActionRoute.test.ts`
(14 cases): unauthenticated 401, mismatched cookie 403,
malformed JSON 400, unknown action discriminator 400,
`equip_title` without `titleKey` 400, unknown / forbidden
session, equip / unequip / spend_stat (with and without
optional `reason`) / spend_skill mapping, tool-level failure
forwarded as `ok:false` 400, and SEC-5 bucket exhaustion 429.

## Status

`FEAT-STATE-1` closed 2026-05-16 — flipped to `[done]` in the
master plan after the isolated browser smoke harness passed end
to end against a real Greenhaven backend + production-built
web-ui dist.

- Smoke harness:
  `.codex/run-logs/live-playtest/2026-05-16T20-00-00Z-character-state-browser-smoke/character-state-browser-smoke.ts`.
- Command:
  `npm exec -- tsx .codex/run-logs/live-playtest/2026-05-16T20-00-00Z-character-state-browser-smoke/character-state-browser-smoke.ts`.
- Coverage: seeds Character State data in-process through real
  progression tools (`award_xp`, `award_progression_xp`,
  `award_title`, `spend_skill_point`) plus minimal fixture rows
  (`progression_tracks` catalog, `entities` skill row,
  `player_progression_wallets` budget, base `player_stats`,
  one `player_proficient_skills` row), then drives the UI via
  title screen → ChatHeader `P` menuitem, walks all five tabs,
  clicks Equip / Unequip / Equip + Spend point + Rank up
  through the production
  `/api/player/:id/character-state/action` endpoint, watches
  the open UI refresh from `character:*` SSE events without a
  full reload, and reloads to prove durable rehydration.
- Evidence (next to the harness): `result.json`
  (`passed:true blockers:[]`), 14 JSON snapshots
  (`health-api/db`, `character-state-{before,after-seed,
  after-actions,after-reload}`, four `action-*.json`,
  `seed-results.json`), 10 screenshots
  (`ui-loaded`, `surface-open`,
  `tab-{attributes,skills,titles,progression}`,
  `after-{equip,spend-stat,spend-skill,reload}`),
  `sse-events.jsonl`, `console-log.jsonl`,
  `network-log.jsonl`.
