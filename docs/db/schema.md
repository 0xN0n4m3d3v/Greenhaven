# Database schema reference

Greenhaven uses Postgres (or PGlite — both speak the same wire protocol). All schema is owned by ordered migrations in [packages/web-server/migrations/](../../packages/web-server/migrations/) — see [server/db-and-migrations.md](../server/db-and-migrations.md) for the runner and full migration index.

This page is the table-by-table reference. Each section lists key columns, constraints, and *intent* — what the table is FOR, not just what's in it.

## entities

The polymorphic core. Every "thing" in the world — NPCs, locations, scenes, items, quests, classes, skills, factions, even the world itself — lives here. Defined at [packages/web-server/migrations/0001_cartridge.sql:25-39](../../packages/web-server/migrations/0001_cartridge.sql#L25-L39).

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | PK |
| `kind` | `TEXT` | `'person' \| 'location' \| 'scene' \| 'item' \| 'quest' \| 'event' \| 'district' \| 'service' \| 'thread' \| 'world' \| 'class' \| 'skill'` |
| `display_name` | `TEXT` | canonical English form; `@`-mention key |
| `summary` | `TEXT` | short brief, surfaced into preamble |
| `profile` | `JSONB` | kind-specific bag — speech_style, persona, sex_move, depart_when, stages (for quests), exits (for locations), etc. |
| `tags` | `TEXT[]` | fast-search side-channel; `gin(tags)` index |
| `i18n` | `JSONB` | added by 0017 — per-language translations for `display_name`, `summary`, `profile.text` fields |
| `created_at` / `updated_at` | `TIMESTAMPTZ` |  |

`display_name` is a canonical runtime mention key. `entities.i18n.display_name`
may exist for coverage, but every language value must repeat the base
`display_name`; localized prose belongs in `summary` and profile text fields.

Indexes on `kind`, `tags`, and `profile jsonb_path_ops`. Reserved id ranges in seed: locations 100-199, NPCs 200-299, items 300-399, quests 700-799 (set by `0003_seed_quickgrin.sql` + `0004_sequence_fix.sql`).

## players

A player is an entity with a row here. Splitting from `entities` lets us index/normalise progression columns. Defined at [packages/web-server/migrations/0002_litrpg.sql:40-59](../../packages/web-server/migrations/0002_litrpg.sql#L40-L59).

| Column | Type | Notes |
|---|---|---|
| `entity_id` | `BIGINT` | PK; FK → `entities.id` |
| `public_id` | `UUID` | stable identity; client persists in localStorage |
| `recovery_code_hash` | `TEXT` | bcrypt; shown ONCE at signup |
| `class_id` | `BIGINT` | FK → entities (`kind='class'`) |
| `current_xp`, `current_level` | `BIGINT`, `INT` | progression |
| `current_hp`, `max_hp` | `INT` | combat |
| `current_location_id`, `current_scene_id` | `BIGINT` | FK → entities |
| `dialogue_partner_id` | `BIGINT` | spec 7; canonical "who am I talking to" |
| `metadata` | `JSONB` | `companions[]`, `dialogue_anchor`, `quest_pacer`, etc. |
| `preferred_language` | `TEXT` | added later; auto-mirror fallback |

Schema accumulates: `password_hash` (auth), `dialogue_partner_id` (0007), `companions` overlay (specs 52+53), `metadata.dialogue_anchor` (spec 45), `metadata.quest_pacer` (spec 49) all live in `metadata` JSONB or as added columns.

## chat_messages

Every visible chat bubble + every player input line. Defined at [packages/web-server/migrations/0001_cartridge.sql:133-148](../../packages/web-server/migrations/0001_cartridge.sql#L133-L148).

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | PK |
| `session_id` | `TEXT` | FK → `sessions.id` |
| `author_entity_id` | `BIGINT` | FK → entities; can be NULL for system bubbles |
| `tone` | `TEXT` | `'player' \| 'npc' \| 'system' \| 'narrator'` |
| `text` | `TEXT` | the visible prose |
| `turn_index` | `INT` | monotone within a session |
| `payload` | `JSONB` | `turn_id`, `done`, `synthesised`, dice info, etc. |
| `player_id` | `BIGINT` | spec 38 follow-up — added so per-player rehydration works |

Indexes on `(session_id, turn_index)` and `author_entity_id`. `GET /api/session/:id/messages` reads it for spec 55 chat rehydration.

## tool_invocations

Every AI tool call. Defined at [packages/web-server/migrations/0002_litrpg.sql](../../packages/web-server/migrations/0002_litrpg.sql).

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | PK |
| `session_id` | `TEXT` | FK → sessions |
| `player_id` | `BIGINT` | FK → entities |
| `turn_id` | `TEXT` | groups one user message |
| `tool_name` | `TEXT` | as registered |
| `args` | `JSONB` | validated args (or raw on validation failure) |
| `result` | `JSONB` | executor return value |
| `error` | `TEXT` | error message; `'rejected: <reason>'` for pre-tool rejections |
| `duration_ms` | `INT` |  |
| `invoked_at` | `TIMESTAMPTZ` |  |

Indexed by `(session_id, invoked_at)` and `(player_id, invoked_at DESC)`. Read by spec 22 quest evaluator and `/api/debug/tools`.

## turn_telemetry

Per-(turn, role) cost + latency. Defined at [packages/web-server/migrations/0015_turn_telemetry.sql](../../packages/web-server/migrations/0015_turn_telemetry.sql), with `session_id` aligned to text by [0051_turn_telemetry_session_id_text.sql](../../packages/web-server/migrations/0051_turn_telemetry_session_id_text.sql).

| Column | Type | Notes |
|---|---|---|
| `id`, `session_id`, `turn_id` | `BIGSERIAL`, `TEXT`, `TEXT` | composite key (logical); session ids are opaque text |
| `role` | `TEXT` | `'broker' \| 'narrator' \| 'narrator-scripted' \| 'narrator-scene-painter' \| 'narrator-painter-fallback' \| 'agent:<name>'` |
| `model_id`, `thinking` |  | which model, thinking on/off |
| `input_tokens`, `output_tokens`, `cache_hit_tokens`, `cache_miss_tokens` | `INT` | broken out for cache-hit-rate analysis |
| `duration_ms`, `cost_usd` | `INT`, `NUMERIC(12,8)` | cost computed at insert time |
| `tier` | `TEXT` | T0..T4 from classifier |
| `player_id` | `BIGINT` | added by 0016 |

`/api/debug/cost` aggregates over this table.

## telemetry lake

Local-first observability tables defined at [packages/web-server/migrations/0061_local_telemetry_lake.sql](../../packages/web-server/migrations/0061_local_telemetry_lake.sql). These tables correlate runtime traces, game/product events, metrics, artifacts, and quality/eval scores without requiring a remote telemetry service.

| Table | Intent |
|---|---|
| `telemetry_sessions` | App/play/debug session envelope: build, cartridge, save, platform, consent, retention attributes. |
| `telemetry_spans` | OpenTelemetry-compatible causal spans keyed by `trace_id/span_id`, with `session_id`, `player_id`, `turn_id`, `event_id`, `release_seq`, duration, status, attributes, events, links, and redaction tier. |
| `telemetry_events` | Versioned gameplay/product/error/quality events with schema name/version and validated properties. |
| `telemetry_metrics` | Raw or rolled-up counters/gauges/histograms for latency, memory, queue depth, tokens, frontend long tasks, etc. |
| `telemetry_artifacts` | Index of local trace/profile/replay/netlog/crash/screenshot files. The files themselves live in the desktop data directory. |
| `telemetry_eval_scores` | LLM/game-quality scores attached to traces/spans/turns. |

`performance_events` from Spec 104 are mirrored into `telemetry_spans` by [packages/web-server/src/performanceTelemetry.ts](../../packages/web-server/src/performanceTelemetry.ts). The frontend writes sanitized local batches through `POST /api/telemetry/frontend`; Electron writes desktop batches through `POST /api/telemetry/desktop`. Managed artifact files are stored under the desktop data root at `telemetry/artifacts/` and indexed in `telemetry_artifacts`; developer JSONL/OTLP exports are stored under `telemetry/artifacts/exports/` when `telemetry:export -- --write` is used. `/api/debug/telemetry/*`, `npm --prefix packages/web-server run telemetry:report`, and `npm --prefix packages/web-server run telemetry:export` read the new tables.

## npc_memories

Long-term memories owned by NPCs. Defined at [packages/web-server/migrations/0001_cartridge.sql:160-183](../../packages/web-server/migrations/0001_cartridge.sql#L160-L183).

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | PK |
| `owner_entity_id` | `BIGINT` | FK → entities; the NPC remembering |
| `about_entity_id` | `BIGINT` | FK → entities; optional subject |
| `text` | `TEXT` | first-person memory prose |
| `importance` | `REAL` | 0..1 |
| `tags` | `TEXT[]` |  |
| `embedding` | `vector(768)` | optional ANN; HNSW index |
| `salience` | `REAL` | added by 0035; ranking score, computed from importance, bumped on reference |
| `metadata` | `JSONB` | `voiced_by`, `draft_text`, `internal_reflection`, `links_to_memory_id` |

Spec 43 NPC Voice Engine post-writes voice + reflection here.

## runtime_fields

Schema declarations for the live state-machine. Each row says "this entity has a field of this name + type, default value, scope". Defined at [packages/web-server/migrations/0001_cartridge.sql:46-62](../../packages/web-server/migrations/0001_cartridge.sql#L46-L62).

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` | PK |
| `owner_entity_id` | `BIGINT` | FK → entities |
| `field_key` | `TEXT` | unique within owner |
| `value_type` | `TEXT` | `'int' \| 'float' \| 'bool' \| 'string' \| 'enum' \| 'entity_ref' \| 'json' \| 'dice'` |
| `default_value`, `allowed_values` | `JSONB` | |
| `scope` | `TEXT` | `'turn' \| 'scene' \| 'session' \| 'journey' \| 'permanent'` |
| `scope_per_player` | `BOOL` | added by 0002; if true, writes hit `runtime_player_overlay` |
| `description` | `TEXT` |  |

## runtime_values

Current value for each field. Global / shared across players. Defined at [packages/web-server/migrations/0001_cartridge.sql:68-75](../../packages/web-server/migrations/0001_cartridge.sql#L68-L75).

| Column | Type | Notes |
|---|---|---|
| `field_id` | `BIGINT` | PK; FK → runtime_fields |
| `value` | `JSONB` | one row per declared field |
| `updated_at` | `TIMESTAMPTZ` |  |
| `source` | `TEXT` | `'cartridge_seed' \| 'transition' \| 'tool_apply' \| 'manual'` |

## runtime_player_overlay

Per-player overlay for fields with `scope_per_player=true`. Defined at [packages/web-server/migrations/0002_litrpg.sql:23-33](../../packages/web-server/migrations/0002_litrpg.sql#L23-L33).

| Column | Type | Notes |
|---|---|---|
| `field_id`, `player_id` | `BIGINT` | composite PK |
| `value` | `JSONB` |  |
| `updated_at`, `source` |  |  |

Readers union `runtime_values` + `runtime_player_overlay`; overlay wins. See [runtime-fields.md](runtime-fields.md).

## player_quests

Per-player quest state. Defined at [packages/web-server/migrations/0002_litrpg.sql](../../packages/web-server/migrations/0002_litrpg.sql).

| Column | Type | Notes |
|---|---|---|
| `player_id`, `quest_entity_id` | `BIGINT` | composite PK |
| `status` | `TEXT` | `'unseen' \| 'offered' \| 'active' \| 'completed' \| 'failed'` |
| `current_stage_id` | `TEXT` | spec 21; matches `entities[id=quest_entity_id].profile.stages[].id` |
| `accumulated_state` | `JSONB` | scratchpad — `pending_choice`, branch trackers |
| `path_taken` | `JSONB` | array of `{stage_id, at}` |
| `started_at`, `completed_at` | `TIMESTAMPTZ` |  |

Quest body schema lives on the quest entity's `profile` (stages, objectives, rewards). See [quest-schema.md](quest-schema.md).

## inventory_entries

Legacy generic inventory: holder × item × count. Defined at [packages/web-server/migrations/0001_cartridge.sql:81-87](../../packages/web-server/migrations/0001_cartridge.sql#L81-L87).

| Column | Type | Notes |
|---|---|---|
| `holder_entity_id`, `item_entity_id` | `BIGINT` | composite PK |
| `count` | `INT` | `>= 0` enforced |
| `metadata` | `JSONB` |  |

Spec 35 introduced a richer `items` + `player_inventory` pair; spec follow-up (mig 0046) consolidates and back-fills. New tools target `items`/`player_inventory`; legacy `inventory_entries` stays for entity-to-entity transfers (NPC inventories, container inventories). See [inventory.md](inventory.md).

## save_slots

Spec 36 §4. 5 named slots + 1 quicksave (auto on death). Defined at [packages/web-server/migrations/0042_save_slots.sql](../../packages/web-server/migrations/0042_save_slots.sql).

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL` | PK |
| `player_id` | `BIGINT` | FK → entities |
| `slot_name` | `TEXT` | UNIQUE per player |
| `is_auto` | `BOOL` | true for quicksave |
| `snapshot` | `JSONB` | spans `entities` / `runtime_values` / `npc_memories` / `player_inventory` / `player_quests` + last 200 `chat_messages` with watermark id |
| `size_bytes` | `INT` |  |

Snapshot semantics live in [packages/web-server/src/routes/saves.ts](../../packages/web-server/src/routes/saves.ts). See [ops/reset-and-seed.md](../ops/reset-and-seed.md).

## Sources

- [packages/web-server/migrations/0001_cartridge.sql](../../packages/web-server/migrations/0001_cartridge.sql) — entities, runtime_fields, runtime_values, inventory_entries, transitions, sessions, chat_messages, npc_memories, schema_migrations
- [packages/web-server/migrations/0002_litrpg.sql](../../packages/web-server/migrations/0002_litrpg.sql) — players, runtime_player_overlay, player_stats/skills/equipment, player_xp_log, player_quests, tool_invocations
- [packages/web-server/migrations/0015_turn_telemetry.sql](../../packages/web-server/migrations/0015_turn_telemetry.sql)
- [packages/web-server/migrations/0061_local_telemetry_lake.sql](../../packages/web-server/migrations/0061_local_telemetry_lake.sql)
- [packages/web-server/migrations/0029_quest_schema.sql](../../packages/web-server/migrations/0029_quest_schema.sql)
- [packages/web-server/migrations/0042_save_slots.sql](../../packages/web-server/migrations/0042_save_slots.sql)
- [packages/web-server/migrations/0046_inventory_consolidation.sql](../../packages/web-server/migrations/0046_inventory_consolidation.sql)
