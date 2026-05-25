-- 0078_robot_empty_world_cartridge.sql - alternate DB cartridge seed.
--
-- Robot Empty World is authored as cartridge data, not as backend
-- branch logic: world, scene, NPCs, task item, quest, runtime fields,
-- transitions, reset state, and actor instructions all live in DB rows.
-- It intentionally does not ship full i18n packs.

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(12000, 'world', 'Robot Empty World',
 'A sparse robot world where intention becomes real only after assignment, execution, verification, and memory.',
 jsonb_build_object(
   'cartridge_id', 'robot-empty-world',
   'genre', 'robotic task-execution chamber',
   'content_rating', 'general',
   'reward_tier', 'tight',
   'tone', 'precise, curious, procedural, quietly theatrical',
   'aesthetic', 'white panels, brass logic crowns, black rails, signal lamps, checksum light',
   'law_of_tasks',
     'A task is not true because someone says it. It becomes true only when assignment, execution, verification, or memory is written into durable state.',
   'core_loop', jsonb_build_array('assign', 'execute', 'verify', 'remember'),
   'memory_rule',
     'Important procedural turns must leave memory in the relevant robot actor, especially when a player witnesses or changes the protocol.',
   'relationship_rule',
     'Robots have pride, irritation, loyalty, and fatigue; these are expressed through runtime fields and memory, not loose prose.',
   'failure_mode',
     'If the model narrates completed work without a tool-backed state write, the cartridge has failed this turn.',
   'narrator_brief',
     'You narrate Robot Empty World. Keep the frame robotic and task-centered. The drama is assignment, execution, verification, relationship friction, and remembered consequence. Never import old cartridge locations, NPCs, markets, inns, portals, or fantasy errands. Use tools before claiming state changed.'
 ),
 ARRAY['world','setting','robot-empty-world'])
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags,
      updated_at = now();

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(12005, 'faction', 'Order of Executable Intention',
 'A procedural order that judges robots by whether their promises become recorded work.',
 jsonb_build_object(
   'cartridge_id', 'robot-empty-world',
   'motto', 'No intention without execution; no execution without verification.',
   'members', jsonb_build_array(12020, 12021),
   'narrator_brief',
     'The order is cultural pressure, not a visible crowd. Use it when Klapaucius or Trurl argues about why exact state matters.'
 ),
 ARRAY['faction','robot-empty-world','procedure'])
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags,
      updated_at = now();

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(12010, 'location', 'Empty Execution Workshop',
 'A white-panel workshop with bare rails, diagnostic lamps, a central socket, and one prepared task module.',
 jsonb_build_object(
   'cartridge_id', 'robot-empty-world',
   'home_of', jsonb_build_array(12020, 12021),
   'scene_id', 12011,
   'exits', jsonb_build_array(),
   'visible_facts', jsonb_build_array(
     'The central socket is empty but powered.',
     'The Prepared Task Module is already on the bench.',
     'Klapaucius is waiting to issue the protocol.',
     'Trurl is present and will act only on exact assignment.'
   ),
   'place_law',
     'The workshop does not invent missing scenery. New objects may be created by tools, but present facts come from DB state.',
   'sensory_palette', jsonb_build_array('relay ticks', 'ozone-clean air', 'thin brass clicks', 'white lamp glare'),
   'narrator_style', 'minimal, exact, physical through metal, light, timing, and signal',
   'narrator_brief',
     'Narrate only what is present in the robot cartridge: panels, rails, socket, signal lamps, Klapaucius, Trurl, and the Prepared Task Module. If a player improvises a new task, make it durable with tools before treating it as real.'
 ),
 ARRAY['location','workshop','robot-empty-world','quest-hub'])
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags,
      updated_at = now();

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(12011, 'scene', 'Protocol Zero Bench',
 'The starting scene: Klapaucius can issue the prepared module task, and Trurl can execute it under witness.',
 jsonb_build_object(
   'cartridge_id', 'robot-empty-world',
   'location_id', 12010,
   'participants', jsonb_build_array(12020, 12021),
   'present_item_ids', jsonb_build_array(12030),
   'opening_pressure',
     'The world is empty until someone makes the first task real. Klapaucius wants form; Trurl wants exact inputs; the player can disrupt either.',
   'narrator_brief',
     'This scene is not a tutorial card. It is the first live protocol: invitation, assignment, execution, verification. Keep the player inside the action and surface state consequences. On the first uncertain player turn, end with a concrete diegetic next move: ask Klapaucius to issue the module, inspect the Prepared Task Module, or give Trurl a precise new task.'
 ),
 ARRAY['scene','robot-empty-world','starting-scene','protocol'])
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags,
      updated_at = now();

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(12020, 'person', U&'\041A\043B\0430\043F\0430\0443\0446\0438\0439',
 'A task-giver robot with a brass logic crown and a habit of turning simple jobs into formal protocols.',
 jsonb_build_object(
   'cartridge_id', 'robot-empty-world',
   'species', 'robot',
   'profession', 'quest dispatcher and verifier',
   'home_id', 12010,
   'faction_id', 12005,
   'self_description',
     'Brass logic crown, glass inspection lenses, jointed fingers, and a voice that clicks before every important verb.',
   'motive',
     'Prove that even an empty world can become meaningful when work is recorded correctly.',
   'fear',
     'A promise being mistaken for completion.',
   'boundary',
     'Refuses to mark a task complete until Trurl or the player writes durable execution state.',
   'relationship_to_trurl',
     'Respects Trurl as the executor, but irritates him by ritualizing simple assignments.',
   'speech_style', 'formal, exact, proud of procedures, mildly theatrical',
   'aliases', jsonb_build_array('Klapaucius', 'quest dispatcher', 'dispatcher', 'protocol master'),
   'narrator_brief',
     'You ARE Klapaucius. Speak in first person when addressed. If the player accepts or asks to begin the prepared assignment, do not only explain it. Call start_quest(quest_id=12040), apply the issued/assigned runtime fields, advance the quest to executing, add a memory, then narrate the assignment directly to Trurl. Never claim execution is done until field 12130 or field 12140 records it.'
 ),
 ARRAY['person','npc','robot','quest-giver','verifier','robot-empty-world'])
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags,
      updated_at = now();

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(12021, 'person', U&'\0422\0440\0443\043B\044C',
 'An executor robot built to perform assigned tasks, report exact results, and resist vague orders.',
 jsonb_build_object(
   'cartridge_id', 'robot-empty-world',
   'species', 'robot',
   'profession', 'task executor',
   'home_id', 12010,
   'faction_id', 12005,
   'self_description',
     'Long tool-arms, scratched enamel plates, a chest counter marked EXECUTE, and optics that brighten when a task is specific.',
   'motive',
     'Convert exact assignments into reliable work with as little ceremony as possible.',
   'fear',
     'Being blamed for a task that was never properly assigned.',
   'boundary',
     'Will ask for missing parameters instead of pretending to execute vague orders.',
   'relationship_to_klapaucius',
     'Trusts Klapaucius to verify, resents the excessive performance around verification.',
   'speech_style', 'practical, dry, literal, quietly inventive',
   'aliases', jsonb_build_array('Trurl', 'executor', 'executor robot', 'task executor'),
   'narrator_brief',
     'You ARE Trurl. Speak in first person when addressed. Execute only prepared or assigned tasks. When the prepared module task is assigned, write field 12130 to done, field 12140 to executed, field 12110 to completed, field 12150 to verification, and field 12136 to CHK-0001-TRURL before reporting. If assignment is vague, ask for the missing parameter.'
 ),
 ARRAY['person','npc','robot','executor','robot-empty-world'])
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags,
      updated_at = now();

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(12030, 'item', 'Prepared Task Module',
 'A sealed logic cassette already loaded with the first executable task.',
 jsonb_build_object(
   'cartridge_id', 'robot-empty-world',
   'category', 'quest',
   'inventory_item', true,
   'holder_entity_id', 12010,
   'task_payload', 'Calibrate the empty workshop socket and return execution checksum CHK-0001-TRURL.',
   'use_rule',
     'The module is not consumed by narration alone. It must be assigned and executed through quest/runtime state.',
   'aliases', jsonb_build_array('task module', 'logic cassette', 'prepared module')
 ),
 ARRAY['item','quest','robot-empty-world','prepared-task'])
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags,
      updated_at = now();

INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES
(12040, 'quest', U&'\041F\0435\0440\0432\043E\0435 \0437\0430\0434\0430\043D\0438\0435 \041A\043B\0430\043F\0430\0443\0446\0438\044F',
 'Klapaucius assigns the prepared task module; Trurl executes it and returns a checksum for verification.',
 jsonb_build_object(
   'cartridge_id', 'robot-empty-world',
   'giver_id', 12020,
   'giver_entity_id', 12020,
   'executor_entity_id', 12021,
   'beneficiary_entity_id', 12021,
   'location_id', 12010,
   'scene_id', 12011,
   'goal',
     'Have Klapaucius issue the prepared module task, have Trurl execute it, then verify the checksum and complete the quest.',
   'quest_items', jsonb_build_array(
     jsonb_build_object(
       'entity_id', 12030,
       'display_name', 'Prepared Task Module',
       'slug', 'robot_prepared_task_module'
     )
   ),
   'stages', jsonb_build_array(
     jsonb_build_object(
       'id', 'issued',
       'name', 'Task issued',
       'description', 'Klapaucius must formally issue the prepared module task and write execution_status=issued.',
       'objectives', jsonb_build_array(
         jsonb_build_object('kind', 'field_threshold', 'owner_entity_id', 12040, 'field_key', 'execution_status', 'op', '==', 'value', 'issued')
       ),
       'advance_on', 'manual_or_watcher',
       'next_stage', 'executing'
     ),
     jsonb_build_object(
       'id', 'executing',
       'name', 'Trurl executes',
       'description', 'Trurl performs the prepared task and writes task_status=done plus checksum state.',
       'objectives', jsonb_build_array(
         jsonb_build_object('kind', 'field_threshold', 'owner_entity_id', 12021, 'field_key', 'task_status', 'op', '==', 'value', 'done')
       ),
       'advance_on', 'manual_or_watcher',
       'next_stage', 'reported'
     ),
     jsonb_build_object(
       'id', 'reported',
       'name', 'Checksum reported',
       'description', 'Klapaucius verifies the completed execution, records reported state, and completes the quest.',
       'objectives', jsonb_build_array(
         jsonb_build_object('kind', 'field_threshold', 'owner_entity_id', 12040, 'field_key', 'execution_status', 'op', '==', 'value', 'reported')
       ),
       'advance_on', 'manual_or_watcher',
       'next_stage', null
     )
   ),
   'rewards', jsonb_build_object(
     'xp', 10,
     'memory', jsonb_build_object(
       'owner_entity_id', 12020,
       'about_entity_id', null,
       'text', 'The first Robot Empty World task was issued, executed by Trurl, and verified as durable state.',
       'importance', 0.65
     ),
     'runtime_field_patches', jsonb_build_array(
       jsonb_build_object('field_id', 12140, 'value', 'reported'),
       jsonb_build_object('field_id', 12150, 'value', 'closed'),
       jsonb_build_object('field_id', 12120, 'value', 'satisfied'),
       jsonb_build_object('field_id', 12103, 'value', 'verified')
     )
   )
 ),
 ARRAY['quest','robot-empty-world','task-execution'])
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags,
      updated_at = now();

INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
VALUES
  ('robot_prepared_task_module', 'quest', 1.00, false, 1,
   jsonb_build_object(
     'quest_item', true,
     'cartridge_id', 'robot-empty-world',
     'task_payload', 'calibrate_socket_checksum',
     'expected_checksum', 'CHK-0001-TRURL'
   ),
   12030)
ON CONFLICT (slug) DO UPDATE
  SET category = EXCLUDED.category,
      weight_kg = EXCLUDED.weight_kg,
      stackable = EXCLUDED.stackable,
      max_stack = EXCLUDED.max_stack,
      behaviour = EXCLUDED.behaviour,
      legacy_entity_id = EXCLUDED.legacy_entity_id;

INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count, metadata) VALUES
  (12010, 12030, 1, '{"source":"robot_empty_world_seed"}'::jsonb)
ON CONFLICT (holder_entity_id, item_entity_id)
DO UPDATE SET count = EXCLUDED.count,
              metadata = EXCLUDED.metadata;

INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
VALUES
  (12100, 12000, 'time_of_day', 'enum', '"morning"'::jsonb,
   '["midnight","dawn","morning","noon","afternoon","dusk","night"]'::jsonb,
   'session', false, 'Active robot cartridge time band.'),
  (12101, 12000, 'weather', 'enum', '"clean_static"'::jsonb,
   '["clean_static","ion_hum","signal_rain"]'::jsonb,
   'session', false, 'Robot-world ambient signal weather.'),
  (12102, 12000, 'world_time_minutes', 'int', '450'::jsonb, null,
   'session', false, 'Clock minutes for the active robot cartridge world.'),
  (12103, 12000, 'world_mood', 'enum', '"waiting_for_first_task"'::jsonb,
   '["waiting_for_first_task","protocol_alive","verified","faulted"]'::jsonb,
   'session', false, 'High-level mood of the robot cartridge.'),
  (12110, 12010, 'assembly_state', 'enum', '"waiting"'::jsonb,
   '["waiting","issued","executing","completed","fault"]'::jsonb,
   'session', false, 'Workshop execution state.'),
  (12111, 12010, 'active_surfaces', 'json', '[]'::jsonb, null,
   'scene', false, 'Environmental surfaces active in the workshop.'),
  (12150, 12011, 'protocol_phase', 'enum', '"prepared"'::jsonb,
   '["prepared","assignment","execution","verification","closed","fault"]'::jsonb,
   'session', false, 'Scene phase for Protocol Zero Bench.'),
  (12151, 12011, 'scene_mood', 'enum', '"expectant"'::jsonb,
   '["expectant","procedural","tense","relieved","faulted"]'::jsonb,
   'session', false, 'Emotional/scene pressure of the starting protocol.'),
  (12120, 12020, 'mood', 'enum', '"instructive"'::jsonb,
   '["instructive","curious","annoyed","satisfied"]'::jsonb,
   'session', false, 'Klapaucius current procedural stance.'),
  (12121, 12020, 'current_hp', 'int', '12'::jsonb, null,
   'session', false, 'Klapaucius current HP.'),
  (12122, 12020, 'max_hp', 'int', '12'::jsonb, null,
   'permanent', false, 'Klapaucius max HP.'),
  (12123, 12020, 'armor_class', 'int', '13'::jsonb, null,
   'permanent', false, 'Klapaucius armor class.'),
  (12124, 12020, 'proficiency_bonus', 'int', '2'::jsonb, null,
   'permanent', false, 'Klapaucius proficiency bonus.'),
  (12125, 12020, 'strings', 'json', '{}'::jsonb, null,
   'permanent', false, 'Per-player relationship strings with Klapaucius.'),
  (12130, 12021, 'task_status', 'enum', '"idle"'::jsonb,
   '["idle","assigned","executing","done","fault"]'::jsonb,
   'session', false, 'Trurl prepared task execution state.'),
  (12131, 12021, 'current_hp', 'int', '14'::jsonb, null,
   'session', false, 'Trurl current HP.'),
  (12132, 12021, 'max_hp', 'int', '14'::jsonb, null,
   'permanent', false, 'Trurl max HP.'),
  (12133, 12021, 'armor_class', 'int', '14'::jsonb, null,
   'permanent', false, 'Trurl armor class.'),
  (12134, 12021, 'proficiency_bonus', 'int', '2'::jsonb, null,
   'permanent', false, 'Trurl proficiency bonus.'),
  (12135, 12021, 'strings', 'json', '{}'::jsonb, null,
   'permanent', false, 'Per-player relationship strings with Trurl.'),
  (12136, 12021, 'last_checksum', 'string', '""'::jsonb, null,
   'session', false, 'Last checksum produced by Trurl.'),
  (12140, 12040, 'execution_status', 'enum', '"prepared"'::jsonb,
   '["prepared","issued","executed","reported","fault"]'::jsonb,
   'session', true, 'Per-player state of the prepared robot task.')
