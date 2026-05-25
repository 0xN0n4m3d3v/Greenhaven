# SSE event catalog

Every visible state change in Greenhaven flows through the per-session SSE channel at `GET /api/session/:id/stream`. The frontend translates each event into chat content, a system EventCard, or a runtime-bus signal.

The canonical client-side card list is `SYSTEM_EVENT_TYPES` in [packages/web-ui/src/bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts). Chat-visible system cards should route through [packages/web-server/src/guiEventOutbox.ts](../../packages/web-server/src/guiEventOutbox.ts): the helper writes `gui_events`, emits the legacy event name, and also emits normalized `gui:event` with the durable `gui_events.id` as the SSE id.

Three families:

- **Stream control.** `turn.start`, `turn.end`, `turn.error`, `content`, `cancelled`, `narrate` drive the chat bubble lifecycle.
- **System event cards.** Listed in `SYSTEM_EVENT_TYPES`; every one becomes a persistent EventCard in chat and is replayable through the GUI outbox.
- **State/rail and debug events.** `runtime:field`, `inventory:changed`, `currency:changed`, `player:moved`, `ambient:bed`, `reset`, debug events, and tool trace events can remain direct SSE because they refresh sidebars, rails, or developer tooling rather than chat cards.

## GUI outbox and replay

Spec 81 introduced `gui_events` as the durable ordering layer for chat-visible system cards. A row carries `eventId`, `sessionId`, `playerId`, `turnId`, `turnIndex`, `lane`, `phase`, `type`, optional `messageId`, `displayPolicy`, `payload`, and `createdAt`.

The bridge listens to both the legacy event name and `gui:event`. Outbox-routed legacy payloads include `eventId`, `sessionId`, `turnId`, `turnIndex`, `messageId`, `lane`, and `phase`; the bridge dedupes by `eventId`.

Replay endpoint:

`GET /api/session/:id/events?after=<eventId>&limit=200`

The frontend calls it on bootstrap and replays released envelopes in ascending `eventId` order. Token deltas remain volatile and are not persisted as `gui_events`.

## Stream Control

### turn.start

Emitted at the top of `runTurn`. Payload: `{turnId, text, actionId?}`. Frontend uses it to flip the input into submitting state and start a turn-job entry.

### turn.end

Emitted in `.finally` of `startTurnV2`. Payload: `{turnId, messageId, durationMs}`. Frontend flips the turn into terminal state and drains waiters. Always fires, even on error.

### turn.error

Outbox-routed support card when the run rejects. Payload: `{message, stack?, cause?}` plus outbox metadata. `message` is player-friendly; `cause` carries the raw upstream error.

### content

Streaming narrator/scene-painter prose. Payload: `{turnId, streamSeq, delta}`. The frontend appends `delta` only to that turn's accumulated text. Synth fallback can emit a single full-text delta when the model output had to be cleaned.

### narrate

Fired by [packages/web-server/src/tools/narrate.ts](../../packages/web-server/src/tools/narrate.ts) when the narrator's `narrate` tool persists a bubble. Payload: `{turnId, messageId, turnIndex, author, authorId, tone, mentions}`. The frontend finalizes the visible bubble with the real server message id.

## System Cards

All events in this section are expected to go through `emitGuiEvent` / `emitGuiEventForSession` and therefore have durable `eventId` plus normalized `gui:event` replay.

### memory:added

Fired by `add_memory`. Payload: `{memoryId, ownerId, ownerName, aboutId, aboutName, text, importance, tags, sensitive}`.

### memory:enriched

Fired by NPC Voice Engine after post-turn memory enrichment. Payload: `{memoryId, ownerId, ownerName, voiced_text, internal_reflection?, links_to_memory_id?, link_reason?}`.

### quest:created / quest:started / quest:advanced / quest:completed

Fired by quest tools and quest engine transitions. These carry quest ids, titles, stages, outcome, and reward details as appropriate.

### quest:auto_advanced

Fired by Quest Watcher when it successfully applies a deterministic post-turn quest transition. Payload: `{quest_id, to_stage?, completed?, outcome?, reason, agent}`. Routed with `phase:'post_turn'`.

### quest:choice_required

Fired when a quest stage needs an explicit player choice. Payload includes quest title/id and options.

### dice:rolled

Fired by `dice_check` and scripted action resolvers. Payload: `{turnId, d, roll, modifier, total, dc?, outcome?, label?, roller, category?, position?, effect?}`.

### damage:dealt

Fired by `damage`. Payload: `{targetId, targetName, targetKind, amount, hpBefore, hpAfter, hpMax, defeated, damageType?, source?, condition?}`.

### xp:awarded / xp:levelup

Fired by `award_xp`. Payload includes player id, amount/reason/total, or new/previous level.

### string:changed

Fired by `string_award`. Payload: `{npcId, npcName, delta, newValue, band, reason}`.

### inspiration:gained / inspiration:spent

Fired by inspiration tools. Payload includes player id, amount/remaining, reason, and spend target.

### mode:changed / dialogue:engaged / dialogue:noticed / dialogue:partner_switched

Fired by the mode classifier, directive parser, mention/dialogue routes, and dialogue tool paths. Dialogue participant rail updates still use `dialogue:participants_updated` direct SSE because the banner state is not a chat card.

### sex_move:fired / intimacy:trigger

