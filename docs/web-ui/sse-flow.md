# SSE → bus → state flow

How a server-side SSE event becomes a UI mutation. Three hops: server emits → bridge translates → bus → hook subscribes → component renders.

For the full event catalog see [server/sse-events.md](../server/sse-events.md). For the EventCard variants see [event-cards.md](event-cards.md).

Current ordering contract: chat-visible system events are server-owned `gui_events` with durable `eventId`s and `releaseSeq`s, replayed by `/api/session/:id/events`, and deduped in the bridge. `eventId` is identity; `releaseSeq` is the visible order and replay cursor for deferred events (`afterReleaseSeq`). Player bubbles are committed by server `message:created`; a queued `/turn` response renders only a compact queued status until that event arrives. On reload, `GetPendingTurnJobs()` reads `/api/session/:id/turn-queue` and restores a queued/running pending job by `turnId`.

## Bridge listener pattern

The SSE bridge layer ([packages/web-ui/src/bridge/sseClient.ts](../../packages/web-ui/src/bridge/sseClient.ts)) opens an `EventSource` against `/api/session/:id/stream` and registers per-event listeners. Durable GUI event replay and normalized envelope mapping live in [packages/web-ui/src/bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts). Each listener:

1. Parses `e.data` JSON via `parseEvent<T>(e)`.
2. Optionally normalises naming (e.g. `npc_id` → `npcId`).
3. Calls `__emit('<bus event name>', payload)` to publish to the in-process bus.

Pattern:

```ts
source.addEventListener('gui:event', e => {
  const data = parseEvent<GuiEventEnvelope>(e);
  if (!data) return;
  __emit('system:event', {
    id: String(data.eventId),
    type: data.type,
    ts: Date.parse(data.createdAt),
    payload: data.payload,
    turnId: data.turnId,
    messageId: data.messageId,
  });
});
```

GE-1 — outbox-routed events fan out as exactly one normalized `gui:event` SSE per released `gui_events` row. The legacy per-type duplicate (`session?.sse.emit(type, legacyPayload, …)`) was removed from `guiEventOutbox.ts`, so the per-type listeners in `sseClient.ts` only see direct, non-outbox SSE channels (`content`, `narrate`, `player:moved`, `dialogue:participants_updated`, `runtime:field`, `inventory:changed`, `currency:changed`, etc.). For `quest:changed`, the normalized envelope handler in `eventTimeline.ts` invokes a side-effect helper (`dispatchQuestChanged`) that fires the `window` `quest:changed` event the quest panel listens for, then returns without producing an `EventCard`. For the catalog of card types, see `SYSTEM_EVENT_TYPES` in [packages/web-ui/src/bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts) — they all flow through the **`system:event` aggregator**.

Some events bypass the aggregator and get their own bus channel:
- `dice:rolled` — also fires `dice:rolled` on the bus so `DiceBubble` can show the live dice immediately.
- `runtime:field` — fires `runtime:field` on the bus; `useRuntimeFields` subscribes for reactive reads.
- `mode:changed` — has its own dedupe (only fires when `mode !== lastMode`) before going to `system:event`.
- `dialogue:engaged` / `dialogue:participants_updated` — partner events are
  deduped by focused partner id; participant updates are the canonical source
  for shared-chat banners and companion continuity.

## system:event aggregator

The aggregator is the canonical channel for everything that becomes an EventCard. The payload shape:

```ts
{
  id: string,        // server eventId when available, used as React key
  eventId?: number,  // durable gui_events.id identity
  releaseSeq?: number | null, // visible release order
  type: SystemEventType,
  ts: number,        // server-created time when available
  payload: object,   // raw event data from server
  turnId?: string,
  messageId?: number,
}
```

App.tsx subscribes to `system:event` and pushes each onto `messages` as a card-typed entry. `MessageFlow.tsx` renders each `messages[i]` and dispatches to `EventCard.tsx` based on `type`.

Why one channel for many event types: every system event gets the same "permanent card pinned to a turn" lifecycle. The ordering source is the server envelope (`releaseSeq`, `eventId`, `turnId`, `messageId`, `turnIndex`, `phase`), not local arrival time or the current message count.

`useSseSubscriptions` and `MessageFlow` use the shared `compareSystemEvents` helper. It sorts by `releaseSeq`, then `eventId`, then local timestamp for legacy events. The fixture at [packages/web-ui/src/components/chat/eventOrdering.fixture.ts](../../packages/web-ui/src/components/chat/eventOrdering.fixture.ts) feeds out-of-arrival-order replay envelopes and asserts render order follows server release order.