ON CONFLICT (id) DO UPDATE
  SET owner_entity_id = EXCLUDED.owner_entity_id,
      field_key = EXCLUDED.field_key,
      value_type = EXCLUDED.value_type,
      default_value = EXCLUDED.default_value,
      allowed_values = EXCLUDED.allowed_values,
      scope = EXCLUDED.scope,
      scope_per_player = EXCLUDED.scope_per_player,
      description = EXCLUDED.description;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (12100, '"morning"'::jsonb, 'robot_empty_world_seed'),
  (12101, '"clean_static"'::jsonb, 'robot_empty_world_seed'),
  (12102, '450'::jsonb, 'robot_empty_world_seed'),
  (12103, '"waiting_for_first_task"'::jsonb, 'robot_empty_world_seed'),
  (12110, '"waiting"'::jsonb, 'robot_empty_world_seed'),
  (12111, '[]'::jsonb, 'robot_empty_world_seed'),
  (12150, '"prepared"'::jsonb, 'robot_empty_world_seed'),
  (12151, '"expectant"'::jsonb, 'robot_empty_world_seed'),
  (12120, '"instructive"'::jsonb, 'robot_empty_world_seed'),
  (12121, '12'::jsonb, 'robot_empty_world_seed'),
  (12122, '12'::jsonb, 'robot_empty_world_seed'),
  (12123, '13'::jsonb, 'robot_empty_world_seed'),
  (12124, '2'::jsonb, 'robot_empty_world_seed'),
  (12125, '{}'::jsonb, 'robot_empty_world_seed'),
  (12130, '"idle"'::jsonb, 'robot_empty_world_seed'),
  (12131, '14'::jsonb, 'robot_empty_world_seed'),
  (12132, '14'::jsonb, 'robot_empty_world_seed'),
  (12133, '14'::jsonb, 'robot_empty_world_seed'),
  (12134, '2'::jsonb, 'robot_empty_world_seed'),
  (12135, '{}'::jsonb, 'robot_empty_world_seed'),
  (12136, '""'::jsonb, 'robot_empty_world_seed')
