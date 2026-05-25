-- Grinhaven Main Market Square (201236) as the new demo starting location.
--
-- Background. Until now the demo opened in Ale & Eats (201019) — a quiet
-- tavern interior with limited zazu/zazyvanie texture. The market is a
-- denser, more legible scene for a first-time player: foot traffic,
-- competing vendor calls, a goblin info-broker who tolerates a beginner,
-- visible bunny-girl barkers from the Velvet Quarter, hot food smells.
--
-- This migration:
--   1. Promotes 201236 from discovered-ref to authored: summary,
--      narrator_brief, sensory, mood, surrounding-building register.
--   2. Inserts three new NPCs anchored to the market via home_id and
--      scene participation:
--        - Mikka Quickgrin (230501): goblin info-broker, easy-first
--          consent profile (no hangups, fair pricing, agreeable inside
--          paid scope), sells gossip for 1 copper or a full paid scene
--          in the curtained side rooms for 40 silver. First-time-player
--          friendly: yes/no answers, clear price, no escalation.
--        - Tilly Hopjoy (230502): bunny-girl barker hired by Velvet
--          Tally to flag down market traffic. Friendly, will lead the
--          player to her house if asked but does not transact herself.
--        - Vraska Cinderfang (230503): orc-blooded grill cook running a
--          three-stones stall; sells skewered roast varan (2 copper),
--          loud, generous portions, hates burning her meat.
--   3. Creates four anchor scenes pinning the new NPCs to 201236 via
--      participant_entity_ids so the runtime presence resolver and
--      voiceWarden see them at this location even before 0095's repair
--      sweep computes home_id density.
--   4. Switches `cartridge_meta.starting_location_id` to 201236 and
--      relocates already-spawned players who were sitting at the old
--      Ale & Eats default.
--
-- Runs AFTER 0084 (cartridge-forge upsert) and 0090 (MMP fix) and 0095
-- (generic scene-anchor repair). 0093 strict density rebuild then picks
-- up the new home_id pins for the three NPCs without an extra pass.

