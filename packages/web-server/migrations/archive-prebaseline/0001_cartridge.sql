-- 0001_cartridge.sql — initial cartridge / world schema.
--
-- Design principle: the cartridge IS the world. Entities (people,
-- locations, scenes, items, quests, events) are uniformly modelled in
-- one polymorphic table; everything else hangs off entity ids. This
-- mirrors Grinhaven's existing schema (docs/cli/INTERNALS.md, §2 of
-- prompt-and-patch.md in Grinhaven) so the cartridge port is mostly a
-- data dump, not a redesign.
--
-- The vector extension is required for the npc_memories ANN search.

CREATE EXTENSION IF NOT EXISTS vector;
-- Note: we deliberately do NOT request pg_trgm here. PGlite (the
-- in-process WASM Postgres we use for local dev) doesn't ship trigram
-- support yet. Real Postgres deployments can `CREATE EXTENSION pg_trgm`
-- in a follow-up migration if/when full-text-on-name search becomes a
-- bottleneck.

-- ── Entities ───────────────────────────────────────────────────────────
-- Polymorphic. `kind` = 'person' | 'location' | 'scene' | 'item' |
-- 'quest' | 'event' | 'district' | 'service' | 'thread'. The free-form
-- `profile` JSONB carries kind-specific metadata (species, narrator
-- briefs, archetype, …). `tags` is a fast-search side-channel.

