-- 0007_dialogue_mode.sql — dialogue-vs-ambient model.
--
-- Locations are broadcast channels; NPCs are focus modes.
--
--   * When a player is NOT in dialogue, their input goes to the
--     location's ambient narrator. Their narrate writes land with
--     npc_entity_id = NULL — visible to anyone reading the location
--     feed.
--
--   * When a player ENTERS a dialogue with an NPC, narrate writes
--     get tagged with npc_entity_id = X. Their dialogue thread is
--     `(player_id, npc_entity_id)`-scoped: each player has their own
--     ongoing chat with the NPC, even when several players are
--     talking to the same NPC at once. Other players in the same
--     location see these dialogue lines too (read-only, as activity)
--     — they're not silently private.
--
--   * Location ambient is muted FOR THE FOCUSED PLAYER while they're
--     in dialogue (their model context filters it out). It still
--     happens for everyone else.
--
-- Index strategy: location feed reads are
-- `(location_entity_id, npc_entity_id IS NULL, turn_index DESC)`;
-- per-player dialogue reads are
-- `(player_author / npc_entity_id, turn_index DESC)`. Two partial
-- indexes cover both.

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS location_entity_id BIGINT
        REFERENCES entities(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS npc_entity_id BIGINT
        REFERENCES entities(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS player_id BIGINT
        REFERENCES entities(id) ON DELETE SET NULL;

-- Backfill: best-effort tag of pre-existing rows. We don't have the
-- original location/npc/player linkage, but we DO have author_entity_id
-- and session_id. For the demo data, every player is in Quickgrin Lane
-- and the only NPC who's spoken is Mikka, so we tag heuristically:
--   * if author is Mikka (200) → npc_entity_id = 200, location = 100
--   * if author is a location (100/101) → location_entity_id = author
--   * else (player or null) → leave nulls; not enough info
UPDATE chat_messages
   SET npc_entity_id      = CASE WHEN author_entity_id = 200 THEN 200 ELSE NULL END,
       location_entity_id = CASE
                              WHEN author_entity_id = 200 THEN 100
                              WHEN author_entity_id IN (100, 101) THEN author_entity_id
                              ELSE NULL
                            END
 WHERE npc_entity_id IS NULL AND location_entity_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_location_ambient
    ON chat_messages(location_entity_id, turn_index DESC)
    WHERE npc_entity_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_messages_dialogue
    ON chat_messages(player_id, npc_entity_id, turn_index DESC)
    WHERE npc_entity_id IS NOT NULL;

-- Player's current focus. NULL = listening to the location ambient.
-- Non-null = in dialogue with this NPC; their turns route through
-- that thread until they end the dialogue.
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS dialogue_partner_id BIGINT
        REFERENCES entities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_players_dialogue_partner
    ON players(dialogue_partner_id)
    WHERE dialogue_partner_id IS NOT NULL;