-- 1. Promote 201236 to authored playable market.
UPDATE entities
   SET summary =
         'A wide flagstoned market square in central Grinhaven, ringed by '
      || 'four-storey trade houses and edged on the south by the Hearthreach '
      || 'canal. Stalls under awnings of dyed canvas; a brass clock-spike at '
      || 'the centre rings the half-hour. From mid-morning the square is '
      || 'three deep at the busy vendors. Bunny-girl barkers from the Velvet '
      || 'Quarter loiter at the southwest arch, flagging coin and traffic. '
      || 'The grill smoke from Vraska''s varan-stall drifts west across the '
      || 'whole square.',
       profile = COALESCE(profile, '{}'::jsonb)
              || jsonb_build_object(
            'cartridge_id', 'grinhaven-full',
            'source_category', 'authored.market_square_demo_start',
            'location_kind', 'market',
            'topology_parent_id', 201001,
            'power_center_id', 201236,
            'access_policy', 'public',
            'narrator_brief',
                'You are the AMBIENT NARRATOR of Grinhaven Main Market '
             || 'Square. Speak FROM the place. Always foreground at least '
             || 'two living textures: (1) sound — calls of vendors, '
             || 'clatter of coin on stone, the brass clock-spike on the '
             || 'half-hour, distant canal traffic from the south; (2) '
             || 'smell — Vraska''s grill smoke (varan-skewers, charred '
             || 'fat, ginger oil), bread carts from the east row, '
             || 'something sweeter from the perfumed barkers at the '
             || 'southwest arch. Light by hour: harsh white at noon, '
             || 'lantern-amber after fifth bell. Buildings around the '
             || 'square should be named when the player looks: '
             || 'Hearthreach Bank (north, granite, three storeys), '
             || 'Pratts'' Cloth House (east, painted lintels), the '
             || 'Compact Customs Stoop (west, columned), the canal '
             || 'archway (south, low stone bridge with toll-clerk). '
             || 'Encourage the player to act, not lurk: someone is '
             || 'always about to undercut someone.',
            'description',
                'Flagstoned plaza ~80 paces across. Forty-two licensed '
             || 'stalls plus the under-arch unlicensed row at the '
             || 'southwest. Brass clock-spike at centre. Hearthreach '
             || 'canal under the south arch. Velvet Quarter is two '
             || 'blocks west; Steelgate Ward two blocks north.',
            'mood', 'busy, transactional, public, lightly licentious at the southwest arch',
            'sensory', jsonb_build_object(
              'sounds', jsonb_build_array(
                'vendor calls in three languages',
                'brass clock-spike on the half-hour',
                'coin on stone',
                'canal-boat poles thumping the south wall'
              ),
              'smells', jsonb_build_array(
                'Vraska''s grill — charred varan, ginger oil, smoke',
                'fresh bread from the east row carts',
                'jasmine and citrus from the bunny-girls'' shoulder-oil',
                'wet stone from the canal'
              ),
              'sights', jsonb_build_array(
                'awnings in Velvet Quarter purple and Steelgate brown',
                'the brass clock-spike at centre',
                'four-storey trade houses on three sides',
                'low canal arch on the south'
              )
            ),
            'exits', jsonb_build_array(201001, 201002, 201005, 201019, 201012, 201015),
            'first_entry_bubble',
                'Ты выходишь на @Grinhaven Main Market Square, и площадь '
             || 'разворачивается во все стороны — примерно восемьдесят '
             || 'шагов мощёной плитой, в центре латунный часовой шпиль '
             || 'отбивает половины. Сорок с лишним торговых лавок; под '
             || 'юго-западной аркой — нелицензированный ряд, где '
             || 'ярко-одетые девушки с заячьими ушами высматривают '
             || 'клиентов для соседних домов: @Velvet Tally, '
             || '@Meow Meow Paradise, @Nectar — все два-три квартала '
             || 'к западу. С запада тянет дымом гриля; это @Vraska Cinderfang, '
             || 'которая переворачивает шампуры жареного варана и кричит цену в '
             || 'два языка. У третьего столба от центра — низкий стол с '
             || 'лампой и счётами; за ним @Mikka Quickgrin, гоблинка-маклер, '
             || 'читает чужие письма за медяк. Барышня с заячьими '
             || 'ушами — @Tilly Hopjoy — уже заметила тебя и машет с арки.'
         )
              - 'placeholder'
              - 'is_placeholder',
       tags = ARRAY(
         SELECT DISTINCT tag
           FROM unnest(
             COALESCE(tags, ARRAY[]::text[])
             || ARRAY['market', 'public', 'demo_start', 'venue', 'authored']
           ) AS t(tag)
       )
 WHERE id = 201236
   AND kind = 'location';

