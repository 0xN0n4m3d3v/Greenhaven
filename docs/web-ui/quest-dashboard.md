# Quest Dashboard

`FEAT-QUEST-1` adds a real Quest Dashboard surface backed by a
batched read-only snapshot endpoint. The retired compact
`QuestPanel` rail path has been removed; the dashboard surface,
opened by the `Q` hotkey or the player surface menu, is the single
quest UI and reads `/api/player/:id/quest-dashboard` through
`bridge/questDashboard.ts` and the `useQuestDashboard` hook.

## Server

- Service: `packages/web-server/src/services/QuestDashboardService.ts`.
  `QuestDashboardService.snapshot(playerId, language)` returns
  `null` for unknown players and otherwise a stable
  `QuestDashboardSnapshot` DTO with `summary`, grouped
  `active` / `choiceRequired` / `offered` / `completed` /
  `failed` / `archived` cards, and a `recentEvents` rail from
  `gui_events`.
- Single batched join over `player_quests` + `entities` plus one
  bounded `gui_events` tail query, with no per-quest entity lookup
  loop.
- Route: `GET /api/player/:id/quest-dashboard?language=<code>` in
  `packages/web-server/src/routes/quests.ts`; protected by the
  central `ownsPlayer()` middleware mounted in `index.ts`. Errors
  follow the same style as the compact panel: invalid id 400,
  unknown player 404.

## Frontend

- Bridge: `packages/web-ui/src/bridge/questDashboard.ts`. Owns the
  `fetch` call and the `QuestDashboardSnapshot` type; the surface
  never touches the network directly.
- Hook: `packages/web-ui/src/hooks/useQuestDashboard.ts`. Loads on
  mount, then refreshes whenever any of the ten quest / adventure
  events listed below arrive. Refresh fan-in uses two real
  transports (see "Frontend bridge plumbing" below): the
  `__emit('system:event', â€¦)` channel filtered against
  `QUEST_DASHBOARD_REFRESH_TYPES`, plus `window` listeners on the
  side-effect-only `quest:changed` and `adventure:changed`
  dispatches.
- Surface: `packages/web-ui/src/components/surfaces/QuestDashboardSurface.tsx`.
  Renders summary counts, status tabs (Active / Choice required /
  Offered / Completed / Failed / Archived), a search input, a
  list + detail layout, an objective tracker, stage timeline,
  rewards, and a "recent quest activity" rail. Status labels,
  bucket-empty hints, badge, and history-type labels are all
  i18n keys under `ui.surface.quests.*`.

## Event taxonomy watched

The dashboard refreshes on every dashboard-relevant quest /
adventure event the server actually writes. Each entry below maps
the event type to the file that calls `emitGuiEventForSession`:

- `quest:created` â€” `tools/quest.ts:emitQuestCard`
- `quest:started` â€” `tools/quest.ts:emitQuestCard`
- `quest:advanced` â€” `tools/quest.ts:emitQuestCard`
- `quest:auto_advanced` â€” `agents/questWatcher.ts`
- `quest:choice_required` â€” `quest/questEngine.ts`
- `quest:completed` â€” `tools/quest.ts:emitQuestCard`
- `quest:changed` â€” `quest/questEngine.ts` (side-effect event;
  not rendered as a timeline card)
- `adventure:hook` â€” `domain/adventure/runtime/adventureQueue.ts`
- `adventure:accepted` â€” `domain/adventure/AdventureService.ts`
- `adventure:expired` â€” `domain/adventure/runtime/adventureQueue.ts`

The two sources of truth for this taxonomy are
`QUEST_DASHBOARD_EVENT_TYPES` exported from
`packages/web-server/src/services/QuestDashboardService.ts` and
the `QUEST_DASHBOARD_REFRESH_TYPES` Set exported from
`packages/web-ui/src/hooks/useQuestDashboard.ts`. Any new emit
site must extend both.

### Frontend bridge plumbing â€” two real transports

The hook listens on **two** buses because the bridge splits
quest/adventure traffic across them:

- `bridge/eventTimeline.ts:emitSystemEventFromGuiEnvelope` pushes
  every released `gui_event` envelope into
  `__emit('system:event', {type, ...})`. The hook filters that
  channel against `QUEST_DASHBOARD_REFRESH_TYPES`. Replay (initial
  bootstrap) flows through the same path.
- `quest:changed` is the only event that is **not** re-emitted
  into the `system:event` channel. The bridge keeps it as a
  side-effect-only `window.dispatchEvent('quest:changed')`, so the
  dashboard hook adds a matching
  `window.addEventListener('quest:changed')`.
- `adventure:*` events also produce a `window` `adventure:changed`
  side effect via `dispatchAdventureChanged`. The hook listens
  for that too, so even if a future timeline change bypasses the
  `system:event` re-emit the dashboard still refreshes.

The recent-history rail in the snapshot DTO normalizes the
`questEntityId` / `questName` pointers across every payload
variant the server emits today (`questId`, `quest_id`,
`questEntityId`, `quest_entity_id`, `title`, `questName`,
`quest_name`).

## Tests

- `packages/web-server/src/__tests__/services/questDashboardService.test.ts`
  pins the DTO contract: empty player, batched query (no
  per-quest entity loop), grouping into the six buckets,
  `awaitingChoice` derivation from `accumulated_state`, stage
  timeline computation for active / completed / failed,
  `nextActionHint` derivation, and the gui_events filter.

## Status

FEAT-QUEST-1 is `[done]` in the master plan. The server
snapshot, bridge, hook, surface, status tabs, search,
list/detail layout, timeline, rewards, history rail, i18n, and
focused service test are all in place, and an isolated browser
smoke at
`.codex/run-logs/live-playtest/2026-05-16T18-00-00Z-quest-dashboard-browser-smoke/`
proves the round trip end to end: seed a debug quest via
`/api/debug/live-ops`, open the surface via the ChatHeader menu's
`Q` item against the production-built web-ui dist, emit a
`quest:changed` envelope through live-ops, observe the hook
refetch (`dashboardFetchesBeforeEmit:1` â†’ `dashboardFetchesAfterEmit:2`)
with no full reload, then `page.reload()` and confirm the same
seeded quest is still rendered.
