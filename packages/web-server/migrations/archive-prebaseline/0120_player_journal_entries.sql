-- 0120_player_journal_entries.sql — FEAT-NOTICE-1 durable Notice
-- Journal projection.
--
-- The Notice Journal surface (Phase 9 LitRPG surfaces, J hotkey)
-- needs a durable, replayable, player-scoped log of story-worthy
-- events. The existing `gui_events` outbox is canonical for live
-- SSE traffic but it is session-scoped, mixes broker scheduling
-- metadata, and is not filterable by player-facing significance.
--
-- This migration adds a forward-only projection table. The
-- `NoticeJournalService` materializes important released
-- `gui_events` rows for the requested player into this table on
-- read (idempotent via the partial unique index on
-- `(player_id, source_event_id)`), then the read API returns a
-- typed, paginated DTO from this projection.
--
-- Append-only: never edit this migration once applied to dev/prod.
-- A later compensating migration adds new columns / indexes if
-- needed.

CREATE TABLE IF NOT EXISTS player_journal_entries (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL
    REFERENCES players(entity_id) ON DELETE CASCADE,
  session_id TEXT
    REFERENCES sessions(id) ON DELETE SET NULL,
  source_event_id BIGINT
    REFERENCES gui_events(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL
    CHECK (entry_type IN (
      'quest', 'progression', 'relationship', 'world', 'story', 'system'
    )),
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  turn_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedupe: a given released gui_event row materializes into at most
-- one journal entry per player. The materializer relies on
-- `ON CONFLICT DO NOTHING` against this partial index so a re-read
-- after an event was already projected is a no-op. The partial
-- predicate keeps the index from blocking entries that were
-- inserted directly (no source_event_id) — reserved for future
-- non-gui_event projections.
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_journal_source_event_uniq
  ON player_journal_entries(player_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

-- Read index: list newest-first for a player without filtering.
CREATE INDEX IF NOT EXISTS idx_player_journal_player_id_desc
  ON player_journal_entries(player_id, id DESC);

-- Read index: filter by entry_type, newest-first.
CREATE INDEX IF NOT EXISTS idx_player_journal_player_type
  ON player_journal_entries(player_id, entry_type, id DESC);