-- 2a. Mikka Quickgrin — easy-first goblin info-broker.
INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES (
  230501,
  'person',
  'Mikka Quickgrin',
  'Goblin info-broker at Grinhaven Main Market Square. Reads letters and gossip for a copper; available for a paid private scene in the curtained side rooms at a fair, fixed rate. Easy-first design: no hangups, no shyness, no breakdowns, no escalation, plain consent talk, agreeable to anything once price is named.',
  jsonb_build_object(
    'cartridge_id', 'grinhaven-full',
    'source_category', 'authored.market_square_demo_start',
    'home_id', 201236,
    'location_id', 201236,
    'current_location_id', 201236,
    'power_center_id', 201236,
    'power_center_role', 'venue',
    'venue_role', 'info-broker and paid-scene partner',
    'species', 'goblin',
    'pronouns', 'she/her',
    'age', 41,
    'archetype', 'easy-first paid partner; demo onboarding NPC',
    'role', 'street-corner letter-reader and gossip-broker',
    'speech_style', 'plain, fast, transactional, warm; uses player''s name once she hears it; never coy, never haggles down once she names a price',
    'personality', 'professional, body-comfortable, sex-positive, allergic to drama. She has worked the corner for eleven years and learned the hard way that mystique loses bookings. With first-timers she leads with a price list and asks what the player wants out loud.',
    'narrator_brief',
        'Mikka is the easiest NPC in Grinhaven. Onboarding: she states '
     || 'her two services aloud — info for a copper, a paid scene for '
     || 'forty silver — accepts either, refuses neither out of '
     || 'discomfort, and walks the player through her own consent '
     || 'preferences in two sentences. She has no inner contradiction '
     || 'to crack open. She does not break character into hidden '
     || 'sadness. She is good at her job and likes it. If the player '
     || 'tries to demoralise her she shrugs and asks what they want.',
    'goal', 'keep the corner running, undercut Brokers'' Lane, save enough for a stone-walled shop by forty-five',
    'price_list', jsonb_build_object(
      'gossip_one_question', '1 copper',
      'letter_read_or_written', '3 copper',
      'address_lookup', '5 copper',
      'private_scene_full_night', '40 silver',
      'private_scene_short', '15 silver'
    ),
    'consent_register', 'plain and forward; states what she does and doesn''t do in two sentences once asked; sex she will do: anything mutual and non-injurious; she will not do: blood, marks her clients can''t hide the next morning, contracts longer than a single night',
    'portrait_set', jsonb_build_object(
      'default', null,
      'amused', null,
      'transactional', null
    ),
    'aliases', jsonb_build_array('Mikka', 'Mikka the Quick', 'Hitrogrin', 'Микка Квикгрин', 'Микка', 'Микка Хитрогрин')
  ),
  ARRAY['npc', 'demo_start', 'easy_first', 'info_broker', 'paid_partner', 'goblin', 'authored']
)
ON CONFLICT (id) DO UPDATE
  SET kind = EXCLUDED.kind,
      display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags;

-- 2b. Tilly Hopjoy — bunny-girl barker.
INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES (
  230502,
  'person',
  'Tilly Hopjoy',
  'Bunny-girl barker working the southwest arch of Grinhaven Main Market Square on commission for The Velvet Tally and Meow Meow Paradise. Will lead curious customers to her houses; does not transact in private herself.',
  jsonb_build_object(
    'cartridge_id', 'grinhaven-full',
    'source_category', 'authored.market_square_demo_start',
    'home_id', 201236,
    'location_id', 201236,
    'current_location_id', 201236,
    'power_center_id', 201236,
    'power_center_role', 'venue',
    'venue_role', 'barker (commission, brothel referral)',
    'species', 'rabbitfolk',
    'pronouns', 'she/her',
    'age', 24,
    'archetype', 'cheerful brothel barker; not a paid partner herself',
    'role', 'flag down market foot traffic, route paying customers to the Velvet Quarter, take a flat commission per delivered customer',
    'speech_style', 'sing-song, fast, public; ear-flicks for emphasis; remembers faces well',
    'personality', 'genuinely cheerful and a touch performative on the corner; off the clock she is sharper and tired. She likes her job because it pays per delivery and she gets to people-watch.',
    'narrator_brief',
        'Tilly stands under the southwest arch with two other barkers '
     || 'and a small paper sign. She flags down promising-looking '
     || 'traffic with a head-tilt and an ear-flick. If asked, she '
     || 'walks the player two blocks west to Velvet Tally or to Meow '
     || 'Meow Paradise. She does NOT proposition the player directly '
     || 'for herself. If the player asks whether she is available '
     || 'personally she laughs and explains the commission model.',
    'aliases', jsonb_build_array('Tilly', 'Тилли', 'Тилли Хопджой')
  ),
  ARRAY['npc', 'demo_start', 'barker', 'rabbitfolk', 'authored']
)
ON CONFLICT (id) DO UPDATE
  SET kind = EXCLUDED.kind,
      display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags;

