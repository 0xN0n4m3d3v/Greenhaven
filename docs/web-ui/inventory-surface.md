# Inventory Surface

`FEAT-INV-1` makes the **Inventory** (I hotkey) a real, server-
backed surface. The FEAT-SHELL-1 placeholder only rendered an
empty modal; the new body reads a typed snapshot through a bridge-
owned fetch + hook, and the detail panel's action buttons dispatch
through a player-validated action endpoint that routes into the
existing inventory tools.

## Server contract

- Migration `packages/web-server/migrations/0119_inventory_surface_columns.sql`
  adds the columns the surface keys off without touching the
  legacy `player_inventory` / `items` mutation paths:
  `player_inventory.equipped_slot`, `items.rarity`,
  `items.icon_key`. Existing rows stay untouched; new content
  fills these in opportunistically.
- Service:
  `packages/web-server/src/services/InventoryReadService.ts`.
  `snapshot(playerId, language?)` unions `player_inventory`
  (the structured surface) and `inventory_entries` (legacy
  entity-flavored items) into one typed `InventorySnapshot`:
  `currency`, `equipment` (equipped subset), `items` (full bag),
  `totals` (item count, unique items, weight kg, equipped
  count). Currency is the bag-wide sum of every
  `items.category = 'currency'` row so the existing
  `/api/player/currency` endpoint and the surface badge keep
  matching.
- GET route:
  `GET /api/player/:id/inventory?language=<code>` in
  `packages/web-server/src/routes/inventory.ts`, protected by
  `ownsPlayer()` mounted on `/api/player/:id/inventory` and the
  `/inventory/*` wildcard in `index.ts`. Returns the
  `InventorySnapshot` DTO; 400 on invalid id, 404 on unknown
  player.
- Action route:
  `POST /api/player/:id/inventory/action`. Body is a zod
  `discriminatedUnion('action', ...)` of `use` / `equip` /
  `unequip` / `give`. The handler validates the body, re-
  validates the supplied `sessionId` against the authenticated
  player via `SessionLifecycleService.getOwned` (404
  `unknown_session`, 403 `session_forbidden`), then dispatches
  through `runWithContext` + `executeTool` into the matching
  inventory tools (`use_item`, `equip_item` with
  `equipped:true/false`, `give_to_npc` with `quantity`
  defaulted). Mounted under the same `ownsPlayer()` chain plus
  `rateLimitStateChanges()` for SEC-5. Returns
  `{ok, action, result?, error?}` with `400` / `403` / `404` /
  `429` shapes mirroring FEAT-NOTICE-1 / FEAT-STATE-1.

## Frontend

- Bridge: `packages/web-ui/src/bridge/inventory.ts`. Owns the
  `fetch` call and the typed
  `InventoryItem` / `InventorySnapshot` /
  `InventoryActionKind` / `InventoryActionResult` types. The
  surface never calls `fetch` directly. The action helper
  `postInventoryAction(req)` builds the body conditionally by
  action kind (so `give` carries the NPC target,
  `use` can optionally carry a target location, etc.) and
  surfaces a synthesised
  `inventory_action_failed_<status>` fallback when the server
  returns no JSON body.
- Hook: `packages/web-ui/src/hooks/useInventorySnapshot.ts`
  loads on mount and refreshes on the
  `inventory:changed` / `currency:changed` SSE channels that
  `sseClient.ts` re-emits as direct named bus events. Uses a
  monotonic generation token so a stale fetch from a previous
  player / language generation never writes after a new effect
  re-runs. Refresh bursts collapse inside a 150 ms window.