CREATE TABLE IF NOT EXISTS entities (
    id            BIGSERIAL PRIMARY KEY,
    kind          TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    summary       TEXT,
    profile       JSONB NOT NULL DEFAULT '{}'::jsonb,
    tags          TEXT[] NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_tags ON entities USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_entities_profile ON entities USING gin(profile jsonb_path_ops);
-- (idx_entities_name_trgm dropped — needs pg_trgm; see note at top.)

-- ── Runtime field declarations ─────────────────────────────────────────
-- Schema for the live state-machine. Each row says "this entity has a
-- field of this name + type, default value, scope". Values live in
-- runtime_values below.

CREATE TABLE IF NOT EXISTS runtime_fields (
    id              BIGSERIAL PRIMARY KEY,
    owner_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    field_key       TEXT   NOT NULL,
    -- Mirrors Grinhaven's value_type taxonomy.
    value_type      TEXT   NOT NULL CHECK (value_type IN
                       ('int','float','bool','string','enum',
                        'entity_ref','json','dice')),
    default_value   JSONB,
    allowed_values  JSONB,
    scope           TEXT   NOT NULL DEFAULT 'session' CHECK (scope IN
                       ('turn','scene','session','journey','permanent')),
    description     TEXT,
    UNIQUE (owner_entity_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_runtime_fields_owner ON runtime_fields(owner_entity_id);

-- ── Runtime values ─────────────────────────────────────────────────────
-- Current value for each field. One row per declared field; INSERT on
-- first-use, UPDATE thereafter.

CREATE TABLE IF NOT EXISTS runtime_values (
    field_id    BIGINT PRIMARY KEY REFERENCES runtime_fields(id) ON DELETE CASCADE,
    value       JSONB  NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Source of the last write — useful for telemetry. 'cartridge_seed',
    -- 'transition', 'tool_apply', 'manual', etc.
    source      TEXT
);

-- ── Inventory ──────────────────────────────────────────────────────────
-- Who carries what. Counts >= 0 enforced; negatives are caught at
-- write-time so the world never has -3 gold pieces.

CREATE TABLE IF NOT EXISTS inventory_entries (
    holder_entity_id  BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    item_entity_id    BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    count             INTEGER NOT NULL CHECK (count >= 0),
    metadata          JSONB DEFAULT '{}'::jsonb,
    PRIMARY KEY (holder_entity_id, item_entity_id)
);

-- ── Transitions ────────────────────────────────────────────────────────
-- Forward-chaining rules. Re-evaluated to fixpoint after each model
-- patch. `when_json` is a list of predicates over runtime fields,
-- `set_json` is the patch to apply when ALL predicates match.

CREATE TABLE IF NOT EXISTS transitions (
    id               BIGSERIAL PRIMARY KEY,
    owner_entity_id  BIGINT REFERENCES entities(id) ON DELETE CASCADE,
    description      TEXT,
    when_json        JSONB NOT NULL,
    set_json         JSONB NOT NULL,
    goto_entity_id   BIGINT REFERENCES entities(id),
    priority         INTEGER NOT NULL DEFAULT 0,
    consume_flags    TEXT[] DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_transitions_owner ON transitions(owner_entity_id);

-- ── Entity instructions ────────────────────────────────────────────────
-- Cartridge-side hints surfaced into the prompt. Two flavours:
--   - `instruction_json.text`   → narrative rule shown to the model.
--   - `instruction_json.action` → quick-action button shown to the player.
-- `applies_when` is a list of predicates evaluated each turn — a row
-- only enters the prompt when its conditions match.

CREATE TABLE IF NOT EXISTS entity_instructions (
    id                BIGSERIAL PRIMARY KEY,
    owner_entity_id   BIGINT REFERENCES entities(id) ON DELETE CASCADE,
    priority          INTEGER NOT NULL DEFAULT 0,
    applies_when      JSONB DEFAULT '[]'::jsonb,
    instruction_json  JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_instructions_owner ON entity_instructions(owner_entity_id);

-- ── Sessions / chat history ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,                -- the UUID we generate
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata    JSONB DEFAULT '{}'::jsonb        -- model, auth, …
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id                BIGSERIAL PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    author_entity_id  BIGINT REFERENCES entities(id) ON DELETE SET NULL,
    -- 'player' | 'npc' | 'system' | 'narrator'
    tone              TEXT NOT NULL,
    text              TEXT NOT NULL,
    turn_index        INTEGER NOT NULL,
    payload           JSONB DEFAULT '{}'::jsonb,  -- patch report, dice, …
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_turn
    ON chat_messages(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_chat_messages_author
    ON chat_messages(author_entity_id);

-- ── NPC memory bank ────────────────────────────────────────────────────
-- Long-term memories owned by NPCs (or any entity). About is optional —
-- a memory may be ambient ("the lamp went out at midnight") with no
-- subject. Embedding is optional too: writes happen first, embedding
-- runs async via a worker that backfills the vector.
--
-- Embedding dimension: 768 matches text-embedding-004 (Google) and
-- text-embedding-3-small (OpenAI). If we move to a model with a
-- different dim later we'd need a migration.

CREATE TABLE IF NOT EXISTS npc_memories (
    id                BIGSERIAL PRIMARY KEY,
    owner_entity_id   BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    about_entity_id   BIGINT REFERENCES entities(id) ON DELETE SET NULL,
    text              TEXT NOT NULL,
    importance        REAL NOT NULL DEFAULT 0.5
                          CHECK (importance >= 0 AND importance <= 1),
    tags              TEXT[] NOT NULL DEFAULT '{}',
    embedding         vector(768),
    embedded_at       TIMESTAMPTZ,
    sensitive         BOOLEAN NOT NULL DEFAULT false,
    metadata          JSONB DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_npc_memories_owner       ON npc_memories(owner_entity_id);
CREATE INDEX IF NOT EXISTS idx_npc_memories_about       ON npc_memories(about_entity_id);
CREATE INDEX IF NOT EXISTS idx_npc_memories_tags        ON npc_memories USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_npc_memories_importance  ON npc_memories(importance DESC);
-- ANN index. Created with conservative HNSW params; tune `ef_search`
-- per query if recall lags.
CREATE INDEX IF NOT EXISTS idx_npc_memories_embedding
    ON npc_memories USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- ── Migrations table ───────────────────────────────────────────────────
-- Bookkeeping for the in-process migration runner. The runner consults
-- this table on startup; only files whose name isn't recorded run.

CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
