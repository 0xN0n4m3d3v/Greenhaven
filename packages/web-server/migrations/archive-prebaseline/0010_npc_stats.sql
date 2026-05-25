-- 0010_npc_stats.sql — D&D-style ability scores for NPCs.
--
-- Mirror of `player_stats` (six classic abilities: STR / DEX / CON /
-- INT / WIS / CHA), keyed by entity id. Mod is computed
-- on-the-fly: floor((current - 10) / 2). The combat tools don't read
-- this table directly — the model does, via the turnContext preamble
-- (PEOPLE HERE prints "STR 8 (-1), DEX 14 (+2), …") and uses the
-- modifier as the second argument to `dice_check`.
--
-- AC is a separate runtime_field per actor so it can shift with
-- armour, buffs, debuffs. Default is a static integer; tools that
-- equip / debuff later can write through `apply_runtime_field_patch`.

CREATE TABLE IF NOT EXISTS npc_stats (
    npc_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    stat_key      TEXT   NOT NULL,
    base          INT    NOT NULL,
    current       INT    NOT NULL,
    PRIMARY KEY (npc_entity_id, stat_key)
);

CREATE INDEX IF NOT EXISTS idx_npc_stats_owner ON npc_stats(npc_entity_id);

-- Mikka Quickgrin — goblin broker. Light frame, sharp tongue.
-- Reads & negotiates better than she fights. Quick on her feet
-- (DEX 14 = +2 to-hit with light blades, +2 AC) but no muscle to
-- speak of (STR 8 = -1).
INSERT INTO npc_stats (npc_entity_id, stat_key, base, current) VALUES
  (200, 'STR', 8,  8),
  (200, 'DEX', 14, 14),
  (200, 'CON', 11, 11),
  (200, 'INT', 12, 12),
  (200, 'WIS', 13, 13),
  (200, 'CHA', 14, 14)
ON CONFLICT (npc_entity_id, stat_key) DO NOTHING;

-- Mikka's armour class. Light leather + DEX bonus = 13.
INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, scope, scope_per_player, description)
VALUES
  (2202, 200, 'armor_class', 'int', '13'::jsonb, 'session', false,
   'Mikka''s AC. Attack rolls vs Mikka use this as DC.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (2202, '13'::jsonb, 'cartridge_seed')
ON CONFLICT (field_id) DO NOTHING;

-- Proficiency bonus (D&D 5e: +2 at levels 1-4). Stored as a runtime
-- field so it can scale with NPC level if we ever introduce one.
INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, scope, scope_per_player, description)
VALUES
  (2203, 200, 'proficiency_bonus', 'int', '2'::jsonb, 'session', false,
   'Mikka''s proficiency bonus added to checks she''s trained in.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (2203, '2'::jsonb, 'cartridge_seed')
ON CONFLICT (field_id) DO NOTHING;