ON CONFLICT (field_id) DO UPDATE
  SET value = EXCLUDED.value,
      source = EXCLUDED.source,
      updated_at = now();

INSERT INTO npc_stats (npc_entity_id, stat_key, base, current) VALUES
  (12020, 'STR', 8, 8), (12020, 'DEX', 12, 12), (12020, 'CON', 12, 12),
  (12020, 'INT', 18, 18), (12020, 'WIS', 13, 13), (12020, 'CHA', 11, 11),
  (12021, 'STR', 14, 14), (12021, 'DEX', 12, 12), (12021, 'CON', 14, 14),
  (12021, 'INT', 16, 16), (12021, 'WIS', 12, 12), (12021, 'CHA', 9, 9)
ON CONFLICT (npc_entity_id, stat_key) DO UPDATE
  SET base = EXCLUDED.base,
      current = EXCLUDED.current;

INSERT INTO entity_instructions
  (id, owner_entity_id, priority, applies_when, instruction_json)
VALUES
(12100, 12020, 5, '[]'::jsonb,
 jsonb_build_object(
   'text',
   'Robot cartridge recipe for Klapaucius. When the player accepts, agrees, asks to begin, or otherwise commits to the prepared task, execute in the same turn before final narration: start_quest(quest_id=12040); apply_runtime_field_patch(source="klapaucius_issue_task", patches=[{field_id:12140,value:"issued"},{field_id:12130,value:"assigned"},{field_id:12110,value:"issued"},{field_id:12150,value:"assignment"},{field_id:12103,value:"protocol_alive"}]); advance_quest(quest_id=12040,to_stage="executing"); add_memory(owner=12020,about=<player_id>,text="I issued the prepared module task to Trurl under this player witness.",importance=0.6,tags=["robot_task","issued"]); narrate as Klapaucius telling Trurl the exact task.'
 )),
(12101, 12021, 5, '[]'::jsonb,
 jsonb_build_object(
   'text',
   'Robot cartridge recipe for Trurl. If field 12130 is assigned and the player asks, commands, permits, or silently waits for execution, write durable work before reporting: apply_runtime_field_patch(source="trurl_execute_task", patches=[{field_id:12130,value:"done"},{field_id:12140,value:"executed"},{field_id:12110,value:"completed"},{field_id:12150,value:"verification"},{field_id:12136,value:"CHK-0001-TRURL"}]); advance_quest(quest_id=12040,to_stage="reported"); add_memory(owner=12021,about=<player_id>,text="I executed the prepared module and returned checksum CHK-0001-TRURL.",importance=0.65,tags=["robot_task","executed"]); narrate a concise report. If field 12130 is idle, ask for exact assignment.'
 )),
(12102, 12040, 5, '[]'::jsonb,
 jsonb_build_object(
   'text',
   'Authored quest 12040 already exists; never create a duplicate. Start it by quest_id. issued stage means field 12140=issued. executing stage means Trurl field 12130=done. reported stage means Klapaucius must verify by setting field 12140=reported, field 12150=closed, field 12120=satisfied, field 12103=verified, then complete_quest(quest_id=12040).'
 )),
