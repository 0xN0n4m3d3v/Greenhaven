# Support Smoke

Single-command post-65 support check for cross-layer invariants. It creates a
temporary PGlite database by default, runs migrations, seeds a small fixture,
executes the checks, emits JSON, and cleans up the temp data directory.

## Commands

From the repository root after build:

```sh
npm --prefix packages/web-server run build
node packages/web-server/dist/scripts/support-smoke.js
```

From `packages/web-server`:

```sh
node dist/scripts/support-smoke.js
```

Source wrapper:

```sh
npm --prefix packages/web-server exec -- tsx --env-file=.env src/scripts/support-smoke.ts
```

Options:

- `--keep-temp` keeps the generated `.tmp/greenhaven-support-smoke-*` database
  and includes `tempDataDir` in JSON.
- `--existing-db` uses the current `DATABASE_URL` / `PGLITE_DATA_DIR`; this is
  not the default support path.
- `--fixture broken` intentionally appends a failing check so callers can verify
  non-zero exit handling.

## JSON Shape

```json
{
  "ok": true,
  "checks": [{ "name": "atomic_batch_rollback_db_state", "status": "pass" }]
}
```

`status` is `pass`, `fail`, or `skipped`. Exit code is `0` only when every
non-skipped check passes.

## Checks

- Atomic batch rollback does not commit DB state.
- Transactional SSE buffering does not emit rolled-back child events.
- Successful batch emits post-commit child events.
- Successful batch records child tool history for post-turn hooks.
- Runtime field writers emit final `runtime:field` state for direct writes,
  surface appends, and condition/surface decay.
- Catalogue Scout extraction sees `create_quest.spawned` maps.
- Non-UUID session id telemetry insert succeeds.
- Frontend telemetry ingestion writes event/span/metric rows.
- Desktop telemetry ingestion writes event/span/artifact rows.
- Telemetry diagnostic bundle reconstructs recent traces and canonical counts.
- Telemetry retention deletes old rows and managed artifact files.
- Developer telemetry export writes JSONL/OTLP artifacts and blocks remote OTLP
  by default.
- Cartridge validator still passes on the support fixture database.
- Multi-NPC dialogue participants remain persisted and rendered in turn
  context.
- Ordered queue replay, adventure queue phase checks, actor/resource grounding,
  reset lifecycle, cartridge i18n/runtime checks, and finalization guardrails
  are also covered by the current smoke suite.

## Current Caveat

The support smoke suite is intentionally broad and sometimes exposes unrelated
in-progress guardrail regressions before a feature pass starts. If the command
fails, inspect the JSON and separate:

- checks tied to the current task;
- known unrelated guardrail failures, often around `create_quest`,
  `create_entity`, broker prompt ownership, or world-fact finalization;
- fixture failures caused by running against an existing dev database instead
  of the default temporary database.

Do not report the whole suite as passed unless `ok:true`. It is acceptable to
quote a specific passing check, such as `multi_npc_dialogue_participants`, when
the overall suite is red for unrelated reasons.

## Sources

- [packages/web-server/src/devtools/supportSmoke.ts](../../packages/web-server/src/devtools/supportSmoke.ts)
- [packages/web-server/src/scripts/support-smoke.ts](../../packages/web-server/src/scripts/support-smoke.ts)
- [packages/web-server/plans/execution-roadmap/specs/70-support-smoke-runner.md](../../packages/web-server/plans/execution-roadmap/specs/70-support-smoke-runner.md)
