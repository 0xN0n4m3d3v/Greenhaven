# Reset & save slots

`POST /api/debug/reset-world` wipes all player-derived state without touching cartridge content. `save_slots` snapshots are the in-game persistence layer. Plus a dozen `/api/debug/*` endpoints.

## reset-world

Endpoint: `POST /api/debug/reset-world`. Route: [packages/web-server/src/index.ts](../../packages/web-server/src/index.ts). Reset logic: [packages/web-server/src/resetWorld.ts](../../packages/web-server/src/resetWorld.ts).

What it wipes (inside one transaction):
- `chat_messages`, `tool_invocations`, `turn_telemetry`
- `performance_events` and all local telemetry lake rows:
  `telemetry_sessions`, `telemetry_spans`, `telemetry_events`,
  `telemetry_metrics`, `telemetry_artifacts`, `telemetry_eval_scores`
- Managed telemetry artifact files under `telemetry/artifacts/` for the reset
  session/world.
- `npc_memories`
- `runtime_player_overlay`
- `player_quests`, `player_xp_log`, `player_stats`, `player_skills`, `player_equipment`
- `faction_reputation`, `dice_check_cooldowns`
- Inventory rows held by players (`DELETE FROM inventory_entries WHERE holder_entity_id IN (SELECT entity_id FROM players)`)
- `sessions`, `players`, plus the `entities` rows where `kind='player'`
- Runtime-authored dynamic entities where `tags` contains `dynamic` or `profile.origin == "dynamic"`, plus transitions that point to those dynamic entities.

What it preserves:
- All cartridge content: static `entities` (locations, NPCs, items, scenes, quests, classes, skills, factions), `transitions`, `entity_instructions`, `runtime_fields`, `npc_stats`, `cartridge_meta`.
- Migrations table (`schema_migrations`) — schema isn't re-run.
- Runtime values that aren't player-overridden.

After the wipe:
- `npc_stats.current` is rolled back to `base` (clears any in-play drift like applied debuffs).
- Cartridge-specific re-seeds run: `cartridge_meta.reset_inventory_seeds[]` upserts inventory rows, `cartridge_meta.reset_runtime_overrides[]` writes runtime_values. Both default to empty so cartridges that don't ship them get the generic wipe.
- `sessionManager.destroyAll()` drops every in-memory session.
- Response includes `dynamic_entities_removed` and a matching `counts` row named `entities (dynamic removed)`.

The UI must clear local browser identity and reload to bootstrap from scratch. Use `ClearLocalClientStorage({keepPreferences: true})` from the web bridge when the reset is initiated from the frontend; it removes `greenhaven.playerPublicId` and `greenhaven.sessionId` together while preserving language/audio/model preferences. If a manual server-side reset happens while the browser is already open, the next `/player/me` `404` also clears stale identity and rebuilds the bridge.

## save_slots

Defined at [packages/web-server/migrations/0042_save_slots.sql](../../packages/web-server/migrations/0042_save_slots.sql). 5 named slots + 1 `quicksave` (auto on `combat_state='dead'`, spec 35).

Implementation: [packages/web-server/src/routes/saves.ts](../../packages/web-server/src/routes/saves.ts). Snapshot is one JSONB blob.

Snapshot shape:
```ts
{
  schema_version: 1,
  player_id: number,
  taken_at: ISO8601,
  runtime_values: [{field_id, value}, ...],   // per-player overlay rows
  npc_memories: [...],                         // memories about this player
  player_inventory: [...],
  player_quests: [...],
  player_stats: [...],
  player_proficient_skills: [...],
  chat_message_watermark: number               // max chat_messages.id at snapshot
}
```

**Restore semantics.** On load, all rows for the player are wiped + re-inserted from the snapshot, AND `chat_messages.id > watermark` are deleted to rewind the conversation. We deliberately don't snapshot entire chat_messages history — table can be huge.