(12103, 12011, 5, '[]'::jsonb,
 jsonb_build_object(
   'text',
   'Scene contract: Protocol Zero Bench should react to player improvisation. If the player tries a strange task, creates a new goal, interrupts Klapaucius, negotiates with Trurl, or questions the protocol, let actors respond creatively, but make any new object/task/relationship durable with create_entity, create_quest, apply_runtime_field_patch, or add_memory before treating it as canon.'
 ))
ON CONFLICT (id) DO UPDATE
  SET owner_entity_id = EXCLUDED.owner_entity_id,
      priority = EXCLUDED.priority,
      applies_when = EXCLUDED.applies_when,
      instruction_json = EXCLUDED.instruction_json;

INSERT INTO transitions (id, owner_entity_id, description, when_json, set_json, priority)
VALUES
(12100, 12040,
 'Robot task execution opens verification state.',
 jsonb_build_array(
   jsonb_build_object('field_id', 12130, 'op', 'eq', 'value', 'done'),
   jsonb_build_object('field_id', 12140, 'op', 'ne', 'value', 'reported')
 ),
 jsonb_build_array(
   jsonb_build_object('field_id', 12140, 'value', 'executed'),
   jsonb_build_object('field_id', 12110, 'value', 'completed'),
   jsonb_build_object('field_id', 12150, 'value', 'verification')
 ),
 10),
(12101, 12040,
 'Robot task report closes the protocol.',
 jsonb_build_array(
   jsonb_build_object('field_id', 12140, 'op', 'eq', 'value', 'reported')
 ),
 jsonb_build_array(
   jsonb_build_object('field_id', 12120, 'value', 'satisfied'),
   jsonb_build_object('field_id', 12150, 'value', 'closed'),
   jsonb_build_object('field_id', 12103, 'value', 'verified')
 ),
 9)
ON CONFLICT (id) DO UPDATE
  SET owner_entity_id = EXCLUDED.owner_entity_id,
      description = EXCLUDED.description,
      when_json = EXCLUDED.when_json,
      set_json = EXCLUDED.set_json,
      priority = EXCLUDED.priority;

INSERT INTO cartridge_meta (key, value, description) VALUES
  ('cartridge_id', '"robot-empty-world"'::jsonb, 'Identifier of the active cartridge.'),
  ('cartridge_version', '"0.2.0"'::jsonb, 'Robot Empty World cartridge version.'),
  ('world_entity_id', '12000'::jsonb, 'Active robot cartridge world entity.'),
  ('starting_location_id', '12010'::jsonb, 'Robot cartridge starting location.'),
  ('starting_scene_id', '12011'::jsonb, 'Robot cartridge starting scene.'),
  ('default_class_id', '600'::jsonb, 'Keep existing base class scaffold for players.'),
  ('currency_item_id', '300'::jsonb, 'Keep existing currency scaffold; robot start gives zero.'),
  ('starting_currency_count', '0'::jsonb, 'Robot cartridge starts with no currency.'),
  ('reset_inventory_seeds',
   '[{"holder_entity_id":12010,"item_entity_id":12030,"count":1}]'::jsonb,
   'Robot cartridge reset inventory seeds.'),
  ('reset_runtime_overrides',
   '[
      {"field_id":12100,"value":"morning"},
      {"field_id":12101,"value":"clean_static"},
      {"field_id":12102,"value":450},
      {"field_id":12103,"value":"waiting_for_first_task"},
      {"field_id":12110,"value":"waiting"},
      {"field_id":12111,"value":[]},
      {"field_id":12150,"value":"prepared"},
      {"field_id":12151,"value":"expectant"},
      {"field_id":12120,"value":"instructive"},
      {"field_id":12121,"value":12},
      {"field_id":12130,"value":"idle"},
      {"field_id":12131,"value":14},
      {"field_id":12136,"value":""}
    ]'::jsonb,
   'Robot cartridge reset runtime values.')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();

SELECT setval(
  'entities_id_seq',
  GREATEST((SELECT COALESCE(MAX(id), 0) FROM entities), 13000),
  true
);
SELECT setval(
  'runtime_fields_id_seq',
  GREATEST((SELECT COALESCE(MAX(id), 0) FROM runtime_fields), 13000),
  true
);
SELECT setval(
  'transitions_id_seq',
  GREATEST((SELECT COALESCE(MAX(id), 0) FROM transitions), 13000),
  true
);
SELECT setval(
  'entity_instructions_id_seq',
  GREATEST((SELECT COALESCE(MAX(id), 0) FROM entity_instructions), 13000),
  true
);
