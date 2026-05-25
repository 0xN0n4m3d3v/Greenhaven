# Batch Mutation

`batch_mutate_world` is the high-power mutation wrapper added in spec 65. It
executes a short, allow-listed sequence of existing mutation tools through the
same tool boundary as standalone calls: Zod schema validation, argument
normalization, pre-tool validators, execution, and audit.

## Contract

Args:

```ts
{
  reason: string,
  atomic?: true,
  operations: [
    {
      id?: string,
      tool: string,
      args?: Record<string, unknown>,
      depends_on?: string[]
    }
  ]
}
```

Rules:

- `atomic=false` is currently rejected. All supported batches are atomic.
- `narrate`, read-only tools, and recursive `batch_mutate_world` calls are denied.
- Child operations execute in listed order. `depends_on` may reference only earlier operation ids.
- Each child operation writes its own `tool_invocations` audit row on successful batches.
- Failed atomic batches roll back child DB changes and child audit rows; the parent batch audit records the failure.

## Conflict Resolver

Before any child executes, `resolveBatchConflicts` checks for deterministic
conflicts:

- multiple writes to the same runtime field via `set_runtime_field` or `apply_runtime_field_patch`;
- multiple `move_player` operations targeting different locations;
- duplicate consumption of the same inventory source/item via `inventory_transfer`, `use_item`, or `give_to_npc`;
- `advance_quest` and `complete_quest` on the same quest in one batch.

The resolver is conservative. If a plan is ambiguous, reject and let the broker
split it into separate turns or a smaller batch.

## Transaction Boundary

`withTransaction` now carries a transaction-scoped query client through
AsyncLocalStorage. Existing tools that call the shared `query()` function
automatically participate in the parent transaction. Tools that open their own
`withTransaction()` reuse the active transaction instead of nesting `BEGIN`.
ARCH-16 (2026-05-15) makes that reuse safe: the nested call issues a
`SAVEPOINT`, so if the child throws and the batch handler catches the error,
only the child's writes roll back while earlier siblings remain committable.
See [`docs/backend/transactions.md`](../backend/transactions.md) for the full
nested-transaction contract.

SSE events emitted by child tools inside the transaction are buffered on the
transaction context. They flush only after `COMMIT` succeeds and are discarded
on rollback, so the UI cannot show XP, inventory, movement, quest, or memory
events for state that did not persist.

## Verification

Smoke coverage used for spec 65:

- compatible `award_xp` + `add_memory` batch commits both operations;
- invalid second child rolls back the first child;
- pre-tool validator rejection (`create_entity` missing location summary via Cartridge Steward) rolls back earlier children;
- conflicting movement batch rejects before location changes;
- duplicate inventory consumption rejects before item counts change;
- recursive batch call is denied.

## Sources

- [packages/web-server/src/tools/batchMutate.ts](../../packages/web-server/src/tools/batchMutate.ts)
- [packages/web-server/src/tools/conflictResolver.ts](../../packages/web-server/src/tools/conflictResolver.ts)
- [packages/web-server/src/db.ts](../../packages/web-server/src/db.ts)
