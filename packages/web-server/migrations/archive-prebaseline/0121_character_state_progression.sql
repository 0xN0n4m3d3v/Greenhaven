-- 0121_character_state_progression.sql — FEAT-STATE-1 typed
-- Character State tables.
--
-- Phase 9 FEAT-STATE-1 ships a typed Character State surface. The
-- read model in `CharacterStateService` already covers identity,
-- stats, skills, XP/level, equipment, and conditions/trauma from
-- existing tables. This migration adds the four durable
-- progression structures the spec requires so a later UI / tool
-- slice can award titles, run side-progression tracks, and spend
-- earned stat / skill points.
--
-- Forward-only: append-only per packages/web-server/CLAUDE.md.

-- ── Titles ────────────────────────────────────────────────────────────
-- Earned titles for a player. `(player_id, title_key)` is the
-- canonical dedupe — the same title only sticks once. `is_equipped`
-- is read for display today; the equip UI ships in a later slice.
CREATE TABLE IF NOT EXISTS player_titles (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL
    REFERENCES players(entity_id) ON DELETE CASCADE,
  title_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  source TEXT,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_equipped BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_titles_dedupe
  ON player_titles(player_id, title_key);

CREATE INDEX IF NOT EXISTS idx_player_titles_player_awarded
  ON player_titles(player_id, awarded_at DESC);

-- ── Progression tracks (catalog) ───────────────────────────────────
-- Each track is a side-progression ladder (e.g. "Survival",
-- "Diplomacy", "Combat"). Catalog rows live here; per-player
-- progress lives in `player_progression_tracks` below. `xp_curve`
-- is opaque JSONB so a track can define its own scaling
-- (linear / quadratic / piecewise) without a migration.
CREATE TABLE IF NOT EXISTS progression_tracks (
  track_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  xp_curve JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_level INTEGER NOT NULL DEFAULT 20 CHECK (max_level >= 1),
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ── Per-player progression ─────────────────────────────────────────
-- `(player_id, track_key)` is the primary key — exactly one row
-- per player per track. `xp` and `level` are duals (level can be
-- derived from xp + xp_curve but is persisted for cheap reads,
-- mirroring `players.current_xp` / `players.current_level`).
CREATE TABLE IF NOT EXISTS player_progression_tracks (
  player_id BIGINT NOT NULL
    REFERENCES players(entity_id) ON DELETE CASCADE,
  track_key TEXT NOT NULL
    REFERENCES progression_tracks(track_key) ON DELETE CASCADE,
  xp BIGINT NOT NULL DEFAULT 0 CHECK (xp >= 0),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, track_key)
);

CREATE INDEX IF NOT EXISTS idx_player_progression_tracks_player
  ON player_progression_tracks(player_id);

-- ── Wallet (spendable points) ─────────────────────────────────────
-- One row per player. Stat / skill points accumulate from level-ups
-- and named rewards; `title_slots` caps how many titles a player
-- can equip simultaneously. The `spend_*` tools (later slice)
-- decrement these atomically inside `withTransaction`.
CREATE TABLE IF NOT EXISTS player_progression_wallets (
  player_id BIGINT PRIMARY KEY
    REFERENCES players(entity_id) ON DELETE CASCADE,
  stat_points INTEGER NOT NULL DEFAULT 0 CHECK (stat_points >= 0),
  skill_points INTEGER NOT NULL DEFAULT 0 CHECK (skill_points >= 0),
  title_slots INTEGER NOT NULL DEFAULT 1 CHECK (title_slots >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
