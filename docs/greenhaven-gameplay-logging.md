# Greenhaven Gameplay Logging

Greenhaven now writes an append-only JSONL gameplay log for debugging real play sessions.

## Files

Default directory:

```text
logs/gameplay/
```

Files written per event:

- `all.jsonl` - every gameplay event across all players and sessions.
- `YYYY-MM-DD.jsonl` - daily slice.
- `player-<entityId>.jsonl` - every session for one player.
- `session-<sessionId>.jsonl` - one session timeline.

Override:

```text
GREENHAVEN_GAMEPLAY_LOG_DIR=C:\path\to\logs
GREENHAVEN_GAMEPLAY_LOG_MAX_STRING=60000
```

## Writer + rotation (DEEP-9)

All gameplay log writes flow through a single `GameplayLogWriter` instance (`packages/web-server/src/gameplayLog.ts`). The writer:

- Serialises every append through one promise chain so concurrent events never interleave inside a target file.
- Holds one open `WriteStream` per target file with `flags: 'a'`, so the per-write cost is one `stream.write(...)` instead of an `open`/`write`/`close` round trip.
- Rotates a target before re-opening when it crosses either rotation threshold. Rotation closes the open stream, renames the file in place to `<file>.YYYY-MM-DD.<epochMs>`, and the next write opens a fresh stream at the original path.

Defaults:

| Threshold | Default | Override |
| --- | --- | --- |
| Size | 50 MB (`50 * 1024 * 1024` bytes) | `new GameplayLogWriter({rotationSizeBytes})` |
| Age | 24 h (`24 * 60 * 60 * 1000` ms) | `new GameplayLogWriter({rotationMaxAgeMs})` |

The writer also `stat`s the file on first open so rotation accounts for bytes already present from a prior process run.

`appendGameplayLog(event)` stays awaitable: the returned `Promise<void>` resolves only after the underlying writes have either landed on disk or been caught + logged as `[gameplay-log] append failed:`. The ARCH-2 telemetry facade awaits this promise from inside its `gameplay` sink, so `telemetry.flush()` waits for gameplay sink writes to settle.

## Event Types

- `http.request`, `http.error`, `http.request.error`
- `session.ready`
- `location.snapshot`
- `turn.input`
- `turn.queued`
- `turn.start`
- `turn.player_message.persisted`
- `tool.invocation`
- `player.move`, `player.move.noop`
- `turn.output`
- `gui.event.stored`, `gui.event.released`
- `turn.failed`
- `turn.cancelled`
- `turn.finished`
- `process.uncaught_exception`
- `process.unhandled_rejection`

## Debugging Wrong Locations

Filter one session:

```powershell
Get-Content logs\gameplay\session-<sessionId>.jsonl |
  Select-String '"type":"location.snapshot"|"type":"player.move"|"type":"turn.input"|"type":"turn.output"'
```

What to compare:

- `turn.input.data.location_before`
- `player.move.data.from_id` / `to_id`
- `location.snapshot.data.current`
- `location.snapshot.data.exits`
- `turn.output.data.location_entity_id`

If the narrator describes a different place than `players.current_location_id`, the mismatch will be visible in the same session file.

## Content Readiness

Run:

```powershell
npm --prefix packages/web-server run content:readiness -- --fixture-mode temp --write
```

Outputs:

- `docs/greenhaven-demo-content-readiness-report.md`
- `docs/greenhaven-demo-content-readiness-report.json`

The report separates demo-ready content from high-confidence placeholders. Runtime filters hide placeholder/template NPCs, locations, quests and mention targets, while generated location refs remain visible when they are explicitly authored as exits.
