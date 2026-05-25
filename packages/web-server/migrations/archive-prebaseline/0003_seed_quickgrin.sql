-- 0003_seed_quickgrin.sql — first cartridge seed.
--
-- Quickgrin Lane: a market street with one NPC (Mikka the goblin
-- merchant), two locations (the lane and the velvet booths), one
-- evocative item (the extinguished lamp), one quest (Mikka's private
-- price), and the supporting LitRPG content (one class, two skills,
-- one faction).
--
-- Idempotent: every INSERT uses ON CONFLICT so re-running on a
-- partially-seeded DB is safe. We keep entity ids stable via
-- explicit pkey assignments so cross-references work without
-- second-pass UPDATEs.

-- ── Entity id allocation ───────────────────────────────────────────────
-- Reserve a fixed numeric block for cartridge-seeded entities so the
-- BIGSERIAL counter advances past them. Player entities start above
-- this band so they never collide.

-- Locations: 100..199
-- NPCs: 200..299
-- Items: 300..399
-- Scenes: 400..499
-- Quests: 500..599
-- Classes: 600..699
-- Skills: 700..799
-- Factions: 800..899

-- ── Locations ──────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(100, 'location', 'Quickgrin Lane',
 'A bright, crowded market lane where bargains, rumours, and risky work move faster than the lantern smoke.',
 jsonb_build_object(
   'narrator_brief', 'You are the AMBIENT NARRATOR of Quickgrin Lane — a busy lantern-lit market street. Speak FROM the place, not as any NPC who happens to be here. Describe what the player sees, hears, smells: lantern smoke and ginger-tea steam, the clatter of coins on stone, hawkers shouting prices.',
   'narrator_style', 'sensory location author'
 ),
 ARRAY['location','market','quest hub']),
(101, 'location', 'Velvet Booths',
 'Curtained side rooms off Quickgrin Lane. Private contracts, secrets, and delicate negotiations happen here.',
 jsonb_build_object(
   'narrator_brief', 'You are the AMBIENT NARRATOR of the Velvet Booths — a row of curtained side-rooms where private deals close. Heavy wine-coloured velvet swallowing the street''s noise, low lantern light pooling on polished tables.',
   'narrator_style', 'close, low, contract-aware'
 ),
 ARRAY['location','booths','privacy'])
ON CONFLICT (id) DO NOTHING;

-- ── NPCs ───────────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(200, 'person', 'Mikka Quickgrin',
 'A streetwise goblin negotiator who runs Quickgrin Lane''s information and privacy market.',
 jsonb_build_object(
   'species', 'goblin woman',
   'age', 20,
   'profession', 'Quickgrin Lane broker',
   'self_description', 'Bright green skin dusted with freckles, a shock of red hair with long pointed ears poking out, wide-open violet eyes. Form-fitting leather armour with engraved steel on shoulders and shins. Broad, teasing smile.',
   'narrator_brief', 'You ARE Mikka Quickgrin. Voice: fast, teasing, practical. Speak in first person consistent with this persona''s gender and species. NEVER narrate yourself in third person — only ''я''. You react through tools, never claim state changes that did not happen via tool calls.',
   'temper', 'warm when paid clearly, sharp when cheated',
   'speech_style', 'fast, teasing, practical',
   'home_id', 100
 ),
 ARRAY['person','npc','merchant','adult'])
ON CONFLICT (id) DO NOTHING;

-- ── Items ──────────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(300, 'item', 'Gold Coin',
 'Standard Quickgrin currency. Models move it only via inventory_transfer.',
 jsonb_build_object('rarity','common','stackable',true),
 ARRAY['item','currency','inventory']),
(301, 'item', 'Extinguished Lamp',
 'A booth-side lamp gone dark. It can issue a privacy quest and alter Mikka''s negotiation context.',
 jsonb_build_object(
   'description', 'A booth-side lamp gone dark.',
   'voice', 'silent clue that changes the room''s mood'
 ),
 ARRAY['item','quest_hook','privacy'])
ON CONFLICT (id) DO NOTHING;