**Auto-quicksave** on death: `quicksaveOnDeath(playerId)` ([packages/web-server/src/routes/saves.ts:50](../../packages/web-server/src/routes/saves.ts#L50)) is called by the death-flow tools. The slot is named `'quicksave'`, `is_auto=true`. Re-saves overwrite.

Player-facing routes (mounted under `/api/player`):
- `POST /api/player/saves` — create/overwrite a named slot.
- `GET /api/player/saves` — list slots with `created_at` and `size_bytes`.
- `POST /api/player/saves/:slot/load` — restore.
- `DELETE /api/player/saves/:slot` — delete.

## debug endpoints catalog

All under `/api/debug/*`. Mounted by [packages/web-server/src/index.ts](../../packages/web-server/src/index.ts).

Access contract:

- In development, debug routes are available by default.
- In production, debug routes return `404` unless `GREENHAVEN_DEBUG_ROUTES=1`.
- If `GREENHAVEN_DEBUG_KEY` is set, callers must send `x-debug-key: <value>`.
- `GET /api/db/tables` uses the same debug guard.
- `GET /api/admin/usage` requires `x-admin-key: <ADMIN_KEY>` when `ADMIN_KEY` is set, and fails closed in production if `ADMIN_KEY` is missing.

| Endpoint | What it does |
|---|---|
| `POST /api/debug/reset-world` | Generic wipe + cartridge reseeds (above). |
| `POST /api/debug/clear-dialogue-partner` | Sets `players.dialogue_partner_id = NULL`. |
| `POST /api/debug/synth-event` | Manually push a fake SSE event into a session for plumbing tests. |
| `POST /api/debug/run-combat-director` | Invoke Combat Director out-of-band; returns the briefing JSON. |
| `POST /api/debug/run-movement-warden` | Run the Warden against a (text, current_location_id) pair. |
| `POST /api/debug/run-dialogue-anchor` | Run Dialogue Anchor end-to-end. |
| `POST /api/debug/run-scene-painter` | Direct narrator call through Scene Painter. |
| `POST /api/debug/run-npc-voice` | Run Voice Engine against a memory id or draft. |
| `POST /api/debug/run-catalogue-scout` | Force similarity scan + LLM verdict. |
| `POST /api/debug/run-intimacy-coordinator` | Run Coordinator with a fixed input. |
| `POST /api/debug/run-quest-watcher` | Re-run Quest Watcher against a tool history. |
| `POST /api/debug/run-reward-calibrator` | Re-run Calibrator. |
| `POST /api/debug/run-cartridge-steward` | Run Steward against a candidate spawn. |
| `POST /api/debug/run-quest-pacer` | Force Pacer evaluation. |
| `POST /api/debug/verify-specialists` | Live verification harness — calls every specialist with a curated input, returns pass/fail per specialist. See [verification-harness.md](verification-harness.md). |
| `GET /api/debug/session-messages-diag` | Server-owned session transcript summary with `flagged_messages` contamination flags. |
| `GET /api/debug/telemetry/summary` | Local telemetry lake summary: health, slow spans, event counts, recent traces. |
| `GET /api/debug/telemetry/turn/:turnId` | All telemetry tied to a turn id. |
| `GET /api/debug/telemetry/trace/:traceId` | Full local trace slice. |
| `GET /api/debug/recent-entities` | List recently-created entities. |
| `GET /api/debug/tools` | Recent `tool_invocations` audit log. |
| `GET /api/debug/session-diag` | Full session diagnostic — `activeTurn`, providers, SSE subscriber count, last 50 invocations, last 50 chat messages. |
| `GET /api/debug/cost` | Aggregate `turn_telemetry` by role + day. See [cost-and-telemetry.md](cost-and-telemetry.md). |
| `GET /api/admin/usage` | Per-player usage admin: total tokens, total cost, last seen. |

Most debug endpoints are **dev-only**. Keep `GREENHAVEN_DEBUG_ROUTES` off in shared or production deployments unless an operator explicitly needs the live diagnostic surface.

For live PGlite sessions, prefer `GET /api/debug/session-messages-diag?sessionId=<id>&limit=80` over direct `db-query`. The endpoint is server-owned and returns compact `transcript` plus `flagged_messages` with JSON fence, broker handoff, and narrate-args flags without opening a second PGlite connection.

## Sources

- [packages/web-server/src/index.ts](../../packages/web-server/src/index.ts) — `/api/debug/*` mounts
- [packages/web-server/src/resetWorld.ts](../../packages/web-server/src/resetWorld.ts) — `reset-world` implementation
- [packages/web-server/src/routes/saves.ts](../../packages/web-server/src/routes/saves.ts) — save/load semantics
- [packages/web-server/migrations/0042_save_slots.sql](../../packages/web-server/migrations/0042_save_slots.sql) — schema
