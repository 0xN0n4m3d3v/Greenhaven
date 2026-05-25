# Developer Diagnostics

Spec 62 adds CLI-only diagnostics for local development and future agent work. No HTTP routes were added.

Run commands from `packages/web-server` after `npm run build`, or use the matching source wrapper in `scripts/*.ts` with `tsx`.

## db-query

Read-only SQL with a conservative allow-list:

```sh
node dist/scripts/db-query.js "SELECT 1 AS ok"
node dist/scripts/db-query.js "SELECT id, display_name FROM entities ORDER BY id" --limit 25
```

Rules:

- Only `SELECT` and `WITH` are allowed.
- Multi-statement SQL is rejected.
- Mutating/admin tokens such as `UPDATE`, `DELETE`, `INSERT`, `ALTER`, `DROP`, and `CREATE` are rejected.
- Results are wrapped in an outer `LIMIT` and secret-like columns are redacted.

## state-snapshot

Capture player/session-scoped state:

```sh
node dist/scripts/state-snapshot.js --player-id 1132 --limit 50
node dist/scripts/state-snapshot.js --player-id 1132 --session-id <uuid> > before.json
```

Snapshot schema version: `1`.

Captured domains: player, sessions, chat messages, tool invocations, player inventory, legacy inventory entries, quests, runtime player overlay, stats, and skills.

## inspect-state-diff

Compare two snapshots:

```sh
node dist/scripts/inspect-state-diff.js before.json after.json
```

Output groups added, removed, and changed rows by domain, for example `player_inventory` when currency or items move.

## validate-cartridge

Validate cartridge references and tool-shaped data:

```sh
node dist/scripts/validate-cartridge.js --fixture-mode temp
node dist/scripts/validate-cartridge.js --fixture broken-exit
```

Checks include entity references, location exits, quest stage links, effect/tool references, item references, i18n shape, and `@mention` targets.

`--fixture broken-exit` creates a temporary PGlite database, injects an invalid exit id, and should return `broken_exit_ref`.

## support-smoke

Run the post-65 cross-layer support smoke suite:

```sh
node dist/scripts/support-smoke.js
node dist/scripts/support-smoke.js --fixture broken
```

By default this creates and cleans a temporary PGlite database under `.tmp`.
Checks cover batch rollback, transactional SSE buffering, committed batch child
tool history, Catalogue Scout spawned-map extraction, non-UUID telemetry ids,
and cartridge validation. See [support-smoke.md](support-smoke.md).

## telemetry developer export

Spec 105 adds local developer-mode telemetry export. It is off by default and
does not require any external service.

Write local JSONL and OTLP JSON artifacts:

```sh
npm --prefix packages/web-server run telemetry:export -- --minutes 60 --write --format jsonl,otlp
```

Post to a local OpenTelemetry Collector:

```sh
GREENHAVEN_TELEMETRY_OTLP_ENDPOINT=http://127.0.0.1:4318 \
  npm --prefix packages/web-server run telemetry:export -- --minutes 60 --post-otlp
```

Remote OTLP endpoints are blocked unless `--allow-remote` or
`GREENHAVEN_TELEMETRY_ALLOW_REMOTE_EXPORT=1` is set. Treat remote export as a
manual developer action for redacted datasets only.

Related commands:

```sh
npm --prefix packages/web-server run telemetry:bundle -- --write
npm --prefix packages/web-server run telemetry:retention -- --dry-run
npm --prefix packages/web-server run telemetry:report -- trace <traceId>
npm --prefix packages/web-server run telemetry:report -- turn <turnId>
```

## live playtest control plane

Spec 100 adds debug-only HTTP routes for adversarial runtime playtests. They are
mounted under `/api/debug/*` and use the existing debug route guard.

Snapshot a player/session:

```powershell
Invoke-RestMethod "http://127.0.0.1:7777/api/debug/live-state?playerId=1200&sessionId=<uuid>&limit=80"
```

Create a preset state:

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:7777/api/debug/live-preset" `
  -ContentType "application/json" `
  -Body '{"playerId":1200,"sessionId":"debug-live-001","preset":"quest_chain_wrong_order"}'
```

Use `docs/ops/live-playtest-grimoire.md` for the supported adversarial state
families: silent NPC follow, wrong-order quest chains, wrong item handoff,
conflicting same-giver quests, queued turn interruption, and replay probes.

Run a real model probe with UTF-8 player text:

```powershell
npm --prefix packages/web-server run live:probe -- `
  --player-id 1200 `
  --session-id debug-probe-wrong-order `
  --preset quest_chain_wrong_order
```

## generate-migration-snippet

Print SQL to stdout; never writes migration files:

```sh
node dist/scripts/generate-migration-snippet.js --file input.json
```

Example input:

```json
{
  "kind": "location",
  "display_name": "Spec 62 Test Room",
  "summary": "A generated diagnostic example.",
  "profile": {"exits": []},
  "tags": ["diagnostic"]
}
```

## Verification

- `npm --prefix packages/web-server run typecheck`
- `npm --prefix packages/web-server run build`
- `node dist/scripts/db-query.js "SELECT 1 AS ok"`
- `node dist/scripts/validate-cartridge.js --fixture-mode temp`
- `node dist/scripts/validate-cartridge.js --fixture broken-exit`
- `node dist/scripts/support-smoke.js`
- `npm --prefix packages/web-server run telemetry:export -- --minutes 60 --write`

## Sources

- [packages/web-server/src/devtools/dbQuery.ts](../../packages/web-server/src/devtools/dbQuery.ts)
- [packages/web-server/src/devtools/stateSnapshot.ts](../../packages/web-server/src/devtools/stateSnapshot.ts)
- [packages/web-server/src/devtools/validateCartridge.ts](../../packages/web-server/src/devtools/validateCartridge.ts)
- [packages/web-server/src/devtools/supportSmoke.ts](../../packages/web-server/src/devtools/supportSmoke.ts)
- [packages/web-server/src/devtools/telemetryDeveloperExport.ts](../../packages/web-server/src/devtools/telemetryDeveloperExport.ts)
- [packages/web-server/src/devtools/generateMigrationSnippet.ts](../../packages/web-server/src/devtools/generateMigrationSnippet.ts)
- [packages/web-server/src/devtools/livePlaytestControlPlane.ts](../../packages/web-server/src/devtools/livePlaytestControlPlane.ts)
- [packages/web-server/plans/execution-roadmap/specs/62-developer-diagnostic-tools.md](../../packages/web-server/plans/execution-roadmap/specs/62-developer-diagnostic-tools.md)