The dedupe on `mode:changed` and focused dialogue partner changes is at the
bridge level, not the aggregator — the aggregator's job is to *render whatever
it gets*. Bridge filters first.

## per-event flow examples

### memory:added

1. Server: `add_memory` tool fires through the GUI outbox; after GE-1 it emits the normalized `gui:event` envelope only (no duplicate legacy `memory:added` SSE), with the same durable `eventId` as the underlying `gui_events` row.
2. Bridge: `sseClient.ts` / `eventTimeline.ts` dedupe by `eventId` and pumps one `system:event` with `type: 'memory:added'`.
3. App.tsx: `useSseSubscriptions` callback pushes a card-message onto `messages` using server ordering metadata.
4. MessageFlow: renders `EventCard variant="memory:added"`.
5. EventCard: shows the NPC's portrait + first-person memo + salience badge.

### dice:rolled

1. Server: `dice_check` tool fires; emits `dice:rolled` SSE with full payload.
2. Bridge: emits BOTH `dice:rolled` (for the live DiceBubble) AND `system:event:dice:rolled` (for the card).
3. `DiceBubble` (subscribed via `useEffect(() => EventsOn('dice:rolled', cb))`) animates the physics dice immediately.
4. App.tsx accumulates a card-message (same path as memory).
5. MessageFlow renders the EventCard with the resolved outcome.

The two-channel flow is intentional: the live dice need to fire BEFORE the card lands so the player sees the die rolling, then the card appears with the verdict.

### mode:changed

1. Server: classifier resolves a transition; emits `mode:changed` with `{mode, prev}`.
2. Bridge: `lastMode` dedupe — drops if mode === lastMode. Otherwise updates `lastMode` and pumps to `system:event`.
3. App.tsx: pushes card-message.
4. MessageFlow renders the mode banner card with prev → next styling.
5. Atmosphere layer ALSO subscribes (via `useRuntimeFields` or directly) and cross-fades the page tint.

### runtime:field

1. Server: `set_runtime_field` / transition engine; emits `runtime:field` with `{owner, field_key, value}`.
2. Bridge: emits `runtime:field` directly (no aggregator).
3. `useRuntimeFields` subscribes; updates an internal `Map<key, value>` and triggers re-renders for components reading that key.
4. Atmosphere uses it to track `world_time_minutes` and apply the right time-of-day gradient.
5. `string:changed` (a separate event) drives the per-NPC mood pulse via `useMoodPulse`.

`runtime:field` is a finer-grained channel than `system:event` — high-frequency updates that don't deserve EventCards but do drive UI atmosphere.

### turn.start / content / narrate / turn.end

The streaming-bubble lifecycle:

1. `POST /turn` returns `{turnId, queueId, queued, visible, position, blockedByTurnId}`. If `visible=false`, App.tsx shows only the queued-status strip; no user bubble is appended.
2. `turn.start` → bridge marks the queued job as running once the server promotes it.
3. `message:created` with `tone:'player'` commits the player bubble using server `messageId`, `turnIndex`, and rendered text.
4. `content` deltas → bridge translates to `turn:token` (legacy Wails name); `StreamingTokens` appends.
5. Eventually `narrate` SSE lands → bridge finalises the assistant bubble with author, tone, full text.
6. `turn.end` → bridge translates to `turn:stream_done`; composer un-locks. Job moves to terminal state; `WaitForTurnJob` resolves.

The streaming bubble is *transient* — it flips into a permanent `messages[]` entry once `narrate` fires. If the model JSON-dumps args (synth-fallback), bridge sees `synthesised: true` on the narrate payload and renders a single content delta instead of the streamed pattern.

Reload behavior: after `GetGameState()` restores persisted messages, App.tsx calls `GetPendingTurnJobs()`. If the server reports a queued or running turn, the UI restores `pendingJob`, keeps the composer busy, and waits through the same `WaitForTurnJob(turnId)` path used by freshly submitted turns.

## Sources

- [packages/web-ui/src/bridge/sseClient.ts](../../packages/web-ui/src/bridge/sseClient.ts) - live SSE listeners and turn stream handling
- [packages/web-ui/src/bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts) - `SYSTEM_EVENT_TYPES`, replay, dedupe, and event envelope mapping
- [packages/web-ui/src/bridge/runtime.ts](../../packages/web-ui/src/bridge/runtime.ts) — `EventsOn` / `EventsEmit` / `__emit`
- [packages/web-ui/src/hooks/useSseSubscriptions.ts](../../packages/web-ui/src/hooks/useSseSubscriptions.ts) — high-level subscriber that drives App.tsx state
