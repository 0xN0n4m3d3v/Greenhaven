# Web UI architecture

The frontend is a Vite + React 19 SPA in
[packages/web-ui/](../../packages/web-ui/). It speaks to the Hono backend via
HTTP for commands and SSE for streamed events. State management is hook-local +
a global runtime bus (`__emit`); no Redux, no Zustand. This page explains the
wiring.

## App.tsx

The root component at
[packages/web-ui/src/App.tsx](../../packages/web-ui/src/App.tsx). Mounts the
chat, the rail (sidebar), the dialogue banner, and the modals (settings,
recovery, character creator).

What App.tsx owns:

- The single `state: GameState` snapshot and top-level state wiring.
- Direct travel/mention handlers that bind the composer and bubble menu.
- First-launch/loading gates, settings modal state, and screen composition.

It does **not** own bootstrap/retry, frontend telemetry context, pending-turn
rehydrate, dialogue start/sign-out, reset lifecycle, system-event merge
bookkeeping, per-component animation state, per-event rendering, or bridge-bus
mechanics. Those live in components and focused hooks.

Runtime bus subscriptions are factored into focused hooks instead of inline root
effects:
[useSseSubscriptions](../../packages/web-ui/src/hooks/useSseSubscriptions.ts),
[useMentionTargets](../../packages/web-ui/src/hooks/useMentionTargets.ts),
[useLocationUpdates](../../packages/web-ui/src/hooks/useLocationUpdates.ts),
[useSessionResetUi](../../packages/web-ui/src/hooks/useSessionResetUi.ts),
[usePlayerMessageCreated](../../packages/web-ui/src/hooks/usePlayerMessageCreated.ts),
and
[useTurnCancellation](../../packages/web-ui/src/hooks/useTurnCancellation.ts).
User turn submission and Continue flow live in
[useTurnSubmission](../../packages/web-ui/src/hooks/useTurnSubmission.ts).
Bootstrap/retry lives in
[useGameBootstrap](../../packages/web-ui/src/hooks/useGameBootstrap.ts), reset
lives in [useResetGame](../../packages/web-ui/src/hooks/useResetGame.ts),
dialogue actions live in
[useDialogueActions](../../packages/web-ui/src/hooks/useDialogueActions.ts)
(sign-out plus explicit start/resume; dialogue end is inferred server-side from
player intent and `dialogue:participants_updated`), and
system event merge state lives in
[useSystemEvents](../../packages/web-ui/src/hooks/useSystemEvents.ts).

## bridge/api.ts

The "API surface" is the drop-in replacement for the old Wails Go bindings.
Functions match the generated signatures so App.tsx can call the same API.
Source:
[packages/web-ui/src/bridge/api.ts](../../packages/web-ui/src/bridge/api.ts).

Responsibilities:

- **Public Wails-compatible API** - exported functions consumed by App.tsx and
  settings panels.
- **HTTP helpers** - shared `fetch()` wrappers for Hono endpoints.
- **Settings/model bridge** - language, model override, role model, and
  storage-facing accessors.

Former bridge internals are now split:

- [bootstrap.ts](../../packages/web-ui/src/bridge/bootstrap.ts) owns
  player/session bootstrap.
- [sseClient.ts](../../packages/web-ui/src/bridge/sseClient.ts) owns live SSE
  listeners.
- [eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts) owns
  `SYSTEM_EVENT_TYPES`, replay, and event-id dedupe.
- [turnJobs.ts](../../packages/web-ui/src/bridge/turnJobs.ts) owns job
  submit/wait/cancel.
- [stateReconciler.ts](../../packages/web-ui/src/bridge/stateReconciler.ts) owns
  persisted message/state conversion.
- [sessionReset.ts](../../packages/web-ui/src/bridge/sessionReset.ts) owns
  reset/sign-out/local storage cleanup.

## Client Storage

Source:
[packages/web-ui/src/lib/clientStorage.ts](../../packages/web-ui/src/lib/clientStorage.ts).

There is no external storage package. The app uses a small internal wrapper
because the required behavior is fixed and narrow:

- `CLIENT_STORAGE_KEYS` is the canonical registry for every `greenhaven.*` key.
- Player identity is two keys: `greenhaven.playerPublicId` and
  `greenhaven.sessionId`. They must be cleared together.
- `ListLocalClientStorage()` returns the current GreenHaven-owned browser keys
  for diagnostics.
- `ClearLocalClientStorage({keepPreferences: true})` clears game
  identity/session state while preserving language/audio/model preferences.
- If `/player/me` returns `404` for the bootstrapped player, the bridge clears
  stale identity, closes the old SSE stream, and creates a fresh anonymous
  player/session.

The full system-card catalog is `SYSTEM_EVENT_TYPES` in
[packages/web-ui/src/bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts)
— every entry maps to a system EventCard rendered by
[packages/web-ui/src/components/chat/EventCard.tsx](../../packages/web-ui/src/components/chat/EventCard.tsx).
See [event-cards.md](event-cards.md).

## Runtime bus

Source:
[packages/web-ui/src/bridge/runtime.ts](../../packages/web-ui/src/bridge/runtime.ts).
A tiny in-process pub-sub.

```ts
EventsOn(eventName, cb): () => void   // subscribe; returns unsubscribe
EventsEmit(eventName, ...args): void  // publish
__emit(eventName, ...args): void      // back door for transport adapters
```

