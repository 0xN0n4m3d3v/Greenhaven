-- FEAT-HERO-CONTINUITY-3 (2026-05-17) — durable hero continuity ledger.
--
-- Adds the cross-world identity tables called out in
-- `docs/specs/hero-continuity-parallel-universes.md`:
--
--   * `hero_continuity_events` — append-only ledger of cross-world
--     continuity events (artifact awarded, companion travel, world
--     entry). Keeps the audit trail off the live playthrough row.
--   * `hero_portable_artifacts` — explicitly whitelisted things that
--     can travel with the hero (titles, scars, achievements, memory
--     summaries, relics, skill marks). Deduped by
--     `(player_id, artifact_key)` so callers can upsert without a
--     fresh row each time.
--   * `hero_companion_bonds` — persistent hero ↔ companion contract
--     scoped to the hero, not to a single cartridge. Deduped by
--     `(player_id, companion_key)`.
--   * `companion_universe_projections` — per-universe materialization
--     state for a bonded companion (where they are inside a specific
--     live world). Deduped by `(companion_bond_id,
--     universe_instance_id)`.
--   * `hero_companion_capsules` — versioned snapshots of a companion's
--     transferable state. Deduped by `(companion_bond_id,
--     capsule_version)`; one append-only row per capsule build so
--     future networking can reconcile divergent worlds.
--
-- Forward-only. No down migration. Idempotent: every CREATE uses
-- `IF NOT EXISTS`.
--
-- This migration **adds tables only**. It does NOT change
-- `hero_cartridge_states`, `players.metadata.companions[]`, or any
-- existing carryover semantics. Launch / new-game carryover policy
-- lands in FEAT-HERO-CONTINUITY-4.

CREATE TABLE IF NOT EXISTS hero_continuity_events (
  id                          BIGSERIAL PRIMARY KEY,
  player_id                   BIGINT NOT NULL
    REFERENCES players(entity_id) ON DELETE CASCADE,
  source_universe_instance_id UUID
    REFERENCES universe_instances(id) ON DELETE SET NULL,
  target_universe_instance_id UUID
    REFERENCES universe_instances(id) ON DELETE SET NULL,
  source_cartridge_id         TEXT
    REFERENCES cartridges(id)        ON DELETE SET NULL,
  target_cartridge_id         TEXT
    REFERENCES cartridges(id)        ON DELETE SET NULL,
  event_type                  TEXT NOT NULL,
  payload                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (event_type <> '')
);

CREATE INDEX IF NOT EXISTS idx_hero_continuity_events_player
  ON hero_continuity_events(player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hero_continuity_events_target_universe
  ON hero_continuity_events(target_universe_instance_id);
CREATE INDEX IF NOT EXISTS idx_hero_continuity_events_event_type
  ON hero_continuity_events(event_type);


CREATE TABLE IF NOT EXISTS hero_portable_artifacts (
  id                          BIGSERIAL PRIMARY KEY,
  player_id                   BIGINT NOT NULL
    REFERENCES players(entity_id) ON DELETE CASCADE,
  artifact_key                TEXT NOT NULL,
  kind                        TEXT NOT NULL
    CHECK (kind IN ('title','scar','achievement','memory_summary','relic','skill_mark')),
  portability                 TEXT NOT NULL DEFAULT 'portable'
    CHECK (portability IN ('portable','local_locked','suppressed','requires_adapter')),
  source_universe_instance_id UUID
    REFERENCES universe_instances(id) ON DELETE SET NULL,
  source_cartridge_id         TEXT
    REFERENCES cartridges(id)        ON DELETE SET NULL,
  power_rating                INTEGER NOT NULL DEFAULT 0 CHECK (power_rating >= 0),
  payload                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, artifact_key),
  CHECK (artifact_key <> '')
);

CREATE INDEX IF NOT EXISTS idx_hero_portable_artifacts_player
  ON hero_portable_artifacts(player_id, kind);


CREATE TABLE IF NOT EXISTS hero_companion_bonds (
  id                          BIGSERIAL PRIMARY KEY,
  player_id                   BIGINT NOT NULL
    REFERENCES players(entity_id) ON DELETE CASCADE,
  companion_key               TEXT NOT NULL,
  source_entity_id            BIGINT
    REFERENCES entities(id)          ON DELETE SET NULL,
  source_universe_instance_id UUID
    REFERENCES universe_instances(id) ON DELETE SET NULL,
  source_cartridge_id         TEXT
    REFERENCES cartridges(id)        ON DELETE SET NULL,
  status                      TEXT NOT NULL DEFAULT 'bonded'
    CHECK (status IN ('bonded','traveling','world_bound','departed','suppressed')),
  portability                 TEXT NOT NULL DEFAULT 'local_locked'
    CHECK (portability IN ('portable','local_locked','requires_adapter','suppressed')),
  public_summary              TEXT,
  private_summary             TEXT,
  bond_payload                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, companion_key),
  CHECK (companion_key <> '')
);

CREATE INDEX IF NOT EXISTS idx_hero_companion_bonds_player
  ON hero_companion_bonds(player_id, portability, status);


CREATE TABLE IF NOT EXISTS companion_universe_projections (
  id                   BIGSERIAL PRIMARY KEY,
  companion_bond_id    BIGINT NOT NULL
    REFERENCES hero_companion_bonds(id) ON DELETE CASCADE,
  universe_instance_id UUID NOT NULL
    REFERENCES universe_instances(id) ON DELETE CASCADE,
  projection_entity_id BIGINT
    REFERENCES entities(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','following','waiting','suppressed','departed')),
  arrival_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (companion_bond_id, universe_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_companion_universe_projections_universe
  ON companion_universe_projections(universe_instance_id);


CREATE TABLE IF NOT EXISTS hero_companion_capsules (
  id                          BIGSERIAL PRIMARY KEY,
  companion_bond_id           BIGINT NOT NULL
    REFERENCES hero_companion_bonds(id) ON DELETE CASCADE,
  capsule_version             INTEGER NOT NULL DEFAULT 1
    CHECK (capsule_version >= 1),
  source_universe_instance_id UUID
    REFERENCES universe_instances(id) ON DELETE SET NULL,
  source_projection_id        BIGINT
    REFERENCES companion_universe_projections(id) ON DELETE SET NULL,
  state_hash                  TEXT NOT NULL,
  payload                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (companion_bond_id, capsule_version),
  CHECK (state_hash <> '')
);

CREATE INDEX IF NOT EXISTS idx_hero_companion_capsules_bond
  ON hero_companion_capsules(companion_bond_id, capsule_version DESC);
