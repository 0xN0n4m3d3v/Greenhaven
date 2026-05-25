# State mutation contract

Greenhaven is server-state-as-canon. Every DB write that changes
durable game state — `chat_messages`, `entities`, `runtime_values`,
`player_quests`, `adventure_queue`, etc. — is the source of truth.
The web UI mirrors that state through SSE events. A client that
receives an SSE event for a row that later rolls back is wrong: the
UI now shows state the server never committed.

This document defines the contract that keeps server canon and SSE
in lockstep, and the tooling that enforces it.

## Two kinds of SSE events

We split server-side `.sse.emit(...)` calls into two categories:

1. **State-changing events.** Their existence implies that a
   specific DB row was written. Examples:
   - `message:created` — a `chat_messages` row was inserted.
   - `runtime:field` — a `runtime_values` row changed.
   - `gui:event` / `dialogue:engaged` / `dialogue:participants_updated` —
     a player/quest/dialogue row changed.
   - `inventory:changed`, `currency:changed`, `quest:changed`,
     `cartridge:steward_rejected`, `reward:calibrator_override`,
     `devils_bargain.resolved`.

   **Rule.** A state-changing emit MUST happen after the
   corresponding transaction commits. If the row rolls back, the UI
   must never see the event.

2. **Lifecycle / streaming / dev / debug events.** These describe
   the *control plane*, not durable state. Examples:
   - `turn.start` / `turn.tier` / `turn.end` / `turn.timeout` —
     turn-lifecycle markers the UI uses to flip the queued job into
     "running" / "done" / "timed out". They are not DB writes.
   - `content` / `narrate` streaming chunks — partial broker /
     narrator output emitted mid-tool-loop.
   - `tool.request` / `tool.result` — broker tool execution stream.
   - `cancelled` / `reset` — turn / session control plane.
   - `player:message_rendered` — UI marker that the broker's user
     prompt has been composed; the chat row isn't committed yet.
   - Debug raw emit (`POST /api/debug/sse`) — devtool echo.
   - `ambient:bed` — UI ambient bed change; world clock + mode
     transitions, not a DB write.

   **Rule.** A lifecycle/streaming/dev/debug emit may fire outside
   a transaction. It must carry a `// SSE-OK: emit outside tx (reason:
   <one-line reason>)` comment on the line(s) immediately above the
   `.sse.emit(...)` call, so a future reader knows why this site is
   exempt.

## Enforcement: `SseBridge.emit(...)` auto-defers

`packages/web-server/src/sseBridge.ts`'s `emit(event, data, id?)`
method checks `onTransactionCommit(...)`:

```ts
emit(event: string, data: unknown, id?: string): void {
  const payload: SseEvent = {event, data, id};
  if (onTransactionCommit(() => this.emitNow(payload))) {
    return;
  }
  this.emitNow(payload);
}
```

If the call site is inside a `withTransaction(...)` block, the emit
is registered as a commit hook and only fires after COMMIT; on
rollback the hook is dropped. If the call site is outside any
transaction, the emit fires immediately. See
[`docs/backend/transactions.md`](transactions.md) for how the
commit-hook scoping interacts with nested savepoints (ARCH-16): a
nested-success emit fires only after the outer COMMIT; a
nested-failure emit's hook is dropped by `ROLLBACK TO SAVEPOINT`.

This means **most state-changing emit sites already get the right
behavior automatically** as long as the surrounding DB write is in a
transaction. The contract is:

- **Wrap the DB write in `withTransaction(...)`**, then call
  `session.sse.emit(...)` for the state-changing event from inside
  that block. The bridge defers the emit to commit.
- **For sensitive paths** (e.g. multi-row writes where rollback
  semantics need to be obvious at the call site), use explicit
  `onTransactionCommit(() => session.sse.emit(...))`. This is the
  pattern in `turn/phases/PlayerMessagePersistencePhase.ts` for the
  `message:created` + `turn.player_message.persisted` events.

## Enforcement

Every direct `.sse.emit(...)` call inside `packages/web-server/src` must be
reviewed against this contract. State-changing emits belong inside the
transactional path; lifecycle, streaming, and dev/debug emits need a local
`// SSE-OK: emit outside tx (reason: ...)` comment that explains why no
commit barrier is needed.

## How to handle a new SSE emit

1. Decide which category the event falls into:
   - **State-changing** → wrap the surrounding DB write in
     `withTransaction(...)`. The bridge will auto-defer the emit.
     For an extra-explicit call site, use
     `onTransactionCommit(() => session.sse.emit(...))`.
   - **Lifecycle / streaming / dev / debug** → add an
     `// SSE-OK: emit outside tx (reason: ...)` comment above the
     emit so the lint rule accepts it.
2. Run the focused backend tests or smoke for the touched path, then inspect
   any new direct emit with `rg -n "\.sse\.emit" packages/web-server/src`.

## Why the comment text matters

The reason string is the only artifact that survives code review.
Future readers should not have to re-derive whether a given emit is
safe to fire outside a transaction. Write a *one-line specific*
reason, not a generic "lifecycle":

- Bad: `// SSE-OK: lifecycle`
- Bad: `// SSE-OK: emit outside tx`
- Good: `// SSE-OK: emit outside tx (reason: turn lifecycle marker, not DB state-change)`
- Good: `// SSE-OK: emit outside tx (reason: SseBridge.emit auto-defers via onTransactionCommit when inside withTransaction(...))`

## Out of scope

This contract covers `.sse.emit(...)` only. Other transaction +
canon concerns (queue ingestion atomicity in `DEEP-8`, post-turn
finalization, cartridge-importer multi-row writes) are tracked
separately in `critique-report/fixspecs/IMPLEMENTATION_MASTER_PLAN.md`.
