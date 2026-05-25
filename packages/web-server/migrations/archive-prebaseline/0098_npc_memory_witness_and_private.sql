-- NPC memory upgrade: witness-scoped chat history + private memory channel.
--
-- Three additions:
--   1. chat_messages.witness_entity_ids — array of NPC entity ids that
--      were physically present at the location when this message was
--      written. Used by the per-NPC dialogue view in dialogueContext so
--      each NPC sees what was said in their presence, regardless of
--      whether they were the active dialogue partner. NPCs that were
--      NOT present do not see the message and cannot reference it. Old
--      rows have NULL — the read-path falls back to author/partner
--      matching for those.
--
--   2. chat_messages text-search index — used by the new
--      `recall_partner_history` broker tool. Postgres FTS over the
--      `text` column with a Russian/English-neutral config (`simple`
--      keeps token matching unstemmed; for cyrillic that is OK because
--      we mostly query substrings, not lexemes).
--
--   3. npc_memories private-channel convention. The existing
--      `metadata` jsonb gains a `visibility` field
--      ('public' | 'private'). Public is the default and matches
--      previous behaviour — visible to other NPCs via cross-NPC
--      inference and to the player-facing UI when relevant. Private
--      memories are only ever loaded into the owner NPC's own preamble
--      and never surface to other NPCs or to the player. No schema
--      change needed since metadata is already jsonb; we add an index
--      to make the visibility filter cheap, and a tag convention
--      `tag:private` so legacy read paths that look at tags also
--      respect the channel.

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS witness_entity_ids BIGINT[] DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_witness_gin
  ON chat_messages USING GIN (witness_entity_ids);

CREATE INDEX IF NOT EXISTS idx_chat_messages_text_fts
  ON chat_messages USING GIN (to_tsvector('simple', text));

-- Visibility index for npc_memories. The default treats missing
-- visibility as 'public' for back-compat.
CREATE INDEX IF NOT EXISTS idx_npc_memories_visibility
  ON npc_memories ((COALESCE(metadata->>'visibility', 'public')));

-- Convenience comment documenting the new conventions so future
-- migrations don't accidentally drop them.
COMMENT ON COLUMN chat_messages.witness_entity_ids IS
  'Array of NPC entity ids that were physically present at the location '
  'when the message was written. Drives per-NPC scoped dialogue history '
  'in turnContext/dialogueContext. NULL means "unknown / legacy" — read '
  'path falls back to author/dialogue_partner matching.';
