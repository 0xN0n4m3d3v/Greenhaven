# PGlite ↔ Postgres compatibility notes

Greenhaven runs against two backends:

- **Managed Postgres** when `DATABASE_URL` is set (production, staging).
- **PGlite** (Postgres-compatible WASM build) when `DATABASE_URL` is
  unset (developer machines, CI, every test that uses
  `packages/web-server/src/__tests__/migrations/framework.ts` or
  `setupTurnTestEnvironment`).

Most SQL works identically on both. The notes below pin behaviour
that has historically been a source of subtle bugs or that critique-
report fixspecs ask to verify against PGlite specifically. Each
section links to the regression that locks the behavior in.

## `nextval(...)` inside conditional SQL is lazy (GE-2)

Greenhaven's GUI outbox (`packages/web-server/src/guiEventOutbox.ts`)
assigns `gui_events.release_seq` through `nextval(...)` wrapped in
`CASE WHEN <bool> THEN nextval('gui_events_release_seq') ELSE NULL END`
and `COALESCE(<prior>, ..., nextval('gui_events_release_seq'))`. The
contract Greenhaven needs is the standard Postgres semantics: the
`nextval` call must fire only when its arm of the expression is
actually selected; a non-taken branch must not consume a sequence
value. Otherwise pending / deferred / unreleased rows would silently
burn `release_seq` values that no `gui:event` SSE ever surfaces,
creating gaps in replay order.

`nextval` is documented as `VOLATILE` in PostgreSQL, but the planner
is still allowed to short-circuit conditional evaluation when the
controlling expression resolves to `false`. PGlite's WASM build has
historically diverged on subtle volatile-function semantics, so the
fixspec asked for a focused regression instead of trusting parity.

**Result of the GE-2 audit (2026-05-15):** PGlite matches Postgres on
both production-relevant forms. The regression suite
`packages/web-server/src/__tests__/migrations/sequences.test.ts`
covers:

- `SELECT CASE WHEN false THEN nextval('test_seq') ELSE NULL END` →
  the immediately-following `SELECT nextval('test_seq')` returns the
  start value, proving the non-taken branch did not consume.
- `SELECT CASE WHEN false THEN COALESCE(NULL, NULL, nextval('test_seq')) ELSE NULL END`
  → same lazy behaviour through `COALESCE`.
- `SELECT COALESCE(<prior>, nextval('test_seq'))` with a non-null
  `<prior>` → `nextval` is not evaluated.
- `SELECT CASE WHEN true THEN nextval('test_seq') ELSE NULL END` →
  consumes exactly one sequence value.
- Mixed-row INSERTs against a synthetic table: three `pending` rows
  with the production-shape `CASE` evaluate to `NULL`; the next
  released row receives `nextval('test_seq') = 1`.
- The real `gui_events_release_seq`: a `pending` insert through the
  outbox INSERT shape does not advance the sequence (measured as a
  delta against a baseline reading, so migration-template state
  cannot mask eager consumption); a `released` insert receives
  `baseline + 1`; a mixed batch of three pending plus one released
  insert advances the sequence by exactly one.

Because PGlite is compatible, `guiEventOutbox.ts` keeps its
conditional `nextval` SQL unchanged. If a future PGlite release
regresses on volatile-function laziness, the test above will fail
the build and the file can be refactored to issue an explicit
post-insert `UPDATE ... SET release_seq = nextval(...)` for newly
released rows. Until then, the conditional form remains the
simpler, lock-free expression.
