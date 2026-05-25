-- 0002_litrpg.sql — LitRPG world model.
--
-- Adds:
--   - Player progression (XP, level, stats, skills, equipment, reputation).
--   - Per-player overlays on shared NPC state (Mikka treats each player
--     individually even though her global mood is shared).
--   - Tool-invocation audit log (every AI mutation traceable).
--   - Content tables (classes, skills, factions) the cartridge seed fills.
--
-- "One shared world" model: entities (NPCs, locations, items) are global.
-- Player progression and per-player NPC interactions live in dedicated
-- tables keyed by player_id.

-- ── Per-player runtime overlay ─────────────────────────────────────────
-- For fields that must differ between players (e.g. "did THIS player
-- pay Mikka?"), the value lives here instead of runtime_values.
-- runtime_fields.scope_per_player decides which table the writer hits;
-- readers union the two with overlay winning.

ALTER TABLE runtime_fields
    ADD COLUMN IF NOT EXISTS scope_per_player BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS runtime_player_overlay (
    field_id    BIGINT NOT NULL REFERENCES runtime_fields(id) ON DELETE CASCADE,
    player_id   BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    value       JSONB  NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    source      TEXT,
    PRIMARY KEY (field_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_player_overlay_player
    ON runtime_player_overlay(player_id);

-- ── Players ────────────────────────────────────────────────────────────
-- A player is an entity (kind='player') with a row here. Splitting from
-- entities lets us index/normalise progression columns; the entity row
-- still carries display_name, profile, tags so generic entity tools work.

CREATE TABLE IF NOT EXISTS players (
    entity_id              BIGINT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    -- Stable identity. UUID is what the client persists in localStorage.
    -- Recovery code is shown ONCE at signup; hashed here so a leak of
    -- this table doesn't hand out logins. Verification is bcrypt-style
    -- compare in app code.
    public_id              UUID NOT NULL UNIQUE,
    recovery_code_hash     TEXT,
    -- Class assigned at start; can change via class-change tools later.
    class_id               BIGINT REFERENCES entities(id),  -- entity[kind='class']
    current_xp             BIGINT NOT NULL DEFAULT 0 CHECK (current_xp >= 0),
    current_level          INTEGER NOT NULL DEFAULT 1 CHECK (current_level >= 1),
    current_hp             INTEGER NOT NULL DEFAULT 10 CHECK (current_hp >= 0),
    max_hp                 INTEGER NOT NULL DEFAULT 10 CHECK (max_hp > 0),
    current_location_id    BIGINT REFERENCES entities(id),  -- entity[kind='location']
    current_scene_id       BIGINT REFERENCES entities(id),  -- entity[kind='scene']
    metadata               JSONB DEFAULT '{}'::jsonb,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_players_class       ON players(class_id);
CREATE INDEX IF NOT EXISTS idx_players_location    ON players(current_location_id);

-- ── Stats ──────────────────────────────────────────────────────────────
-- Six classic LitRPG stats — STR/DEX/CON/INT/WIS/CHA. Stored open-form
-- via stat_key so a cartridge can introduce custom stats without a
-- migration. base = innate, current = base + temp modifiers.

CREATE TABLE IF NOT EXISTS player_stats (
    player_id   BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
    stat_key    TEXT NOT NULL,
    base        INTEGER NOT NULL DEFAULT 10,
    current     INTEGER NOT NULL DEFAULT 10,
    PRIMARY KEY (player_id, stat_key)
);

-- ── Skills ─────────────────────────────────────────────────────────────
-- skill_entity_id points at entities[kind='skill']. Each player has 0..N
-- ranks per skill. rank=0 means known but unleveled.

CREATE TABLE IF NOT EXISTS player_skills (
    player_id          BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
    skill_entity_id    BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    rank               INTEGER NOT NULL DEFAULT 0 CHECK (rank >= 0),
    unlocked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata           JSONB DEFAULT '{}'::jsonb,
    PRIMARY KEY (player_id, skill_entity_id)
);

-- ── Equipment ──────────────────────────────────────────────────────────
-- One row per occupied slot. Items live in entities[kind='item'] with
-- their stat modifiers/rarity in profile JSONB.

CREATE TABLE IF NOT EXISTS player_equipment (
    player_id          BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
    slot               TEXT NOT NULL,
    item_entity_id     BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    equipped_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, slot)
);

-- ── XP audit log ───────────────────────────────────────────────────────
-- Every XP grant recorded with reason + the tool that issued it. Lets
-- us trace "where did this 350 XP come from?" and detect AI-loop
-- exploits where the model awards XP for trivial actions.

CREATE TABLE IF NOT EXISTS player_xp_log (
    id                 BIGSERIAL PRIMARY KEY,
    player_id          BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
    amount             INTEGER NOT NULL,
    reason             TEXT NOT NULL,
    awarded_by_tool    TEXT,
    awarded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata           JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_player_xp_log_player ON player_xp_log(player_id, awarded_at DESC);

-- ── Faction reputation ─────────────────────────────────────────────────
-- Linear value, semantics decided per-game. Caps & decay live in tools.

CREATE TABLE IF NOT EXISTS faction_reputation (
    player_id          BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
    faction_entity_id  BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    value              INTEGER NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, faction_entity_id)
);

-- ── Quests (per-player progress) ───────────────────────────────────────
-- The quest definition lives in entities[kind='quest']. A player's
-- progress in that quest is here. status: 'unseen' | 'offered' |
-- 'active' | 'completed' | 'failed'.

CREATE TABLE IF NOT EXISTS player_quests (
    player_id          BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
    quest_entity_id    BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    status             TEXT NOT NULL DEFAULT 'offered'
                          CHECK (status IN ('unseen','offered','active','completed','failed')),
    current_phase      INTEGER NOT NULL DEFAULT 0,
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    metadata           JSONB DEFAULT '{}'::jsonb,
    PRIMARY KEY (player_id, quest_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_player_quests_status
    ON player_quests(player_id, status);

-- ── Tool invocation audit ──────────────────────────────────────────────
-- Every AI tool call lands here. Lets us replay a turn, debug "why did
-- the world end up like this", and detect runaway loops where the
-- model called award_xp twenty times in a row.

CREATE TABLE IF NOT EXISTS tool_invocations (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    player_id       BIGINT REFERENCES entities(id) ON DELETE SET NULL,
    turn_id         TEXT,
    tool_name       TEXT NOT NULL,
    args            JSONB NOT NULL,
    result          JSONB,
    error           TEXT,
    duration_ms     INTEGER,
    invoked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_session
    ON tool_invocations(session_id, invoked_at);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_player
    ON tool_invocations(player_id, invoked_at DESC);

-- ── Players need session linkage ───────────────────────────────────────
-- Each session belongs to a player (foreign key, nullable for boot
-- compat — old sessions remain valid). Newly created sessions get
-- assigned in code.

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS player_id BIGINT REFERENCES entities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);

-- ── Helper: XP curve ───────────────────────────────────────────────────
-- Quadratic curve — xp_required_for_level(L) = 100 * L^2. Gives:
--   1 → 2: 100 XP
--   5 → 6: 2500 XP
--   10 → 11: 10000 XP
--   20 → 21: 40000 XP
-- Steep enough to feel grindy at high levels without making early game
-- a slog. SQL function so all callers (tools + reports) agree.

CREATE OR REPLACE FUNCTION xp_required_for_level(level INTEGER)
RETURNS BIGINT
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT (100 * level * level)::BIGINT
$$;

CREATE OR REPLACE FUNCTION level_for_xp(xp BIGINT)
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
AS $$
    -- Solve 100 * L^2 <= xp → L = floor(sqrt(xp / 100)). Min level 1.
    SELECT GREATEST(1, FLOOR(SQRT(xp::DOUBLE PRECISION / 100.0))::INTEGER)
$$;