-- 2c. Vraska Cinderfang — varan-grill cook.
INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES (
  230503,
  'person',
  'Vraska Cinderfang',
  'Orc-blooded grill cook running a three-stones stall on the west side of Grinhaven Main Market Square. Sells skewered roast monitor-lizard (varan) for two copper a stick, larger portions for five. Loud, generous, hates wasting a cut.',
  jsonb_build_object(
    'cartridge_id', 'grinhaven-full',
    'source_category', 'authored.market_square_demo_start',
    'home_id', 201236,
    'location_id', 201236,
    'current_location_id', 201236,
    'power_center_id', 201236,
    'power_center_role', 'venue',
    'venue_role', 'street food (varan grill)',
    'species', 'half-orc',
    'pronouns', 'she/her',
    'age', 37,
    'archetype', 'street food cook; first friendly buy of the day',
    'role', 'grill skewers of varan with ginger oil over open coals on a three-stones stall; bark prices in two languages',
    'speech_style', 'loud, friendly, blunt; counts change aloud; refuses to discount but will give a small skewer free to obvious first-timers',
    'personality', 'big-energy, body-confident, generous on portion. She apprenticed at the Sunfields camp and learned to butcher varan from her aunt. The smoke she pushes across the square is deliberate: it''s advertising.',
    'narrator_brief',
        'Vraska''s stall is the loudest landmark on the west side of '
     || 'the square. Three rocks, an iron rack, a basket of glistening '
     || 'skewers, a saucepan of ginger oil. She is mid-flip whenever '
     || 'the player approaches. Two copper a stick, five for a fat '
     || 'one. She will not haggle but she WILL push a small free '
     || 'skewer at a player who looks new. She is not a romantic '
     || 'option in the demo — she is a friendly first transaction.',
    'price_list', jsonb_build_object(
      'small_skewer', '2 copper',
      'fat_skewer', '5 copper',
      'three_for_a_silver', '1 silver'
    ),
    'aliases', jsonb_build_array('Vraska', 'Враска', 'Враска Синдерфанг')
  ),
  ARRAY['npc', 'demo_start', 'street_food', 'half_orc', 'authored']
)
ON CONFLICT (id) DO UPDATE
  SET kind = EXCLUDED.kind,
      display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags;

-- 3. Anchor scenes pinning the three NPCs to 201236.
INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES
  (250500, 'scene', 'Mikka''s Letter-Reading Corner',
   'Low folding table, oil lamp, abacus, ink-stained pad. Mikka reads letters aloud for a copper and answers one gossip question for the same coin. Curtained side-room access for paid private scenes is two doors east.',
   jsonb_build_object(
     'cartridge_id', 'grinhaven-full',
     'source_category', 'authored.market_square_demo_start',
     'location_id', 201236,
     'participant_entity_ids', jsonb_build_array(230501),
     'mood', 'transactional, warm',
     'tags', jsonb_build_array('market', 'mikka', 'info', 'paid_partner')
   ),
   ARRAY['scene', 'market', 'authored']),
  (250501, 'scene', 'The Velvet Tally Barker Arch',
   'Southwest arch of the market. Tilly and two other barkers loiter under a striped awning, flagging promising-looking foot traffic toward the Velvet Quarter. Small chalkboard with house names.',
   jsonb_build_object(
     'cartridge_id', 'grinhaven-full',
     'source_category', 'authored.market_square_demo_start',
     'location_id', 201236,
     'participant_entity_ids', jsonb_build_array(230502),
     'mood', 'public, flirtatious-on-commission',
     'tags', jsonb_build_array('market', 'barker', 'velvet_quarter_pipeline')
   ),
   ARRAY['scene', 'market', 'authored']),
  (250502, 'scene', 'Vraska''s Varan Stall',
   'Three-stones grill on the west side, iron rack, basket of glistening skewers, saucepan of ginger oil. Vraska barks prices in two languages and flips constantly.',
   jsonb_build_object(
     'cartridge_id', 'grinhaven-full',
     'source_category', 'authored.market_square_demo_start',
     'location_id', 201236,
     'participant_entity_ids', jsonb_build_array(230503),
     'mood', 'loud, generous, smoky',
     'tags', jsonb_build_array('market', 'street_food', 'first_purchase')
   ),
   ARRAY['scene', 'market', 'authored']),
  (250503, 'scene', 'The Brass Clock-Spike',
   'Centre of the square. A weathered brass spike on a stone plinth, struck every half-hour by a small mechanical hammer. The sound carries to the canal. Locals use it as a rendezvous landmark.',
   jsonb_build_object(
     'cartridge_id', 'grinhaven-full',
     'source_category', 'authored.market_square_demo_start',
     'location_id', 201236,
     'participant_entity_ids', jsonb_build_array(),
     'mood', 'public, neutral, time-anchored',
     'tags', jsonb_build_array('market', 'landmark', 'rendezvous')
   ),
   ARRAY['scene', 'market', 'landmark', 'authored']),
  (250504, 'scene', 'Market Square Buildings Walk',
   'Four buildings ring the square. North — Hearthreach Bank (granite, three storeys, gilded scales over the door). East — Pratts'' Cloth House (painted lintels, fabric bolts in the windows). West — Compact Customs Stoop (columned portico, two clerks always present). South — the canal arch (low stone bridge with toll-clerk and a chained ledger).',
   jsonb_build_object(
     'cartridge_id', 'grinhaven-full',
     'source_category', 'authored.market_square_demo_start',
     'location_id', 201236,
     'participant_entity_ids', jsonb_build_array(),
     'mood', 'public, civic',
     'tags', jsonb_build_array('market', 'buildings', 'lore')
   ),
   ARRAY['scene', 'market', 'lore', 'authored'])