Listener errors are caught and logged — propagation never stops because one
listener threw.

This is the "loose coupling" layer. SSE events from the server land in
`bridge/sseClient.ts`, which extract / normalise data and call
`__emit('system:event', payload)`. Components that care subscribe via hooks
(`useSseSubscriptions`, `useRuntimeFields`, `useMoodPulse`).

The bus exists because the codebase descended from Wails (Go-side event bus).
The same shape is now an in-memory map. Worth keeping — it decouples the SSE
transport from component logic, lets us mock in dev, and the few lines of
overhead are imperceptible.

## State shape

`GameState` is the single normalised snapshot. The full type is in
[packages/web-ui/src/types/app.ts](../../packages/web-ui/src/types/app.ts).

Core fields:

- `messages: ChatMessage[]` — chronological. Each message has `id`, `tone`,
  `author`, `text`, optional `dice`, optional `event` payload for system cards.
- `hero: PlayerSnapshot` — current HP/XP/level/location/scene/dialogue
  partner/companions.
- `currentLocation`, `currentScene`, `peopleHere`, `itemsHere`, `exits` —
  derived from preamble + per-turn updates.
- `runtimeFields: Record<string, unknown>` — surfaced fields from the most
  recent preamble.
- `affordances: Affordance[]` — quick-action buttons resolved server-side.
- `quests: ActiveQuest[]`, `inventory: InventoryEntry[]` — same shape as the
  server `/api/world?entity=` payloads.

Updates flow:

- `loadState()` on boot → full snapshot.
- `runtime:field` SSE → patch `runtimeFields[key]` and trigger any subscribed
  hook (e.g. atmosphere transitions on time-of-day changes).
- `turn.start` → set `currentTurnJob` to in-flight.
- `content` deltas → append to a streaming bubble in `messages`.
- `narrate` SSE → finalise the bubble.
- `turn.end` → drain the in-flight bubble.
- `system:event` → push an EventCard message onto `messages`.

Optimistic updates: when the player submits, App.tsx pushes a temporary "player"
bubble immediately; `turn.start` confirms.

## SSE consumer

`useSseSubscriptions`
([packages/web-ui/src/hooks/useSseSubscriptions.ts](../../packages/web-ui/src/hooks/useSseSubscriptions.ts))
is the high-level subscriber. It binds the lifecycle:

- Subscribes to `system:event`, `dice:rolled`, `runtime:field`, `mode:changed`,
  etc.
- Dispatches into App.tsx state setters via callbacks passed in.
- Cleanup on unmount (the unsubscribe-fn returned by `EventsOn`).
- Bookkeeping (dedupe consecutive `mode:changed` for the same mode; throttle
  `runtime:field` storms).

Other purpose-built hooks that read the bus:

- `useGameBootstrap` - loads the initial state, restores pending jobs, and owns
  retry.
- `useFrontendTelemetry` - keeps frontend telemetry scoped to player and turn.
- `useAvailableLanguages` - loads the settings language list.
- `useDialogueActions` - owns sign-out and dialogue start/resume bridge calls.
  Manual end-dialogue controls are intentionally absent; the server switches or
  clears focus from player intent and emits dialogue updates.
- `useResetGame` - owns reset confirmation, bridge reset, UI cleanup, and
  reload.
- `useSystemEvents` - preserves event ids and turn anchors while merging card
  updates.
- `useMentionTargets` - merges state, affordance, and discovered SSE mentions.
- `useLocationUpdates` - replaces live sidebar/current-location summaries after
  movement.
- `useSessionResetUi` - clears transient UI on `session:reset`.
- `usePlayerMessageCreated` - syncs the optimistic player bubble once the server
  creates the message.
- `useTurnCancellation` - maps ESC to turn-job cancel.
- `useTurnSubmission` - owns inline dice, turn-job submit/poll, failure pending
  bubbles, turn-result application, and Continue flow.
- `useAmbientBed` — listens to `ambient:bed`, cross-fades Howler audio stems.
- `useMoodPulse` — listens to `string:changed`, pulses the affected NPC's
  avatar.
- `useRuntimeFields` — exposes a reactive read of `runtimeFields[key]` for any
  component (atmosphere uses it to track time-of-day).
- `usePersonRegistry` — caches NPC profiles fetched on first reference.

The full SSE flow — server emits → bridge translates → bus → hook → component —
is documented in [sse-flow.md](sse-flow.md).

## Sources

- [packages/web-ui/src/App.tsx](../../packages/web-ui/src/App.tsx) — root
- [packages/web-ui/src/bridge/api.ts](../../packages/web-ui/src/bridge/api.ts) -
  public API facade + HTTP helpers
- [packages/web-ui/src/bridge/sseClient.ts](../../packages/web-ui/src/bridge/sseClient.ts) -
  live SSE listeners
- [packages/web-ui/src/bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts) -
  system-card catalog + GUI event replay
- [packages/web-ui/src/bridge/runtime.ts](../../packages/web-ui/src/bridge/runtime.ts)
  — `EventsOn` / `EventsEmit` / `__emit`
- [packages/web-ui/src/hooks/useSseSubscriptions.ts](../../packages/web-ui/src/hooks/useSseSubscriptions.ts)
  — high-level SSE subscriber
