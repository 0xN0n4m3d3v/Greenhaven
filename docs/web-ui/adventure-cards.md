# Adventure Cards

Adventure cards are server-owned `EventCard` variants. They reuse the existing
chat flow and `gui_events` replay path; there is no separate adventure timeline.

## Event Types

- `adventure:oracle_rolled` - optional deterministic oracle roll summary.
- `adventure:hook` - player-facing opportunity rendered in the chat as an
  NPC-style speech bubble when a quest giver/source NPC is known. Accept/ignore
  actions render as a small menu under that bubble.
- `adventure:accepted` - confirms the player accepted the opportunity and it
  entered the tracked world state.
- `adventure:ignored` - visible only when the player ignores a hook that was
  already shown.
- `adventure:expired` - visible status when a previously shown hook expires.

## Actions

Chat hook menus accept through the ordinary turn submission path:

- visible message: localized `ui.event_card.action.accept`;
- action id: `adventure.accept:<queueId>`.

This lets the backend accept the queued adventure and then run the normal
broker/narrator continuation, so the player sees the NPC/world generate the
quest opening immediately after clicking the menu action.

Chat hook menus also ignore through the ordinary turn submission path:

- visible message: localized `ui.event_card.action.ignore`;
- action id: `adventure.ignore:<queueId>`.

This lets the backend cancel the same queued hook and then run the normal
broker/narrator continuation for a proportional NPC/world reaction. The refused
hook must not materialize its quest or spawns. A chat-turn ignore always records
a baseline refusal consequence and requires a visible NPC reply when the hook
has a speaker; otherwise it requires a visible world/local reaction.

Non-chat fallback surfaces use the player routes:

- `POST /api/player/:id/adventures/:queueId/accept`
- `POST /api/player/:id/adventures/:queueId/ignore`

Accepting through either path refreshes quest state through the existing
`quest:changed` path. Ignoring cancels the queue row and records refusal
evidence; chat-turn ignores may also produce extra grounded memory/social
consequences through the normal broker tools.

The player may also accept a visible hook through ordinary prose. The backend
matches the text against ready hook metadata and then uses the same accept path
as the button, so the card state and world mutation stay replayable.

## Current Opportunities Rail

The left rail has a compact current-opportunities surface implemented by
`AdventureOpportunitiesRail`. It calls the same `GET /api/player/:id/adventures`
route as support tooling and shows only current `ready` queue rows for the
active player/session.

Accept and ignore buttons call the same routes as chat hook cards. The rail
refreshes after adventure GUI events and after route actions through the bridge
`adventure:changed` browser event, so it does not create another timeline or
post stale cards into chat.

## Anchoring

The bridge keeps a `turnId -> messageId` map from persisted messages, `narrate`,
and `turn.end`. Replayed adventure events use the server event id and release
sequence, then attach to the same turn/message anchor as live events. This
prevents late-generated hook cards from being inserted below newer chat.

## Source Files

- [packages/web-ui/src/components/chat/EventCard.tsx](../../packages/web-ui/src/components/chat/EventCard.tsx)
- [packages/web-ui/src/components/adventure/AdventureOpportunitiesRail.tsx](../../packages/web-ui/src/components/adventure/AdventureOpportunitiesRail.tsx)
- [packages/web-ui/src/bridge/api.ts](../../packages/web-ui/src/bridge/api.ts)
- [packages/web-server/src/routes/adventures.ts](../../packages/web-server/src/routes/adventures.ts)