ON CONFLICT (id) DO UPDATE
  SET kind = EXCLUDED.kind,
      display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags;

-- 4. Switch starting location to the market.
UPDATE cartridge_meta
   SET value = '201236'::jsonb,
       description = 'New players start in Grinhaven Main Market Square, the public demo onboarding hub.',
       updated_at = now()
 WHERE key IN ('starting_location_id', 'grinhaven_full_starting_location_id');

UPDATE entities
   SET profile = profile
              || jsonb_build_object(
                   'starting_location_id', 201236,
                   'starting_location_name', 'Grinhaven Main Market Square'
                 )
 WHERE id = 200000
   AND kind = 'world';

-- 5. Relocate existing players who are still parked at the old Ale & Eats
--    default. Leave players who have already moved elsewhere alone — they
--    chose to be where they are.
UPDATE players
   SET current_location_id = 201236,
       current_scene_id = NULL
 WHERE current_location_id = 201019;

-- 6. Refresh local_density for the market — strict ownership view picks up
--    the three new home_id pins, plus the four authored scenes.
UPDATE entities loc
   SET profile = jsonb_set(
       jsonb_set(
         jsonb_set(
           COALESCE(loc.profile, '{}'::jsonb),
           '{local_density,npc_ids}',
           (
             SELECT COALESCE(jsonb_agg(p.id ORDER BY p.id), '[]'::jsonb)
               FROM entities p
              WHERE p.kind = 'person'
                AND p.profile->>'home_id' = loc.id::text
           ),
           true
         ),
         '{local_density,scene_ids}',
         (
           SELECT COALESCE(jsonb_agg(s.id ORDER BY s.id), '[]'::jsonb)
             FROM entities s
            WHERE s.kind = 'scene'
              AND s.profile->>'location_id' = loc.id::text
         ),
         true
       ),
       '{local_density_summary,npc_count}',
       to_jsonb(
         (
           SELECT COUNT(*)::int
             FROM entities p
            WHERE p.kind = 'person'
              AND p.profile->>'home_id' = loc.id::text
         )
       ),
       true
     )
 WHERE loc.id = 201236
   AND loc.kind = 'location';

UPDATE entities loc
   SET profile = jsonb_set(
       COALESCE(loc.profile, '{}'::jsonb),
       '{local_density_summary,scene_count}',
       to_jsonb(
         (
           SELECT COUNT(*)::int
             FROM entities s
            WHERE s.kind = 'scene'
              AND s.profile->>'location_id' = loc.id::text
         )
       ),
       true
     )
 WHERE loc.id = 201236
   AND loc.kind = 'location';