- Surface:
  `packages/web-ui/src/components/surfaces/InventorySurface.tsx`.
  Renders the typed snapshot in five panes: a summary header
  (currency + totals), the equipment strip (equipped rows
  clickable), category filter chips (`all`, then `weapon` /
  `armor` / `consumable` / `tool` / `quest` / `material` /
  `misc`), a search box, a list/grid view toggle, the bag
  list, and the detail panel. The detail panel renders
  category-appropriate action buttons (`Use` for consumables /
  tools, `Equip` / `Unequip` for weapons / armor, `Give to…`
  for everything else in the bag). Each click reads
  `readStoredSessionId()` from `lib/clientStorage.ts`,
  dispatches through `postInventoryAction`, and tracks a
  single in-flight `ActionState` (`pending`, `error`,
  `successAction`) so the action buttons disable themselves
  while a request is in flight and render a trailing success /
  error chip. Snapshot refresh comes only from the
  `inventory:changed` SSE channel — there is no optimistic
  mutation.
- CSS:
  `packages/web-ui/src/styles/messenger-layout.css` `FEAT-INV-1`
  block. Uses existing Greenhaven CSS tokens
  (`--gh-surface-elev`, `--gh-text-strong`, etc.); no donor /
  Material UI imports.
- i18n: surface titles, filter chip labels, action button
  labels, success / error chips, and the search placeholder
  live in `lib/uiMessages.ts` (en + ru) and
  `lib/translationExtras.ts` (COMMON pack covers the remaining
  24 locales).

## Event taxonomy watched

The hook listens on two real transports because the bridge
splits Inventory traffic between them:

- `EventsOn('inventory:changed', …)` and
  `EventsOn('currency:changed', …)` — `sseClient.ts` re-emits
  these as direct named bus channels (not wrapped in
  `system:event`). Either one triggers the read endpoint.
- `EventsOn('system:event', …)` filtered against a small
  inventory taxonomy — the same fan-out
  `bridge/eventTimeline.ts` already feeds for the other
  surfaces — for completeness when a non-direct envelope
  changes the bag.

The canonical writers for these channels are
`tools/inventory*.ts` (`use_item`, `equip_item`,
`give_to_npc`, `drop_item`, dynamic-materialization flows) and
`turn/phases/*` (currency drops, world-state writes). Adding a
new mutation site means emitting through `emitGuiEvent` so the
bridge's two-transport fan-out picks it up.

## Tests

- `packages/web-server/src/__tests__/services/inventoryReadService.test.ts`
  pins the typed DTO contract: equipment summary, dedupe across
  `player_inventory` / `inventory_entries`, currency sum,
  weight totals, deterministic ordering, language passthrough,
  null-on-unknown-player.
- `packages/web-server/src/__tests__/routes/inventoryActionRoute.test.ts`
  (14 cases on mocked `executeTool` +
  `SessionLifecycleService`) pins the action wiring: 401
  unauth, 403 mismatch, 400 invalid_json / unknown action /
  give-without-npc, 404 unknown_session, 403
  session_forbidden, the four action mappings to the right
  tool with the right arg shape, tool-level failure forwarded
  as `ok:false` 400, and SEC-5 bucket exhaustion 429.
- `packages/web-server/src/__tests__/migrations/inventorySurfaceColumns.test.ts`
  pins the migration shape on real PGlite.

## Smoke evidence

`FEAT-INV-1` was first proved end-to-end by
`.codex/run-logs/live-playtest/2026-05-16T17-00-00Z-inventory-browser-smoke/inventory-browser-smoke.ts`,
which seeds a weapon via `grant_item` live-ops then drives
title → Continue → game shell → I → equip → unequip → reload
through real Chromium.

The Tier-8 cross-feature gate then verified Inventory
coexists with Quest Dashboard / Notice Journal / Character
State in the same live session:
`.codex/run-logs/live-playtest/2026-05-16T21-00-00Z-tier8-cross-feature-smoke/tier8-cross-feature-smoke.ts`.

## Status

`FEAT-INV-1` is `[done]` in the master plan. Backend read +
action route, frontend bridge + hook + surface + detail panel
action buttons + CSS + i18n, focused service + route +
migration tests, the FEAT-INV-1 closure smoke, and the Tier-8
cross-feature smoke are all in place and green.
