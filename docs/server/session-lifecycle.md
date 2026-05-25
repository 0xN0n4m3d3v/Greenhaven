# Session Lifecycle And Auto-Resume

A session is the live server container for one player's SSE bridge, lazy-built provider clients, and active turn handle. The durable row in `sessions` is now owner-bound through `sessions.player_id`; chat, tool audit rows, and telemetry reference the session id.

Session ids are opaque `TEXT` strings. The server mints UUID strings for new
sessions, but support fixtures, imports, and explicit client-provided ids do not
need to be valid UUIDs.

Frontend handshake:

1. `POST /api/session`
2. `GET /api/session/:id/stream`
3. `GET /api/session/:id/turn-queue`
4. `POST /api/session/:id/turn`

Turn submission is now queue-backed. `POST /api/session/:id/turn` writes a `turn_ingress_queue` row first. If the session has no active turn and no open presentation barrier, the row is promoted immediately and becomes visible. If the previous turn is still active or its post-turn presentation barrier is open, the row remains hidden: no `chat_messages` row, no model request, and no visible player bubble until promotion.

Source files:

- [routes/session.ts](../../packages/web-server/src/routes/session.ts)
- [sessionManager.ts](../../packages/web-server/src/sessionManager.ts)
- [sseBridge.ts](../../packages/web-server/src/sseBridge.ts)

## Ownership

All session routes run behind `requireAuth`. With auth enabled, `playerId` comes from the verified `gh_player` HMAC cookie. With `AUTH_DISABLED=1`, handlers accept an explicit body/query `playerId` for local development only.

`SessionManager.getOrCreate(sessionId, playerId)` is the only route path for creating or resuming a session. It:

- inserts new `sessions` rows with `player_id`;
- allows same-owner resume;
- adopts a legacy null-owner session only when existing `chat_messages.player_id`, player-authored chat rows, and tool audit rows do not indicate another player;
- rejects cross-player access with `SessionOwnershipError`, surfaced by routes as `403 {error:"session_forbidden"}`.

For existing live sessions, route handlers call `requireOwnedSession()` in [routes/session.ts](../../packages/web-server/src/routes/session.ts) before touching the `Session` object. This covers stream, state, messages, locations, turn, reset, cancel, model changes, dialogue, debug emit, and delete.

## POST /api/session

Resolution order:

1. `body.sessionId`: resume that exact id if the authenticated player owns it.
2. Auto-resume: if no id is provided, query both `chat_messages` and `tool_invocations` for the player's most recent session activity, filtered by compatible `sessions.player_id`.
3. Mint a fresh UUID.

Response: `{sessionId, state}` where `state` is `session.snapshot()` and includes `playerId`, `cwd`, readiness, and model ids.

## SSE Stream

`GET /api/session/:id/stream` checks ownership before opening the long-lived Hono `streamSSE` channel. Events are emitted through the per-session `SseBridge`.

Key behavior:

- Pre-subscribe buffer queues up to 200 events while there are no subscribers, then drains into the next subscriber.
- Multiple subscribers per owned session are supported.
- A heartbeat comment keeps the connection alive.
- `rateLimitSse()` is applied at the route level.

## Auto-Resume Data

Session id auto-resume and chat history rehydration are separate:

- `POST /api/session` resolves the session id from owned chat/tool activity.
- `GET /api/session/:id/messages` returns persisted `chat_messages`, sorted by `turn_index ASC, id ASC`, capped at 500.
- `GET /api/session/:id/locations` returns the authenticated player's current location plus visible exits.
- `GET /api/session/:id/turn-queue` returns queued/starting/running turn rows so the frontend can restore a pending job after reload without creating a duplicate player bubble.

The frontend still persists `greenhaven.sessionId` in localStorage, but reload recovery no longer depends on localStorage alone.

## Debug Emit

`POST /api/session/:id/_debug/emit` is not available by default. It returns 404 unless:

- `GREENHAVEN_DEBUG_SSE=1`
- `NODE_ENV !== "production"`

When enabled, it still requires owned-session lookup before emitting.

## Disposal

`SessionManager` keeps live sessions in `Map<string, Session>`. A janitor sweeps idle sessions every 30 minutes.

A session is idle when all are true:

- more than 2 hours since `lastActivityAt`;
- no live SSE subscribers;
- no `activeTurn`.

`DELETE /api/session/:id` can also dispose a live session, but only after owned-session lookup succeeds.

Per-turn lifecycle:

- `POST /api/session/:id/turn` returns `{turnId, queueId, queued, visible, position, blockedByTurnId}`.
- `GET /api/session/:id/turn-queue` returns `{activeTurnId, barrier, maxQueued, depth, queuedDepth, oldestQueuedAgeMs, stuckRows, presentationSlots, rows}` for rehydration and diagnostics.
- `startTurnV2(session, input)` still rejects if called directly while `session.activeTurn` exists; the route avoids this by promoting one queued row at a time.
- `activeTurn.abortController` is used by `POST /api/session/:id/cancel`.
- Turn cleanup clears `activeTurn` in `finally`.
- `activeTurn.toolHistory`, `narrativeBuffer`, and `pendingBargain` remain available to post-turn hooks while the turn is active.
- The post-turn presentation barrier promotes the next `turn_ingress_queue` row after all post-turn hooks settle or the barrier expires.