Fired by quest/intimacy systems when scripted intimate state changes happen.

### entity:revealed / entity:duplicate_warning

Fired by quest/entity creation and Catalogue Scout. Duplicate warnings are post-turn advisory cards.

### movement:teleport_detected

Fired by Movement Warden when prose appears to move the player without a `move_player` mutation. Advisory card only.

### companion:added / companion:removed / companion:auto_departed / npc:moved_with_player

Fired by companion tools, Companion Depart Engine, and `move_player` companion auto-follow.

### quest_pacer:overload / quest_pacer:stale / quest_pacer:dead_npc_arc

Fired by Quest Pacer post-turn advisory checks.

### adventure:oracle_rolled

Fired by Adventure Oracle after a deterministic post-turn roll queues an
adventure opportunity. Payload includes `{queueId, adventureKind, tableId,
seed, sequence, roll, die, totalWeight, source, status}`. Spec 89 only queues
metadata; later specs materialize and present player-facing hooks.

### adventure:hook / adventure:accepted / adventure:ignored / adventure:expired

Adventure hook cards are emitted by the materializer through the post-turn
presentation scheduler after a queued opportunity becomes a validated ready
blueprint. Payload includes `{queueId, playerId, adventureKind, title, summary,
playerFacingHook, danger, rewardHint, status, source, sequence, seed,
acceptUrl, ignoreUrl}`.

`adventure:accepted` is emitted after the ready blueprint has been applied
through existing tools. The preferred chat-card path submits a normal turn with
`actionId=adventure.accept:<queueId>`, which accepts the exact queue row before
broker/narrator continuation so the NPC/world can answer immediately. The
fallback player route `POST /api/player/:id/adventures/:queueId/accept` remains
available for non-chat surfaces. Quest/entity tool events remain normal
`gui_events` rows in the same replay stream. The web bridge also raises a local
`adventure:changed` browser event after adventure GUI events and route actions
so current-state rails can refresh without adding new chat entries.

`adventure:ignored` is emitted only when a hook was already visible. The
preferred chat-card path submits `actionId=adventure.ignore:<queueId>`, cancels
the same queue row, records baseline refusal evidence/consequence, and lets the
normal continuation produce a proportional NPC/world reaction. Ignoring a
non-visible row still marks it cancelled but does not create a chat card.
`adventure:expired` is emitted only for visible hooks whose deterministic turn
TTL elapsed before acceptance.

### npc:initiative

Fired before an NPC agency synthetic turn.

### narrate:quarantined

Visible support card when unsafe or technical narration was withheld from chat history. Payload includes `reason`, optional `author`, and `turnId`; the raw quarantined text is not displayed.

### post_turn:slot_failed

Visible support card from the Spec 86 post-turn slot registry when a chat-visible post-turn hook throws or misses its slot deadline. Payload includes `slotId`, `slotKey`, `hookName`, `status`, `reason`, and `deadlineMs`.

## Direct Non-Card Events

- `runtime:field`, `inventory:changed`, `currency:changed`: update state rails.
- `player:moved`: triggers location/sidebar refresh.
- `dialogue:participants_updated`: updates the dialogue banner/participants state.
- `ambient:bed`: switches audio bed.
- `turn.start`, `turn.end`, `message:created`, `player:message_rendered`, `tool.request`, `tool.result`, `cancelled`, `reset`, debug synth events: lifecycle or developer tooling.

## Presentation Barrier

Spec 82 foundation adds an in-memory post-turn presentation barrier. After `turn.end`, post-turn hooks still run in parallel. Spec 83 changed `POST /api/session/:id/turn` from a temporary rejection into a hidden ingress queue:

```json
{
  "turnId": "turn-...",
  "queueId": 123,
  "queued": true,
  "visible": false,
  "position": 1,
  "blockedByTurnId": "turn-..."
}
```

Queued turns do not create a player `chat_messages` row, do not emit a player bubble, and do not start model/tool work until the older visible turn's barrier closes or expires. When promoted, `message:created` commits the player bubble with the server `messageId`, `turnIndex`, `turnId`, and visible text.

The frontend rehydrates pending work with `GET /api/session/:id/turn-queue?playerId=<id>`. The response includes active turn id, barrier state, queue depth, oldest queued age, stuck rows, and queued/starting/running row snapshots; `history=1` includes terminal rows for diagnostics.

Spec 86 adds post-turn presentation slots to the same endpoint as `presentationSlots[]`. These are `gui_events` rows with `event_type='presentation:slot'`; they are hidden from replay but expose slot key, hook name, ordinal, barrier mode, status, reason, emitted event ids, age, and expiry time for support tooling.

## Sources

- [packages/web-ui/src/bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts) - `SYSTEM_EVENT_TYPES`, replay, and event-id dedupe.
- [packages/web-ui/src/bridge/sseClient.ts](../../packages/web-ui/src/bridge/sseClient.ts) - live SSE listeners and turn stream handling.
- [packages/web-server/src/guiEventOutbox.ts](../../packages/web-server/src/guiEventOutbox.ts) - durable GUI envelope writer/replay reader.
- [packages/web-server/src/turnIngressQueue.ts](../../packages/web-server/src/turnIngressQueue.ts) - hidden player input queue and promotion helper.
- [packages/web-server/src/sseBridge.ts](../../packages/web-server/src/sseBridge.ts) - server-side SSE pub-sub.
