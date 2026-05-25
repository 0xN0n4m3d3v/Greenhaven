# Cost & telemetry

Every model call writes one row to `turn_telemetry`. `/api/debug/cost` aggregates. The override-reason audit catches Reward Calibrator deviations.

For broader local observability, Spec 105 adds the `telemetry_*` lake:
`telemetry_spans`, `telemetry_events`, `telemetry_metrics`,
`telemetry_artifacts`, and `telemetry_eval_scores`. `turn_telemetry` remains the
compact model-cost source, while `performance_events` are mirrored into
`telemetry_spans` for trace-style diagnostics.

The frontend sends sanitized local batches to `POST /api/telemetry/frontend`.
That endpoint accepts browser/app events, spans, and metrics such as app boot,
SSE lifecycle, turn submission, navigation/load timing, paint timing, long
tasks, and mirrored frontend warnings/errors. It writes into the same
`telemetry_events`, `telemetry_spans`, and `telemetry_metrics` tables; it does
not upload analytics to an external service.

Electron sends local desktop diagnostics to `POST /api/telemetry/desktop`:
backend startup, packaged asset validation, window/process lifecycle events,
desktop log artifact references, and on-demand netLog artifacts. Diagnostic
bundle files and managed artifacts live under `GreenHaven/telemetry/artifacts/`
inside the configured desktop data root.

## turn_telemetry schema

Defined at [packages/web-server/migrations/0015_turn_telemetry.sql](../../packages/web-server/migrations/0015_turn_telemetry.sql), with session id alignment in [0051_turn_telemetry_session_id_text.sql](../../packages/web-server/migrations/0051_turn_telemetry_session_id_text.sql). One row per (turn, role).

| Column | Type | Source |
|---|---|---|
| `id` | `BIGSERIAL` |  |
| `session_id` | `TEXT` | opaque session id generating the call; generated ids are UUID strings, but support/import ids may be non-UUID |
| `turn_id` | `TEXT` | `turn-<8 hex>` |
| `role` | `TEXT` | broker / narrator / narrator-scripted / narrator-scene-painter / narrator-painter-fallback / agent:&lt;name&gt; |
| `model_id` | `TEXT` | `'deepseek-v4-flash'`, `'TheDrummer/Cydonia-24B-v4.3'`, `'deepseek-chat'`, etc. |
| `thinking` | `BOOL` | true for DeepSeek V4 Pro thinking-on, false otherwise (Featherless and specialists) |
| `input_tokens`, `output_tokens` | `INT` | from `r.usage` |
| `cache_hit_tokens`, `cache_miss_tokens` | `INT` | broken out for prefix-cache-rate analysis |
| `duration_ms` | `INT` | wall-clock from request start to last token |
| `cost_usd` | `NUMERIC(12,8)` | computed at insert from token counts × per-model rate |
| `tier` | `TEXT` | `'T0'..'T4'` from classifier |
| `player_id` | `BIGINT` | added by 0016_telemetry_player; nullable for legacy rows |
| `recorded_at` | `TIMESTAMPTZ` |  |

Pricing constants live in [packages/web-server/src/ai/pricing.ts](../../packages/web-server/src/ai/pricing.ts) (broker/narrator) and inline in [packages/web-server/src/agents/base.ts](../../packages/web-server/src/agents/base.ts) (specialists, hard-coded `deepseek-chat` rate). Indexed by `(session_id, turn_id)` and `recorded_at DESC`. Treat `session_id` as opaque text in support SQL; do not cast it to UUID.

