# Transactions — `withTransaction()` contract

The Greenhaven server runs on a dual-backend SQL layer
(`packages/web-server/src/db.ts`): pg.Pool against managed Postgres
in production, PGlite in single-user dev. Both backends expose the
same `query()` / `withTransaction()` / commit-hook surface.

This document is the canonical contract for transaction nesting,
hook semantics, and the SQL primitives the layer issues. See
`docs/backend/state-mutation-contract.md` for the SSE-after-commit
rules that build on top of this.

## Outer transactions

```ts
await withTransaction(async (tx) => {
  await tx.query('INSERT INTO chat_messages …');
  await query('UPDATE players …');   // participates in the same tx
});
```

- The first `withTransaction()` on the call stack issues `BEGIN`,
  registers a `TransactionContext` in the `AsyncLocalStorage`
  transaction store, runs `fn`, then issues `COMMIT` on success or
  `ROLLBACK` on throw.
- `query(sql, params)` automatically routes through the active
  transaction's client when called from anywhere inside `fn` (the
  AsyncLocalStorage propagates across `await`).
- The transaction-scoped client (`tx`) and the implicit `query()`
  surface write to the same connection, so they share the same
  commit/rollback fate.
- The `AsyncLocalStorage` ensures every code path that runs inside
  `fn` — including nested helpers, post-turn pipeline calls, and
  agent hooks — observes the same transaction.

## Nested transactions (ARCH-16)

A `withTransaction()` call made while another `withTransaction()`
is already active does NOT open a second physical transaction. It
issues a `SAVEPOINT greenhaven_sp_<n>` on the existing connection
and scopes hook handling to that savepoint.

```ts
await withTransaction(async (outerTx) => {
  await outerTx.query("INSERT INTO tbl VALUES ('outer-before')");

  try {
    await withTransaction(async () => {
      await query("INSERT INTO tbl VALUES ('inner-doomed')");
      throw new Error('boom');         // rolls back to savepoint
    });
  } catch {
    /* swallow inner failure */
  }

  await outerTx.query("INSERT INTO tbl VALUES ('outer-after')");
});
// Result: ['outer-after', 'outer-before'] survive the COMMIT.
//   'inner-doomed' was rolled back to the savepoint.
```

The savepoint identifier is always the literal
`greenhaven_sp_<counter>` where `<counter>` is a per-outer-transaction
monotonic integer. The SQL is never user-controlled.

### Lifecycle

| Step | SQL issued | Notes |
| ---- | ---------- | ----- |
| Outer entry | `BEGIN` | once per top-level call |
| Outer success | `COMMIT` | commit hooks fire after |
| Outer failure | `ROLLBACK` | rollback hooks fire after |
| Nested entry | `SAVEPOINT greenhaven_sp_N` | reuses the outer connection |
| Nested success | `RELEASE SAVEPOINT greenhaven_sp_N` | nested writes still pending until outer commits |
| Nested failure | `ROLLBACK TO SAVEPOINT greenhaven_sp_N` then `RELEASE SAVEPOINT greenhaven_sp_N` | only the nested block's writes are undone |

### No independent inner commit

A nested `withTransaction()` cannot commit on its own. Its writes
become durable only when the outermost `withTransaction()` issues
its `COMMIT`. If the outer transaction rolls back, every nested
success's writes are lost too — that is the correct semantic for the
intent at registration time (the nested code asked to be atomic
with whatever larger transaction was on the stack).

## Commit hooks

`onTransactionCommit(fn)`:

- Returns `true` if there is an active transaction and the hook was
  registered. Returns `false` if there is no active transaction so
  the caller can decide to run `fn` synchronously instead.
- Hooks fire **once**, after the outermost `COMMIT`, in registration
  order.
- A commit hook registered inside a **successful** nested block
  stays in the outer context and fires at outer commit time.
- A commit hook registered inside a **failed** nested block is
  discarded by `ROLLBACK TO SAVEPOINT` — the writes it would have
  signalled rolled back, so the hook must not fire.
- Hook failures are logged and swallowed; one bad hook never
  prevents siblings from running.

## Rollback hooks

`onTransactionRollback(fn)`:

- Same return contract as `onTransactionCommit`.
- Hooks registered inside a **failed** nested block fire **once**
  immediately after `ROLLBACK TO SAVEPOINT`, and are removed from
  the outer context so the outer's eventual `ROLLBACK` does not
  re-fire them.
- Hooks registered inside a **successful** nested block stay in the
  outer context. They do not fire on `RELEASE SAVEPOINT`; they only
  fire if the outermost transaction rolls back. The contract reads
  "if this transaction rolls back, run me" — and "this transaction"
  is the outermost one whose commit makes the writes durable.

## Interaction with `state-mutation-contract.md` (USER-6)

`SseBridge.emit(...)` defers state-changing events via
`onTransactionCommit(...)` when called inside `withTransaction(...)`.
With ARCH-16 savepoint semantics:

- A nested-success emit's commit hook fires only after the outer
  `COMMIT`, so the UI never sees a row that depends on writes still
  in flight.
- A nested-failure emit's commit hook is dropped by the savepoint
  rollback — the UI never sees state from a block that rolled back.

The `// SSE-OK: emit outside tx (reason: ...)` escape hatch
documented in `state-mutation-contract.md` is unchanged.

## Test patterns

- Outer-only behavior: assert COMMIT/ROLLBACK of a single block
  using `query()` reads after the call.
- Nested savepoint behavior: use
  `src/__tests__/db/transactionNesting.test.ts` as the canonical
  pattern. Inserts before/inside/after the nested block plus
  `readLabels()` after the outer call prove which writes survived.
- Hook scoping: track an `events: string[]` array, register hooks
  inside outer and nested blocks, and assert the final order.

## Files

- `packages/web-server/src/db.ts` — `withTransaction()`, savepoint
  bridge, hook scoping.
- `packages/web-server/src/__tests__/db/transactionNesting.test.ts`
  — regression tests for the contract above.
- `docs/backend/state-mutation-contract.md` — SSE-after-commit rules
  that depend on this contract.