-- ── Scenes ─────────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(400, 'scene', 'Mikka''s Private Negotiation',
 'Opening negotiation scene where Mikka evaluates a clear offer.',
 jsonb_build_object(
   'narrator_brief', 'You are the SCENE NARRATOR for Mikka''s Private Negotiation — the active messenger thread when the player is haggling with Mikka inside the Velvet Booths. Establish the scene as the present moment: who is here, what is on the table, what hooks (price tiers, lamp clue, private service question).',
   'scene_rule', 'payment and stage changes are not real until the patch changes slots and inventory'
 ),
 ARRAY['scene','payment_exchange'])
ON CONFLICT (id) DO NOTHING;

-- ── Quests ─────────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(500, 'quest', 'Mikka''s Private Price',
 'Pay Mikka the broker for a private service of negotiated tier.',
 jsonb_build_object(
   'archetype', 'payment_exchange',
   'base_price', 10,
   'upgrade_price', 25,
   'giver_id', 200,
   'scene_id', 400,
   'phases', jsonb_build_array(
     jsonb_build_object('id',1,'name','offer'),
     jsonb_build_object('id',2,'name','paid'),
     jsonb_build_object('id',3,'name','service')
   )
 ),
 ARRAY['quest','payment_exchange'])
ON CONFLICT (id) DO NOTHING;

-- ── Classes ────────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(600, 'class', 'Wanderer',
 'A traveller without affiliation. Learns by doing.',
 jsonb_build_object(
   'base_stats', jsonb_build_object('STR',10,'DEX',12,'CON',10,'INT',11,'WIS',11,'CHA',12),
   'starting_skills', jsonb_build_array(701, 702),
   'description', 'Versatile, social, neither warrior nor mage. Bargains and reads people instead of swinging swords.'
 ),
 ARRAY['class','starting'])
ON CONFLICT (id) DO NOTHING;

-- ── Skills ─────────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(701, 'skill', 'Bargain',
 'Reads a merchant''s tells and undercuts a price.',
 jsonb_build_object(
   'kind','social','stat_check','CHA',
   'description','When you are in a transaction, roll d20 + CHA modifier vs DC. Success: -10% price.'
 ),
 ARRAY['skill','social','starting']),
(702, 'skill', 'Charm',
 'Wins a moment of trust from someone who has reason to doubt.',
 jsonb_build_object(
   'kind','social','stat_check','CHA',
   'description','When an NPC''s disposition is hostile or neutral, roll d20 + CHA mod vs DC 12 to soften them by one step.'
 ),
 ARRAY['skill','social','starting'])
ON CONFLICT (id) DO NOTHING;

-- ── Factions ───────────────────────────────────────────────────────────

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(800, 'faction', 'Quickgrin Merchants',
 'The loose guild of brokers, fence-merchants and contract-runners working Quickgrin Lane.',
 jsonb_build_object(
   'description', 'Loyalty is to the deal, not the king.',
   'starting_value', 0
 ),
 ARRAY['faction'])
ON CONFLICT (id) DO NOTHING;

-- ── Runtime fields ─────────────────────────────────────────────────────
-- A small but representative slice; can grow as the cartridge matures.
-- scope_per_player flags the ones that must differ between players
-- (e.g. who has paid Mikka).