`recordTelemetry` ([packages/web-server/src/turnRunnerV2.ts:772](../../packages/web-server/src/turnRunnerV2.ts#L772)) inserts; failures log a warning and don't bring down the turn.

## /api/debug/cost

Defined at [packages/web-server/src/index.ts:1731](../../packages/web-server/src/index.ts#L1731).

Access: `/api/debug/cost` is under the shared debug guard. In production it returns `404` unless `GREENHAVEN_DEBUG_ROUTES=1`; if `GREENHAVEN_DEBUG_KEY` is set, callers must send `x-debug-key`.

`GET /api/debug/cost` returns a JSON aggregate:
```json
{
  "today": {
    "total_usd": 0.43,
    "by_role": {
      "broker": 0.15,
      "narrator": 0.21,
      "narrator-scene-painter": 0.04,
      "agent:combat_director": 0.01,
      ...
    },
    "by_model": { ... },
    "by_tier": {"T0": ..., "T2": ..., "T4": ...}
  },
  "last_7d": { ... },
  "last_30d": { ... },
  "tokens_total": ...,
  "cache_hit_rate": 0.62
}
```

Use to spot:
- **Specialist budget** — `by_role.LIKE 'agent:%'` should be ~10-15% of total. Higher means specialists are firing too often or running out of cache.
- **Tier mix** — `by_tier.T4` should be ~30-50% of turns; if it's 80%, the classifier is over-promoting (or the cartridge is heavily mutation-driven).
- **Cache hit rate** — broker should be ~60-80% on prefix-cache (mostly the system prompt + frame). Lower means the prefix is changing per turn.

`/api/admin/usage` ([packages/web-server/src/index.ts:1781](../../packages/web-server/src/index.ts#L1781)) is per-player breakdown — total tokens, total cost, last seen, recent turn count. Used for usage admin / billing. In production, `ADMIN_KEY` is required and callers must send `x-admin-key: <ADMIN_KEY>`.

## /api/debug/telemetry

Spec 105 debug endpoints expose the local telemetry lake as agent-readable JSON:

| Endpoint | What it returns |
|---|---|
| `GET /api/debug/telemetry/health` | Counts for spans/events/metrics/artifacts/eval rows and failures. |
| `GET /api/debug/telemetry/summary` | Health, slowest span groups, event counts, recent traces. |
| `GET /api/debug/telemetry/errors` | Failed spans plus warning/error/invalid events. |
| `GET /api/debug/telemetry/quality` | Quality events and eval scores. |
| `GET /api/debug/telemetry/trace/:traceId` | Full trace slice: spans, events, artifacts, eval scores. |
| `GET /api/debug/telemetry/turn/:turnId` | All telemetry tied to a player turn. |
| `POST /api/debug/telemetry/bundle` | Local JSON diagnostic bundle: summary, errors, quality, canonical coverage counts, redaction notes, and recent full traces. Add `?persist=1` to write and index a bundle file. |
| `POST /api/debug/telemetry/retention` | Applies local retention for telemetry rows and managed artifact files. Use `dryRun=true` to inspect first. |
| `POST /api/debug/telemetry/developer-export` | Developer-mode JSONL/OTLP export. Can write local artifacts and optionally POST to a local OTLP Collector. Remote endpoints are blocked unless explicitly allowed. |

Frontend ingestion:

| Endpoint | What it accepts |
|---|---|
| `POST /api/telemetry/frontend` | Sanitized local frontend batch: `context`, `events`, `spans`, and `metrics`. |
| `POST /api/telemetry/desktop` | Sanitized local Electron batch: `context`, `events`, `spans`, `metrics`, and `artifacts`. |

CLI equivalents:

```powershell
npm --prefix packages/web-server run telemetry:report -- --minutes 60
npm --prefix packages/web-server run telemetry:errors -- --minutes 60
npm --prefix packages/web-server run telemetry:quality -- --minutes 60
npm --prefix packages/web-server run telemetry:bundle -- --minutes 60
npm --prefix packages/web-server run telemetry:bundle -- --write
npm --prefix packages/web-server run telemetry:retention -- --dry-run
npm --prefix packages/web-server run telemetry:export -- --minutes 60 --write --format jsonl,otlp
npm --prefix packages/web-server run telemetry:export -- --minutes 60 --post-otlp --otlp-endpoint http://127.0.0.1:4318
npm --prefix packages/web-server run telemetry:report -- trace <traceId>
npm --prefix packages/web-server run telemetry:report -- turn <turnId>
```

## Telemetry roles

Comprehensive role list:

| Role | When |
|---|---|
| `broker` | T4 broker stage |
| `narrator` | T4 narrator stage; T1/T3 default narrator |
| `narrator-scripted` | T0 scripted-action narrator |
| `narrator-scene-painter` | T2 with Scene Painter |
| `narrator-painter-fallback` | T2 fell back to default narrator after Scene Painter failure |
| `agent:quest_watcher` | spec 39 |
| `agent:combat_director` | spec 40 |
| `agent:intimacy_coordinator` | spec 41 |
| `agent:catalogue_scout` | spec 42 (only on ambiguous-band LLM call) |
| `agent:npc_voice` | spec 43 (one per memory enriched) |
| `agent:dialogue_anchor` | spec 45 |
| `agent:movement_warden` | spec 46 / 51 (post-turn observer + pre-tool when LLM fires) |
| `agent:reward_calibrator` | spec 47 |
| `agent:cartridge_steward` | spec 48 (deterministic, manually written for activity audit; near-zero cost) |
| `agent:quest_pacer` | spec 49 (deterministic, manually written; near-zero cost) |
| `agent:voice_warden` | spec 54 / synth-fallback voice repair |

## reward:calibrator_override audit

Spec 47. Reward Calibrator emits *bands* (advisory). Broker can override any band but **must** pass `calibrator_override_reason='<why>'` on `award_xp`, `string_award`, `grant_inspiration`, `complete_quest` calls.

When such a tool call lands with a non-empty `calibrator_override_reason`, the engine emits a `reward:calibrator_override` SSE event with:
```json
{
  "tool": "award_xp",
  "args": {"player": 1, "amount": 250},
  "calibrator_band": {"min": 30, "max": 80},
  "override_reason": "Player completed an emotional sacrifice arc — arc_climax, not arc_beat",
  "ts": ...
}
```

The frontend renders an EventCard variant for transparency. Audit log lives in `tool_invocations` (every tool call already audited; the override_reason is in `args`) — to query overrides:

```sql
SELECT turn_id, tool_name, args, args->>'calibrator_override_reason' AS reason, args->>'amount' AS amount
  FROM tool_invocations
 WHERE args ? 'calibrator_override_reason'
   AND args->>'calibrator_override_reason' <> ''
 ORDER BY invoked_at DESC LIMIT 50;
```

Patterns to watch:
- Frequent overrides on `award_xp` for `arc_climax` while Calibrator was suggesting `scene_beat` → cartridge tier configured wrong (set `reward_tier='generous'` if your campaign is meant to be high-XP).
- Overrides without a clear reason (broker writes "n/a" or "needed more") → broker prompt may need emphasis on the reason field.

The whole point of the override pattern: don't lock the broker out of judgement, but make every deviation auditable.

## Sources

- [packages/web-server/migrations/0015_turn_telemetry.sql](../../packages/web-server/migrations/0015_turn_telemetry.sql) — `turn_telemetry` schema
- [packages/web-server/migrations/0016_telemetry_player.sql](../../packages/web-server/migrations/0016_telemetry_player.sql) — player_id column
- [packages/web-server/migrations/0051_turn_telemetry_session_id_text.sql](../../packages/web-server/migrations/0051_turn_telemetry_session_id_text.sql) — text session id alignment
- [packages/web-server/src/agents/base.ts](../../packages/web-server/src/agents/base.ts) — `recordAgentTelemetry` for specialist rows
- [packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts) — `recordTelemetry` for broker/narrator rows
- [packages/web-server/src/index.ts](../../packages/web-server/src/index.ts) — `/api/debug/cost`, `/api/admin/usage`