INSERT INTO runtime_fields
    (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
VALUES
-- Mikka's global mood / status — same for everyone.
(2101, 200, 'status', 'enum',
 '"pricing"'::jsonb,
 '["pricing","negotiating","paid","refusing"]'::jsonb,
 'session', false, 'Mikka''s current negotiation stance.'),
-- Lamp's lit/dark — global, but flippable.
(2102, 301, 'lamp_state', 'enum',
 '"dark"'::jsonb, '["dark","lit"]'::jsonb, 'session', false,
 'Whether the extinguished lamp is dark or relit.'),
-- Per-player quest tracking on the scene side.
(2001, 400, 'offered_gold', 'int',
 '0'::jsonb, NULL, 'session', true, 'Gold this player has offered Mikka.'),
(2002, 400, 'payment_confirmed', 'bool',
 'false'::jsonb, NULL, 'session', true, 'True after the inventory transfer for this player.'),
(2003, 400, 'service_tier', 'enum',
 '"none"'::jsonb,
 '["none","base","extended","upgrade","refused"]'::jsonb,
 'session', true, 'Tier this player negotiated.'),
(2008, 400, 'next_step', 'enum',
 '"stay"'::jsonb,
 '["stay","negotiate","service","aftercare"]'::jsonb,
 'session', true, 'Next narrative beat.')
ON CONFLICT (id) DO NOTHING;

-- ── Initial runtime values for global fields ───────────────────────────
INSERT INTO runtime_values (field_id, value, source) VALUES
(2101, '"pricing"'::jsonb, 'cartridge_seed'),
(2102, '"dark"'::jsonb, 'cartridge_seed')
ON CONFLICT (field_id) DO NOTHING;

-- ── Transitions ────────────────────────────────────────────────────────
-- Forward-chaining rule: when the player has paid, advance to "paid"
-- status and bump the next_step. Demonstrates per-player conditions.

INSERT INTO transitions
    (id, owner_entity_id, description, when_json, set_json, goto_entity_id, priority)
VALUES
(900, 500,
 'Payment accepted → quest moves to active phase, scene flips to service.',
 jsonb_build_array(
   jsonb_build_object('field_id', 2002, 'op', 'eq', 'value', true)
 ),
 jsonb_build_array(
   jsonb_build_object('field_id', 2008, 'value', '"service"'::jsonb)
 ),
 NULL,
 100)
ON CONFLICT (id) DO NOTHING;

-- ── Entity instructions (prompts + quick-actions) ──────────────────────
-- Two flavours surface here: narrative rules the model reads, and
-- quick-action buttons the player presses. The cartridge owns both.

INSERT INTO entity_instructions
    (id, owner_entity_id, priority, applies_when, instruction_json)
VALUES
-- Narrative rule for Mikka — anchors her behaviour in the prompt.
(1, 200, 10,
 '[]'::jsonb,
 jsonb_build_object(
   'text', 'Mikka is the active character. She negotiates through tools, never by claiming unpatched state changes.'
 )),
-- Payment-accepted recipe — the "how to actually take a payment" rule.
(50, 500, 50,
 jsonb_build_array(
   jsonb_build_object('field_id', 2002, 'op', 'eq', 'value', false)
 ),
 jsonb_build_object(
   'text', E'PAYMENT-ACCEPTED RECIPE — when the hero offers >= 10 gold and you accept:\n  1. inventory_transfer(hero, mikka, gold-coin, N)\n  2. set_runtime_field(2001, N, scope=per-player)\n  3. set_runtime_field(2002, true, scope=per-player)\n  4. set_runtime_field(2003, ''base''|''upgrade''|''extended'')\n  5. set_runtime_field(2008, ''service'')\n  6. award_xp(player, 50, ''first_payment'')\n  7. add_memory(mikka, about=hero, ''Paid N gold for {tier}'', importance=0.7)\n  8. narrate(...)'
 )),
-- Quick-action button: offer 10 gold.
(105, 600, 140,
 jsonb_build_array(
   jsonb_build_object('field_id', 2002, 'op', 'eq', 'value', false)
 ),
 jsonb_build_object(
   'action', jsonb_build_object(
     'id', 'offer_10',
     'label', 'Offer 10 gold',
     'message', 'I put 10 gold on the table for Mikka and ask what that buys.',
     'route', jsonb_build_object('mode', 'npc', 'target_entity_id', 200)
   )
 )),
-- Quick-action button: go to booths.
(106, 600, 110,
 '[]'::jsonb,
 jsonb_build_object(
   'action', jsonb_build_object(
     'id', 'go_booth',
     'label', 'Go to Velvet Booths',
     'message', 'I move toward the Velvet Booths and look around before speaking.',
     'route', jsonb_build_object('mode', 'location', 'target_entity_id', 101)
   )
 ))
ON CONFLICT (id) DO NOTHING;

-- ── Mikka's starting inventory ─────────────────────────────────────────
-- She has no gold yet; players bring it in. Listed for explicit zero
-- (helps query-by-holder return a known-empty bag instead of NULL).
INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count) VALUES
(200, 300, 0)
ON CONFLICT (holder_entity_id, item_entity_id) DO NOTHING;
