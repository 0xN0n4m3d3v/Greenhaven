import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupTurnTestEnvironment,
  queryRows,
  setupTurnTestEnvironment,
} from '../turn/framework.js';

let SaveSlotService: typeof import('../../services/SaveSlotService.js').SaveSlotService;
let SessionLifecycleService: typeof import('../../services/SessionLifecycleService.js').SessionLifecycleService;
let DebugService: typeof import('../../services/DebugService.js').DebugService;
let DebugDiagnosticsService: typeof import('../../services/DebugDiagnosticsService.js').DebugDiagnosticsService;
let debugDiagnosticsInternals: typeof import('../../services/DebugDiagnosticsService.js').debugDiagnosticsServiceInternals;
let safeJsonExtract: typeof import('../../safeJson.js').safeJsonExtract;
let extractPolishedText: typeof import('../../safeJson.js').extractPolishedText;
let characterAssistInternals: typeof import('../../services/CharacterAssistService.js').characterAssistServiceInternals;
let examinerInternals: typeof import('../../services/ExaminerSynthesisService.js').examinerSynthesisServiceInternals;
let AdventureService: typeof import('../../domain/adventure/AdventureService.js').AdventureService;
let CharacterService: typeof import('../../services/CharacterService.js').CharacterService;
let ProfileService: typeof import('../../services/ProfileService.js').ProfileService;
let WorldService: typeof import('../../services/WorldService.js').WorldService;
let AudioService: typeof import('../../services/AudioService.js').AudioService;
let HealthService: typeof import('../../services/HealthService.js').HealthService;
let MechanicI18nService: typeof import('../../services/MechanicI18nService.js').MechanicI18nService;
let PlayerIntroService: typeof import('../../services/PlayerIntroService.js').PlayerIntroService;
let PlayerStringsService: typeof import('../../services/PlayerStringsService.js').PlayerStringsService;
let QuestLogService: typeof import('../../services/QuestLogService.js').QuestLogService;
let QuoteService: typeof import('../../services/QuoteService.js').QuoteService;
let createAnonymousPlayer: typeof import('../../playerService.js').createAnonymousPlayer;
let listAdventureQueue: typeof import('../../domain/adventure/runtime/adventureQueue.js').listAdventureQueue;
let rateLimitTestHooks: typeof import('../../middleware/rateLimit.js').rateLimitTestHooks;
let sweepRateLimitBuckets: typeof import('../../middleware/rateLimit.js').sweepRateLimitBuckets;
let runWithTurnWatchdogForTest: typeof import('../../turnRunnerV2.js').runWithTurnWatchdogForTest;

beforeAll(async () => {
  await setupTurnTestEnvironment();
  ({SaveSlotService} = await import('../../services/SaveSlotService.js'));
  ({SessionLifecycleService} = await import(
    '../../services/SessionLifecycleService.js'
  ));
  ({DebugService} = await import('../../services/DebugService.js'));
  ({
    DebugDiagnosticsService,
    debugDiagnosticsServiceInternals: debugDiagnosticsInternals,
  } = await import('../../services/DebugDiagnosticsService.js'));
  ({safeJsonExtract, extractPolishedText} = await import('../../safeJson.js'));
  ({characterAssistServiceInternals: characterAssistInternals} = await import(
    '../../services/CharacterAssistService.js'
  ));
  ({examinerSynthesisServiceInternals: examinerInternals} = await import(
    '../../services/ExaminerSynthesisService.js'
  ));
  ({AdventureService} = await import('../../domain/adventure/AdventureService.js'));
  ({CharacterService} = await import('../../services/CharacterService.js'));
  ({ProfileService} = await import('../../services/ProfileService.js'));
  ({WorldService} = await import('../../services/WorldService.js'));
  ({AudioService} = await import('../../services/AudioService.js'));
  ({HealthService} = await import('../../services/HealthService.js'));
  ({MechanicI18nService} = await import(
    '../../services/MechanicI18nService.js'
  ));
  ({PlayerIntroService} = await import('../../services/PlayerIntroService.js'));
  ({PlayerStringsService} = await import(
    '../../services/PlayerStringsService.js'
  ));
  ({QuestLogService} = await import('../../services/QuestLogService.js'));
  ({QuoteService} = await import('../../services/QuoteService.js'));
  ({createAnonymousPlayer} = await import('../../playerService.js'));
  ({listAdventureQueue} = await import('../../domain/adventure/runtime/adventureQueue.js'));
  ({rateLimitTestHooks, sweepRateLimitBuckets} = await import(
    '../../middleware/rateLimit.js'
  ));
  ({runWithTurnWatchdogForTest} = await import('../../turnRunnerV2.js'));
});

afterAll(async () => {
  await cleanupTurnTestEnvironment();
});

describe('SaveSlotService', () => {
  it('lists, creates, and deletes save slots without Hono', async () => {
    const player = await createAnonymousPlayer('Save Service List Test');
    const created = await SaveSlotService.create(
      player.entity_id,
      'manual slot',
      false,
    );

    expect(created.id).toEqual(expect.any(Number));
    expect(created.size_bytes).toBeGreaterThan(0);

    const slots = await SaveSlotService.list(player.entity_id);
    expect(slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          slot_name: 'manual slot',
          is_auto: false,
        }),
      ]),
    );

    await SaveSlotService.delete(player.entity_id, created.id!);
    const remaining = await SaveSlotService.list(player.entity_id);
    expect(remaining.some(slot => slot.id === created.id)).toBe(false);
  });

  it('restores current schema rows from a snapshot', async () => {
    const player = await createAnonymousPlayer('Save Service Restore Test');
    const playerId = player.entity_id;
    const ownerId = await firstId(`SELECT id FROM entities WHERE kind = 'person'`);
    const itemId = await firstId(`SELECT id FROM items ORDER BY id LIMIT 1`);
    const questId = await firstId(
      `SELECT id FROM entities WHERE kind = 'quest' ORDER BY id LIMIT 1`,
    );
    const fieldId = await firstId(
      `SELECT id FROM runtime_fields
        WHERE owner_entity_id = $1 AND field_key = 'trauma'`,
      [playerId],
    );
    const sessionId = `save-service-${playerId}-${Date.now()}`;

    await queryRows(
      `INSERT INTO sessions (id, player_id) VALUES ($1, $2)`,
      [sessionId, playerId],
    );
    await queryRows(
      `INSERT INTO chat_messages
         (session_id, author_entity_id, tone, text, turn_index)
       VALUES ($1, $2, 'player', 'before snapshot', 1)`,
      [sessionId, playerId],
    );
    await queryRows(
      `INSERT INTO runtime_values (field_id, value, source)
       VALUES ($1, $2::jsonb, 'save-service-test')
       ON CONFLICT (field_id) DO UPDATE
         SET value = EXCLUDED.value, source = EXCLUDED.source`,
      [fieldId, JSON.stringify(['before'])],
    );
    await queryRows(
      `INSERT INTO player_stats (player_id, stat_key, base, current)
       VALUES ($1, 'SAVE_TEST', 3, 4)
       ON CONFLICT (player_id, stat_key)
       DO UPDATE SET base = EXCLUDED.base, current = EXCLUDED.current`,
      [playerId],
    );
    await queryRows(
      `INSERT INTO player_inventory
         (player_id, item_id, quantity, equipped, meta)
       VALUES ($1, $2, 2, false, $3::jsonb)`,
      [playerId, itemId, JSON.stringify({marker: 'before'})],
    );
    await queryRows(
      `INSERT INTO npc_memories
         (owner_entity_id, about_entity_id, text, importance, tags, sensitive,
          salience, source_turn_id, source_tool, metadata, memory_kind,
          memory_family)
       VALUES ($1, $2, 'remembered before save', 0.7,
               ARRAY['save-service']::text[], false, 0.9, 'turn-before',
               'unit-test', $3::jsonb, 'bond_memory', 'relationship')`,
      [ownerId, playerId, JSON.stringify({marker: 'before'})],
    );
    await queryRows(
      `INSERT INTO player_quests
         (player_id, quest_entity_id, status, current_phase,
          current_stage_id, accumulated_state, path_taken, started_at,
          metadata)
       VALUES ($1, $2, 'active', 2, 'stage-a', $3::jsonb, $4::jsonb,
               now(), $5::jsonb)
       ON CONFLICT (player_id, quest_entity_id) DO UPDATE
         SET status = EXCLUDED.status,
             current_phase = EXCLUDED.current_phase,
             current_stage_id = EXCLUDED.current_stage_id,
             accumulated_state = EXCLUDED.accumulated_state,
             path_taken = EXCLUDED.path_taken,
             metadata = EXCLUDED.metadata`,
      [
        playerId,
        questId,
        JSON.stringify({marker: 'before'}),
        JSON.stringify([{stage: 'stage-a'}]),
        JSON.stringify({source: 'save-service-test'}),
      ],
    );
    await queryRows(
      `INSERT INTO player_proficient_skills
         (player_id, skill_name, proficiency_level)
       VALUES ($1, 'Save Handling', 2)
       ON CONFLICT (player_id, skill_name)
       DO UPDATE SET proficiency_level = EXCLUDED.proficiency_level`,
      [playerId],
    );

    const created = await SaveSlotService.create(playerId, 'restore me', false);
    expect(created.id).toEqual(expect.any(Number));

    await queryRows(
      `UPDATE runtime_values SET value = $2::jsonb WHERE field_id = $1`,
      [fieldId, JSON.stringify(['after'])],
    );
    await queryRows(
      `UPDATE player_stats SET current = 99
        WHERE player_id = $1 AND stat_key = 'SAVE_TEST'`,
      [playerId],
    );
    await queryRows(
      `DELETE FROM player_inventory
        WHERE player_id = $1 AND meta->>'marker' = 'before'`,
      [playerId],
    );
    await queryRows(
      `DELETE FROM npc_memories
        WHERE about_entity_id = $1 AND tags @> ARRAY['save-service']::text[]`,
      [playerId],
    );
    await queryRows(
      `DELETE FROM player_quests
        WHERE player_id = $1 AND quest_entity_id = $2`,
      [playerId, questId],
    );
    await queryRows(
      `UPDATE player_proficient_skills SET proficiency_level = 1
        WHERE player_id = $1 AND skill_name = 'Save Handling'`,
      [playerId],
    );
    await queryRows(
      `INSERT INTO chat_messages
         (session_id, author_entity_id, tone, text, turn_index)
       VALUES ($1, $2, 'player', 'after snapshot', 2)`,
      [sessionId, playerId],
    );

    await expect(
      SaveSlotService.restore(playerId, created.id!),
    ).resolves.toBe(true);

    const runtime = await queryRows<{value: unknown}>(
      `SELECT value FROM runtime_values WHERE field_id = $1`,
      [fieldId],
    );
    expect(runtime[0]?.value).toEqual(['before']);

    const stats = await queryRows<{current: number}>(
      `SELECT current FROM player_stats
        WHERE player_id = $1 AND stat_key = 'SAVE_TEST'`,
      [playerId],
    );
    expect(Number(stats[0]?.current)).toBe(4);

    const inventory = await queryRows<{quantity: number; marker: string}>(
      `SELECT quantity, meta->>'marker' AS marker
         FROM player_inventory
        WHERE player_id = $1 AND meta->>'marker' = 'before'`,
      [playerId],
    );
    expect(inventory).toHaveLength(1);
    expect(Number(inventory[0]?.quantity)).toBe(2);

    const memories = await queryRows<{
      text: string;
      source_tool: string | null;
      memory_kind: string;
      memory_family: string;
      marker: string | null;
    }>(
      `SELECT text, source_tool, memory_kind, memory_family,
              metadata->>'marker' AS marker
         FROM npc_memories
        WHERE about_entity_id = $1
          AND tags @> ARRAY['save-service']::text[]`,
      [playerId],
    );
    expect(memories).toEqual([
      expect.objectContaining({
        text: 'remembered before save',
        source_tool: 'unit-test',
        memory_kind: 'bond_memory',
        memory_family: 'relationship',
        marker: 'before',
      }),
    ]);

    const quests = await queryRows<{
      current_phase: number;
      current_stage_id: string;
      marker: string | null;
      metadata_source: string | null;
      path_len: number;
    }>(
      `SELECT current_phase, current_stage_id,
              accumulated_state->>'marker' AS marker,
              metadata->>'source' AS metadata_source,
              jsonb_array_length(path_taken) AS path_len
         FROM player_quests
        WHERE player_id = $1 AND quest_entity_id = $2`,
      [playerId, questId],
    );
    expect(quests).toEqual([
      expect.objectContaining({
        current_phase: 2,
        current_stage_id: 'stage-a',
        marker: 'before',
        metadata_source: 'save-service-test',
        path_len: 1,
      }),
    ]);

    const skills = await queryRows<{proficiency_level: number}>(
      `SELECT proficiency_level
         FROM player_proficient_skills
        WHERE player_id = $1 AND skill_name = 'Save Handling'`,
      [playerId],
    );
    expect(Number(skills[0]?.proficiency_level)).toBe(2);

    const futureMessages = await queryRows<{n: number}>(
      `SELECT COUNT(*)::int AS n
         FROM chat_messages
        WHERE session_id = $1 AND text = 'after snapshot'`,
      [sessionId],
    );
    expect(Number(futureMessages[0]?.n)).toBe(0);
  });
});

describe('CharacterService', () => {
  it('applies stats and rejects invalid point-buy scores before writing', async () => {
    const player = await createAnonymousPlayer('Character Service Stats Test');
    const playerId = player.entity_id;

    await expect(
      CharacterService.applyStats(
        playerId,
        {STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8},
        'point_buy',
      ),
    ).resolves.toEqual({ok: true});

    const str = await queryRows<{current: number}>(
      `SELECT current FROM player_stats
        WHERE player_id = $1 AND stat_key = 'STR'`,
      [playerId],
    );
    expect(Number(str[0]?.current)).toBe(15);

    await expect(
      CharacterService.applyStats(
        playerId,
        {STR: 16, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8},
        'point_buy',
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'point-buy score out of range (8-15): 16',
    });

    const unchanged = await queryRows<{current: number}>(
      `SELECT current FROM player_stats
        WHERE player_id = $1 AND stat_key = 'STR'`,
      [playerId],
    );
    expect(Number(unchanged[0]?.current)).toBe(15);
  });

  it('applies skills transactionally and rejects duplicates before deleting', async () => {
    const player = await createAnonymousPlayer('Character Service Skills Test');
    const playerId = player.entity_id;

    await expect(
      CharacterService.applySkills(playerId, ['Acrobatics', 'Stealth']),
    ).resolves.toEqual({ok: true});

    await expect(
      CharacterService.applySkills(playerId, ['Acrobatics', 'Acrobatics']),
    ).resolves.toEqual({
      ok: false,
      error: 'duplicate skill: Acrobatics',
    });

    const skills = await queryRows<{skill_name: string}>(
      `SELECT skill_name FROM player_proficient_skills
        WHERE player_id = $1
        ORDER BY skill_name`,
      [playerId],
    );
    expect(skills.map(row => row.skill_name)).toEqual([
      'Acrobatics',
      'Stealth',
    ]);
  });
});

describe('ProfileService', () => {
  it('patches profile and keeps display name in sync with identity name', async () => {
    const player = await createAnonymousPlayer('Profile Service Test');
    const playerId = player.entity_id;

    const patched = await ProfileService.patch(playerId, {
      identity: {name: 'Renamed Profile Hero', pronouns: 'they/them'},
      created: true,
    });

    expect(patched?.display_name).toBe('Renamed Profile Hero');
    expect(patched?.profile).toEqual(
      expect.objectContaining({
        created: true,
        identity: expect.objectContaining({
          name: 'Renamed Profile Hero',
          pronouns: 'they/them',
        }),
      }),
    );

    const stored = await queryRows<{display_name: string}>(
      `SELECT display_name FROM entities WHERE id = $1`,
      [playerId],
    );
    expect(stored[0]?.display_name).toBe('Renamed Profile Hero');
  });

  it('returns null instead of fabricating an empty profile for unknown players', async () => {
    await expect(ProfileService.get(-999_001)).resolves.toBeNull();
    await expect(
      ProfileService.patch(-999_001, {identity: {name: 'Nobody'}}),
    ).resolves.toBeNull();
  });
});

describe('WorldService', () => {
  it('returns cartridge overview totals and entity kind counts', async () => {
    const overview = await WorldService.overview();

    expect(Object.keys(overview.cartridge_meta).length).toBeGreaterThan(0);
    expect(overview.entities_by_kind['player']).toEqual(expect.any(Number));
    expect(Number(overview.totals['runtime_fields'])).toBeGreaterThan(0);
  });

  it('returns full entity detail and null for unknown entities', async () => {
    const entityId = await firstId(
      `SELECT id FROM entities WHERE kind = 'person' ORDER BY id LIMIT 1`,
    );

    const detail = await WorldService.entity(entityId);
    expect(detail?.entity).toEqual(
      expect.objectContaining({id: entityId, kind: 'person'}),
    );
    expect(detail?.runtime.fields).toEqual(expect.any(Array));
    expect(detail?.inventory.held_by_this_entity).toEqual(expect.any(Array));

    await expect(WorldService.entity(-999_002)).resolves.toBeNull();
  });
});

describe('PlayerStringsService', () => {
  it('returns a player-only graph when no NPC strings target the player', async () => {
    const player = await createAnonymousPlayer('Strings Graph Empty Test');

    const graph = await PlayerStringsService.graph(player.entity_id, 'en');

    expect(graph).toEqual(
      expect.objectContaining({
        playerId: player.entity_id,
        edges: [],
      }),
    );
    expect(graph?.nodes).toEqual([
      expect.objectContaining({
        id: player.entity_id,
        kind: 'player',
      }),
    ]);
  });

  it('creates NPC edges from runtime string maps and returns null for unknown players', async () => {
    const player = await createAnonymousPlayer('Strings Graph Edge Test');
    const stringOwner = await queryRows<{
      field_id: number;
      npc_id: number;
      display_name: string;
    }>(
      `SELECT rf.id AS field_id, e.id AS npc_id, e.display_name
         FROM runtime_fields rf
         JOIN entities e ON e.id = rf.owner_entity_id
        WHERE rf.field_key = 'strings'
          AND e.kind = 'person'
        ORDER BY e.id
        LIMIT 1`,
    );
    const field = stringOwner[0];
    if (!field) throw new Error('no NPC strings runtime field in fixture');

    await queryRows(
      `INSERT INTO runtime_values (field_id, value, source)
       VALUES ($1, $2::jsonb, 'strings-service-test')
       ON CONFLICT (field_id) DO UPDATE
         SET value = EXCLUDED.value, source = EXCLUDED.source`,
      [field.field_id, JSON.stringify({[String(player.entity_id)]: 3})],
    );

    const graph = await PlayerStringsService.graph(player.entity_id, 'en');
    expect(graph?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({id: field.npc_id, kind: 'npc'}),
      ]),
    );
    expect(graph?.edges).toEqual([
      expect.objectContaining({
        from: player.entity_id,
        to: field.npc_id,
        valence: 'positive',
      }),
    ]);

    await expect(PlayerStringsService.graph(-999_003, 'en')).resolves.toBeNull();
  });
});

describe('PlayerIntroService', () => {
  it('returns a bootstrap intro only once for the current location', async () => {
    const player = await createAnonymousPlayer('Intro Service Test');

    const first = await PlayerIntroService.bootstrapIntroFor(player, 'en');
    expect(first).toEqual(
      expect.objectContaining({
        current_location_intro_bubble: expect.any(String),
        current_location_visit_count: 1,
      }),
    );

    const second = await PlayerIntroService.bootstrapIntroFor(player, 'en');
    expect(second).toBeNull();
  });
});

describe('AudioService', () => {
  it('loads known ambient beds and returns null for unknown slugs', async () => {
    const bed = await AudioService.bed('default_quiet');

    expect(bed).toEqual(
      expect.objectContaining({
        slug: 'default_quiet',
        foley_pool: expect.any(Array),
        sting_pool: expect.any(Array),
      }),
    );
    await expect(AudioService.bed('missing-bed')).resolves.toBeNull();
  });
});

describe('MechanicI18nService', () => {
  it('normalizes regional language codes and falls back to English keys', async () => {
    await queryRows(
      `INSERT INTO i18n_keys (key, category)
       VALUES ('unit.mechanic.localized', 'unit'),
              ('unit.mechanic.english_only', 'unit')
       ON CONFLICT (key) DO NOTHING`,
    );
    await queryRows(
      `INSERT INTO i18n_translations (key, lang, value)
       VALUES ('unit.mechanic.localized', 'en', 'English value'),
              ('unit.mechanic.localized', 'ru', 'Russian value'),
              ('unit.mechanic.english_only', 'en', 'English only')
       ON CONFLICT (key, lang) DO UPDATE SET value = EXCLUDED.value`,
    );

    const payload = await MechanicI18nService.map('ru-RU');

    expect(payload.lang).toBe('ru');
    expect(payload.map['unit.mechanic.localized']).toBe('Russian value');
    expect(payload.map['unit.mechanic.english_only']).toBe('English only');
  });
});

describe('QuoteService', () => {
  it('filters tag-specific quotes case-insensitively and keeps global quotes', async () => {
    await queryRows(
      `INSERT INTO loading_quotes (text_key, scene_tags, weight)
       VALUES ('unit.quote.tavern', ARRAY['tavern']::text[], 1),
              ('unit.quote.global', ARRAY[]::text[], 1)`,
    );

    const tavern = await QuoteService.quotes(['TAVERN']);
    expect(tavern.map(quote => quote.text_key)).toEqual(
      expect.arrayContaining(['unit.quote.tavern', 'unit.quote.global']),
    );

    const combat = await QuoteService.quotes(['combat']);
    expect(combat.map(quote => quote.text_key)).not.toContain(
      'unit.quote.tavern',
    );
    expect(combat.map(quote => quote.text_key)).toContain('unit.quote.global');
  });

  it('returns localized quote text with regional language fallback', async () => {
    await queryRows(
      `INSERT INTO i18n_keys (key, category)
       VALUES ('unit.quote.localized', 'quote')
       ON CONFLICT (key) DO NOTHING`,
    );
    await queryRows(
      `INSERT INTO i18n_translations (key, lang, value)
       VALUES ('unit.quote.localized', 'en', 'English quote'),
              ('unit.quote.localized', 'uk', 'Ukrainian quote text')
       ON CONFLICT (key, lang) DO UPDATE SET value = EXCLUDED.value`,
    );
    await queryRows(
      `INSERT INTO loading_quotes (text_key, scene_tags, weight)
       VALUES ('unit.quote.localized', ARRAY['unit-localized']::text[], 1)`,
    );

    const quotes = await QuoteService.localizedQuotes(
      ['unit-localized'],
      'uk-UA',
    );

    expect(quotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text_key: 'unit.quote.localized',
          text: 'Ukrainian quote text',
          language: 'uk',
        }),
      ]),
    );
  });
});

describe('HealthService', () => {
  it('counts tables with quoted identifiers safely', async () => {
    const tableName = 'unit health "quoted" table';
    await queryRows(`CREATE TABLE "unit health ""quoted"" table" (id int)`);
    await queryRows(
      `INSERT INTO "unit health ""quoted"" table" (id) VALUES (1), (2)`,
    );

    const counts = await HealthService.tableCounts();

    expect(counts[tableName]).toBe(2);
  });
});

describe('QuestLogService', () => {
  it('returns null for unknown players instead of an empty quest log', async () => {
    await expect(QuestLogService.log(-999_004, 'en')).resolves.toBeNull();
  });
});

describe('AdventureQueue', () => {
  it('defaults invalid limits instead of sending NaN to SQL LIMIT', async () => {
    await expect(
      listAdventureQueue({
        sessionId: `missing-session-${Date.now()}`,
        limit: Number.NaN,
      }),
    ).resolves.toEqual([]);
  });
});

describe('AdventureService', () => {
  it('lists player adventures through the service facade with invalid limits', async () => {
    const player = await createAnonymousPlayer('Adventure Service List Test');

    await expect(
      AdventureService.listPlayerAdventures({
        playerId: player.entity_id,
        limit: Number.NaN,
      }),
    ).resolves.toEqual([]);
  });
});

describe('SessionLifecycleService', () => {
  it('boots a fresh session and re-resolves it for the active playthrough', async () => {
    const player = await createAnonymousPlayer('Session Service Boot Test');
    const cartridgeId = `session-svc-cart-boot-${player.entity_id}-${Date.now()}`;
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, 'Session Boot Cartridge', '0.1', '1',
               'forge_project', 'sha256:session-boot')`,
      [cartridgeId],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, last_session_id
       )
       VALUES ($1, $2, 'active', NULL)`,
      [player.entity_id, cartridgeId],
    );

    const first = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId: player.entity_id,
    });
    expect(first.resolvedSessionId).toEqual(expect.any(String));
    expect(first.requestedSessionId).toBeNull();
    expect(first.autoResumed).toBe(false);

    const second = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId: player.entity_id,
      requestedSessionId: first.resolvedSessionId,
    });
    expect(second.resolvedSessionId).toBe(first.resolvedSessionId);
    expect(second.requestedSessionId).toBe(first.resolvedSessionId);
    expect(second.autoResumed).toBe(false);
    expect(second.session).toBe(first.session);

    const owned = await SessionLifecycleService.getOwned(
      first.resolvedSessionId,
      player.entity_id,
    );
    expect(owned?.id).toBe(first.resolvedSessionId);

    expect(
      await SessionLifecycleService.destroy(first.resolvedSessionId),
    ).toBe(true);
  });

  it('does not auto-resume stale chat_messages without an active playthrough', async () => {
    const player = await createAnonymousPlayer('Session Service Resume Test');
    const playerId = player.entity_id;

    const olderId = `session-svc-older-${playerId}-${Date.now()}`;
    const newerId = `session-svc-newer-${playerId}-${Date.now() + 1}`;
    await queryRows(`INSERT INTO sessions (id, player_id) VALUES ($1, $2)`, [
      olderId,
      playerId,
    ]);
    await queryRows(`INSERT INTO sessions (id, player_id) VALUES ($1, $2)`, [
      newerId,
      playerId,
    ]);
    await queryRows(
      `INSERT INTO chat_messages
         (session_id, author_entity_id, tone, text, turn_index, created_at)
       VALUES ($1, $2, 'player', 'older bubble', 1, now() - interval '1 hour')`,
      [olderId, playerId],
    );
    await queryRows(
      `INSERT INTO chat_messages
         (session_id, author_entity_id, tone, text, turn_index, created_at)
       VALUES ($1, $2, 'player', 'newer bubble', 1, now())`,
      [newerId, playerId],
    );

    const resolved = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId,
    });
    expect(resolved.resolvedSessionId).not.toBe(newerId);
    expect(resolved.resolvedSessionId).not.toBe(olderId);
    expect(resolved.autoResumed).toBe(false);
    const messages = await SessionLifecycleService.listMessages(
      resolved.resolvedSessionId,
      200,
    );
    expect(messages.count).toBe(0);

    await SessionLifecycleService.destroy(resolved.resolvedSessionId);
    await SessionLifecycleService.destroy(newerId);
    await SessionLifecycleService.destroy(olderId);
  });

  it('ignores a requested session when no active playthrough owns it', async () => {
    const player = await createAnonymousPlayer(
      'Session Service No Active Requested Test',
    );
    const playerId = player.entity_id;
    const staleId = `session-svc-no-active-stale-${playerId}-${Date.now()}`;
    await queryRows(`INSERT INTO sessions (id, player_id) VALUES ($1, $2)`, [
      staleId,
      playerId,
    ]);
    await queryRows(
      `INSERT INTO chat_messages
         (session_id, author_entity_id, tone, text, turn_index, created_at)
       VALUES ($1, $2, 'player', 'no active stale line', 1, now())`,
      [staleId, playerId],
    );

    const resolved = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId,
      requestedSessionId: staleId,
    });
    expect(resolved.resolvedSessionId).not.toBe(staleId);
    expect(resolved.requestedSessionId).toBe(staleId);
    const messages = await SessionLifecycleService.listMessages(
      resolved.resolvedSessionId,
      200,
    );
    expect(messages.count).toBe(0);

    await SessionLifecycleService.destroy(resolved.resolvedSessionId);
    await SessionLifecycleService.destroy(staleId);
  });

  it('mints a fresh session for an active playthrough with no last_session_id', async () => {
    const player = await createAnonymousPlayer(
      'Session Service Playthrough Fresh Test',
    );
    const playerId = player.entity_id;
    const cartridgeId = `session-svc-cart-fresh-${playerId}-${Date.now()}`;
    const staleId = `session-svc-stale-${playerId}-${Date.now()}`;
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, 'Session Fresh Cartridge', '0.1', '1',
               'forge_project', 'sha256:session-fresh')`,
      [cartridgeId],
    );
    await queryRows(`INSERT INTO sessions (id, player_id) VALUES ($1, $2)`, [
      staleId,
      playerId,
    ]);
    await queryRows(
      `INSERT INTO chat_messages
         (session_id, author_entity_id, tone, text, turn_index, created_at)
       VALUES ($1, $2, 'player', 'stale previous playthrough line', 1, now())`,
      [staleId, playerId],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, last_session_id
       )
       VALUES ($1, $2, 'active', NULL)`,
      [playerId, cartridgeId],
    );

    const resolved = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId,
    });
    expect(resolved.resolvedSessionId).not.toBe(staleId);
    expect(resolved.autoResumed).toBe(false);
    const state = await queryRows<{last_session_id: string | null}>(
      `SELECT last_session_id
         FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [playerId, cartridgeId],
    );
    expect(state[0]?.last_session_id).toBe(resolved.resolvedSessionId);

    await SessionLifecycleService.destroy(resolved.resolvedSessionId);
    await SessionLifecycleService.destroy(staleId);
  });

  it('ignores a stale requested session after playthrough launch cleared it', async () => {
    const player = await createAnonymousPlayer(
      'Session Service Stale Requested Test',
    );
    const playerId = player.entity_id;
    const cartridgeId = `session-svc-cart-requested-${playerId}-${Date.now()}`;
    const staleId = `session-svc-requested-stale-${playerId}-${Date.now()}`;
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, 'Session Requested Cartridge', '0.1', '1',
               'forge_project', 'sha256:session-requested')`,
      [cartridgeId],
    );
    await queryRows(`INSERT INTO sessions (id, player_id) VALUES ($1, $2)`, [
      staleId,
      playerId,
    ]);
    await queryRows(
      `INSERT INTO chat_messages
         (session_id, author_entity_id, tone, text, turn_index, created_at)
       VALUES ($1, $2, 'player', 'requested stale line', 1, now())`,
      [staleId, playerId],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, last_session_id
       )
       VALUES ($1, $2, 'active', NULL)`,
      [playerId, cartridgeId],
    );

    const resolved = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId,
      requestedSessionId: staleId,
    });
    expect(resolved.resolvedSessionId).not.toBe(staleId);
    expect(resolved.requestedSessionId).toBe(staleId);
    const messages = await SessionLifecycleService.listMessages(
      resolved.resolvedSessionId,
      200,
    );
    expect(messages.count).toBe(0);
    const state = await queryRows<{last_session_id: string | null}>(
      `SELECT last_session_id
         FROM hero_cartridge_states
        WHERE player_id = $1 AND cartridge_id = $2`,
      [playerId, cartridgeId],
    );
    expect(state[0]?.last_session_id).toBe(resolved.resolvedSessionId);

    await SessionLifecycleService.destroy(resolved.resolvedSessionId);
    await SessionLifecycleService.destroy(staleId);
  });

  it('returns null when getOwned targets an unknown session id', async () => {
    const player = await createAnonymousPlayer('Session Service Unknown Test');
    await expect(
      SessionLifecycleService.getOwned(
        `session-svc-missing-${player.entity_id}`,
        player.entity_id,
      ),
    ).resolves.toBeNull();
  });

  it('replays persisted chat_messages by turn order with a bounded limit', async () => {
    const player = await createAnonymousPlayer(
      'Session Service Messages Test',
    );
    const playerId = player.entity_id;
    const boot = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId,
    });
    const sessionId = boot.resolvedSessionId;

    await queryRows(
      `INSERT INTO chat_messages
         (session_id, author_entity_id, tone, text, turn_index)
       VALUES ($1, $2, 'player', 'first line', 1),
              ($1, $2, 'player', 'second line', 2),
              ($1, $2, 'player', 'third line', 3)`,
      [sessionId, playerId],
    );

    const all = await SessionLifecycleService.listMessages(sessionId, 200);
    expect(all.count).toBe(3);
    expect(all.limit).toBe(200);
    expect(all.messages.map(m => m.text)).toEqual([
      'first line',
      'second line',
      'third line',
    ]);

    const capped = await SessionLifecycleService.listMessages(sessionId, 2);
    expect(capped.count).toBe(2);
    expect(capped.limit).toBe(2);

    await SessionLifecycleService.destroy(sessionId);
  });

  it('reports an empty locations view when the player has no current location', async () => {
    const player = await createAnonymousPlayer(
      'Session Service Locations Test',
    );
    const playerId = player.entity_id;
    const cartridgeId = `session-svc-cart-empty-loc-${playerId}-${Date.now()}`;
    await queryRows(
      `INSERT INTO cartridges (id, title, version, schema_version,
                                source_kind, content_hash)
       VALUES ($1, 'Session Empty Location Cartridge', '0.1', '1',
               'forge_project', 'sha256:session-empty-location')`,
      [cartridgeId],
    );
    await queryRows(
      `INSERT INTO hero_cartridge_states (
         player_id, cartridge_id, status, current_location_id,
         current_scene_id, last_session_id
       )
       VALUES ($1, $2, 'active', NULL, NULL, NULL)`,
      [playerId, cartridgeId],
    );
    const boot = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId,
    });

    await queryRows(
      `UPDATE players SET current_location_id = NULL WHERE entity_id = $1`,
      [playerId],
    );

    const view = await SessionLifecycleService.loadLocationsView({
      session: boot.session,
      playerId,
    });
    expect(view).toEqual({
      current: null,
      exits: [],
      nearby: [],
      map: { nodes: [] },
    });

    await SessionLifecycleService.destroy(boot.resolvedSessionId);
  });

  it('returns an empty gui_events list and zero count for a fresh session', async () => {
    const player = await createAnonymousPlayer('Session Service Events Test');
    const boot = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId: player.entity_id,
    });

    const events = await SessionLifecycleService.listEvents({
      sessionId: boot.resolvedSessionId,
    });
    expect(events).toEqual({events: [], count: 0});

    const tolerant = await SessionLifecycleService.listEvents({
      sessionId: boot.resolvedSessionId,
      after: Number.NaN,
      afterReleaseSeq: Number.NaN,
      limit: Number.NaN,
    });
    expect(tolerant.count).toBe(0);

    await SessionLifecycleService.destroy(boot.resolvedSessionId);
  });

  it('returns a turn-queue snapshot with no active turn for a fresh session', async () => {
    const player = await createAnonymousPlayer('Session Service Queue Test');
    const boot = await SessionLifecycleService.resolveOrCreateForPlayer({
      playerId: player.entity_id,
    });

    const view = await SessionLifecycleService.getTurnQueueView(boot.session);
    expect(view.activeTurnId).toBeNull();
    expect(view.barrier).toBeNull();
    expect(view.maxQueued).toBeGreaterThan(0);
    expect(view.depth).toBe(0);
    expect(view.queuedDepth).toBe(0);
    expect(view.oldestQueuedAgeMs).toBe(0);
    expect(view.stuckRows).toEqual([]);
    expect(view.rows).toEqual([]);
    expect(view.presentationSlots).toEqual([]);

    await SessionLifecycleService.destroy(boot.resolvedSessionId);
  });
});

describe('rateLimit sweep', () => {
  it('removes stale exhausted buckets by age only', () => {
    rateLimitTestHooks.clear();
    const now = 1_000_000;
    rateLimitTestHooks.seed('turn:stale-exhausted', {
      tokens: 0,
      capacity: 10,
      updatedAt: now - 10 * 60_000,
    });
    rateLimitTestHooks.seed('turn:fresh-exhausted', {
      tokens: 0,
      capacity: 10,
      updatedAt: now - 30_000,
    });

    expect(sweepRateLimitBuckets(now)).toBe(1);
    expect(rateLimitTestHooks.size()).toBe(1);

    rateLimitTestHooks.clear();
  });
});

describe('turn watchdog', () => {
  it('clears the watchdog timer when the active turn is aborted', async () => {
    const abortController = new AbortController();
    const activeTurn = {
      turnId: 'watchdog-cancel-test',
      abortController,
      startedAt: Date.now(),
    };
    let emitted = 0;
    let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
    const promise = runWithTurnWatchdogForTest(
      {
        session: {
          id: 'watchdog-cancel-session',
          activeTurn,
          sse: {emit: () => void (emitted += 1)},
        } as never,
        input: {playerId: 1, text: 'cancel me'} as never,
        turnId: activeTurn.turnId,
        activeTurn: activeTurn as never,
        abortController,
        timeoutMs: 20,
      },
      () => new Promise<never>(() => {}),
    );
    promise.then(
      () => {
        settled = 'resolved';
      },
      () => {
        settled = 'rejected';
      },
    );

    abortController.abort(new Error('test cancel'));
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(settled).toBe('pending');
    expect(emitted).toBe(0);
  });
});

describe('DebugService', () => {
  it('rejects clearDialoguePartner without a positive integer playerId', async () => {
    await expect(
      DebugService.clearDialoguePartner(null),
    ).resolves.toEqual({status: 400, body: {error: 'playerId required'}});
    await expect(
      DebugService.clearDialoguePartner('abc'),
    ).resolves.toEqual({status: 400, body: {error: 'playerId required'}});
    await expect(
      DebugService.clearDialoguePartner('-3'),
    ).resolves.toEqual({status: 400, body: {error: 'playerId required'}});
  });

  it('rejects specialist triggers when their required input is missing', async () => {
    await expect(DebugService.runQuestWatcher({})).resolves.toEqual({
      status: 400,
      body: {error: 'playerId required'},
    });
    await expect(
      DebugService.runCombatDirector({playerProse: 'hi'}),
    ).resolves.toEqual({
      status: 400,
      body: {error: 'playerProse required (≥4 chars)'},
    });
    await expect(
      DebugService.runCatalogueScout({newEntities: []}),
    ).resolves.toEqual({
      status: 400,
      body: {error: 'newEntities array required'},
    });
    await expect(
      DebugService.runCartridgeSteward({tool: 'create_item', args: {}}),
    ).resolves.toEqual({
      status: 400,
      body: {error: 'tool must be create_entity or create_quest'},
    });
  });

  it('broadcasts a synthetic event to zero live sessions cleanly', async () => {
    const outcome = await DebugService.emitSyntheticEvent({
      type: 'debug:no_sessions',
      payload: {hello: 'world'},
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual(
      expect.objectContaining({
        ok: true,
        type: 'debug:no_sessions',
        sessions: expect.any(Number),
        clients: expect.any(Number),
      }),
    );
    expect((outcome.body['sessions'] as number) >= 0).toBe(true);
  });

  it('renders the verify summary for a mixed verdict set and flips status code', async () => {
    const verdicts = [
      {
        spec: 40,
        name: 'combat_director',
        endpoint: '/api/debug/run-combat-director',
        status: 'pass' as const,
        durationMs: 12,
        notes: 'ok',
      },
      {
        spec: 45,
        name: 'dialogue_anchor',
        endpoint: '/api/debug/run-dialogue-anchor',
        status: 'skipped' as const,
        durationMs: 3,
        notes: 'no partner',
      },
      {
        spec: 46,
        name: 'movement_warden',
        endpoint: '/api/debug/run-movement-warden',
        status: 'fail' as const,
        durationMs: 8,
        notes: 'missing flag',
      },
    ];
    expect(DebugService.summarizeVerdicts(verdicts)).toEqual({
      pass: 1,
      skipped: 1,
      fail: 1,
      total: 3,
    });
    expect(DebugService.summarizeVerdicts([])).toEqual({
      pass: 0,
      skipped: 0,
      fail: 0,
      total: 0,
    });
  });

  it('returns 500 when verify-specialists has no fetch handle available', async () => {
    const priorGlobal = (globalThis as Record<string, unknown>)[
      '__greenhavenApp'
    ];
    delete (globalThis as Record<string, unknown>)['__greenhavenApp'];
    try {
      const outcome = await DebugService.verifySpecialists({playerId: 1000});
      expect(outcome.status).toBe(500);
      expect(outcome.body).toEqual(
        expect.objectContaining({
          error: expect.stringContaining('verify-specialists requires'),
        }),
      );
    } finally {
      if (priorGlobal !== undefined) {
        (globalThis as Record<string, unknown>)['__greenhavenApp'] =
          priorGlobal;
      }
    }
  });

  it('prefers the route-provided app fetch over the global fallback', () => {
    const routeFetch = async () => new Response('{}');
    const globalFetch = async () => new Response('{}');
    const priorGlobal = (globalThis as Record<string, unknown>)[
      '__greenhavenApp'
    ];
    (globalThis as Record<string, unknown>)['__greenhavenApp'] = {
      fetch: globalFetch,
    };
    try {
      expect(
        DebugService.resolveAppFetch({fetch: routeFetch}),
      ).toBe(routeFetch);
      expect(DebugService.resolveAppFetch()).toBe(globalFetch);
    } finally {
      if (priorGlobal === undefined) {
        delete (globalThis as Record<string, unknown>)['__greenhavenApp'];
      } else {
        (globalThis as Record<string, unknown>)['__greenhavenApp'] =
          priorGlobal;
      }
    }
  });

  it('builds the fixed verify matrix with eleven specialists for the given playerId', () => {
    const tests = DebugService.buildVerifyTests(4242);
    expect(tests).toHaveLength(11);
    expect(tests.map(t => t.spec)).toEqual([
      39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
    ]);
    expect(tests.map(t => t.endpoint)).toEqual([
      '/api/debug/run-quest-watcher',
      '/api/debug/run-combat-director',
      '/api/debug/run-intimacy-coordinator',
      '/api/debug/run-catalogue-scout',
      '/api/debug/run-npc-voice',
      '/api/debug/run-scene-painter',
      '/api/debug/run-dialogue-anchor',
      '/api/debug/run-movement-warden',
      '/api/debug/run-reward-calibrator',
      '/api/debug/run-cartridge-steward',
      '/api/debug/run-quest-pacer',
    ]);
    const watcher = tests[0]!;
    expect(watcher.body).toEqual({playerId: 4242, forceLLM: true});
    expect(
      watcher.check({watcher_ran: true}),
    ).toEqual({status: 'pass', notes: 'watcher_ran=true'});
    expect(
      watcher.check({watcher_ran: false}),
    ).toEqual(
      expect.objectContaining({status: 'fail'}),
    );
  });

  it('records non-JSON responses as fail with the raw text snippet', async () => {
    const fetchFn = async () =>
      new Response('not json at all', {status: 200});
    const verdict = await DebugService.runOneVerifyTest(
      {
        spec: 99,
        name: 'test',
        endpoint: '/api/debug/run-fake',
        body: {},
        check: () => ({status: 'pass', notes: 'unreachable'}),
      },
      fetchFn,
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.notes).toContain('non-JSON response');
    expect(verdict.rawSnippet).toContain('not json');
  });

  it('records HTTP error responses as fail and surfaces the parsed error field', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({error: 'playerId required'}), {
        status: 400,
        headers: {'content-type': 'application/json'},
      });
    const verdict = await DebugService.runOneVerifyTest(
      {
        spec: 99,
        name: 'test',
        endpoint: '/api/debug/run-fake',
        body: {},
        check: () => ({status: 'pass', notes: 'unreachable'}),
      },
      fetchFn,
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.notes).toBe('HTTP 400: playerId required');
  });

  it('records thrown fetch errors as fail with the message', async () => {
    const fetchFn = async () => {
      throw new Error('connection refused');
    };
    const verdict = await DebugService.runOneVerifyTest(
      {
        spec: 99,
        name: 'test',
        endpoint: '/api/debug/run-fake',
        body: {},
        check: () => ({status: 'pass', notes: 'unreachable'}),
      },
      fetchFn,
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.notes).toContain('connection refused');
  });
});

describe('DebugDiagnosticsService', () => {
  it('parses positive ints and rejects everything else', () => {
    expect(debugDiagnosticsInternals.coercePositiveInt(7)).toBe(7);
    expect(debugDiagnosticsInternals.coercePositiveInt('42')).toBe(42);
    expect(debugDiagnosticsInternals.coercePositiveInt('-1')).toBeNull();
    expect(debugDiagnosticsInternals.coercePositiveInt('abc')).toBeNull();
    expect(debugDiagnosticsInternals.coercePositiveInt(null)).toBeNull();
    expect(debugDiagnosticsInternals.coercePositiveInt(undefined)).toBeNull();
    expect(debugDiagnosticsInternals.coercePositiveInt(0)).toBeNull();
  });

  it('recognizes ISO timestamps and rejects free-form strings', () => {
    expect(
      debugDiagnosticsInternals.looksLikeIsoTimestamp(
        '2026-05-15T10:11:12.000Z',
      ),
    ).toBe(true);
    expect(debugDiagnosticsInternals.looksLikeIsoTimestamp('2026-05-15')).toBe(
      false,
    );
    expect(debugDiagnosticsInternals.looksLikeIsoTimestamp('not a date')).toBe(
      false,
    );
    expect(debugDiagnosticsInternals.looksLikeIsoTimestamp(null)).toBe(false);
  });

  it('falls back to a 24h interval when sinceParam is missing or malformed', () => {
    expect(debugDiagnosticsInternals.safeSinceClauseAndParams(null)).toEqual({
      clause: `now() - interval '24 hours'`,
      params: [],
    });
    expect(debugDiagnosticsInternals.safeSinceClauseAndParams('')).toEqual({
      clause: `now() - interval '24 hours'`,
      params: [],
    });
    expect(
      debugDiagnosticsInternals.safeSinceClauseAndParams('robert%; DROP'),
    ).toEqual({clause: `now() - interval '24 hours'`, params: []});
    expect(
      debugDiagnosticsInternals.safeSinceClauseAndParams(
        '2026-05-15T00:00:00Z',
      ),
    ).toEqual({
      clause: `$1::timestamptz`,
      params: ['2026-05-15T00:00:00Z'],
    });
  });

  it('uses the supplied since override when it looks like an ISO timestamp', () => {
    const stub = (minutes: number) => `now-minus-${minutes}m`;
    expect(
      debugDiagnosticsInternals.computeSince(
        {since: '2026-05-15T01:02:03.000Z', minutes: 999},
        stub,
      ),
    ).toBe('2026-05-15T01:02:03.000Z');
    expect(
      debugDiagnosticsInternals.computeSince(
        {since: null, minutes: 90},
        stub,
      ),
    ).toBe('now-minus-90m');
    expect(
      debugDiagnosticsInternals.computeSince({since: 'bogus'}, stub),
    ).toBe('now-minus-60m');
  });

  it('rejects live-playtest endpoints when playerId is missing or non-positive', async () => {
    await expect(
      DebugDiagnosticsService.getLiveState({playerId: null}),
    ).resolves.toEqual({status: 400, body: {error: 'playerId_required'}});
    await expect(
      DebugDiagnosticsService.postLiveOps({playerId: 0, ops: []}),
    ).resolves.toEqual({status: 400, body: {error: 'playerId_required'}});
    await expect(
      DebugDiagnosticsService.postLivePreset({playerId: -5, preset: 'x'}),
    ).resolves.toEqual({status: 400, body: {error: 'playerId_required'}});
  });

  it('rejects live-preset when the preset slug is empty', async () => {
    await expect(
      DebugDiagnosticsService.postLivePreset({
        playerId: 1000,
        preset: '   ',
      }),
    ).resolves.toEqual({status: 400, body: {error: 'preset_required'}});
    await expect(
      DebugDiagnosticsService.postLivePreset({playerId: 1000, preset: null}),
    ).resolves.toEqual({status: 400, body: {error: 'preset_required'}});
  });

  it('rejects turn-scoped diagnostics when the turnId param is missing', async () => {
    await expect(DebugDiagnosticsService.getPerfTurn(undefined)).resolves.toEqual({
      status: 400,
      body: {error: 'turnId required'},
    });
    await expect(
      DebugDiagnosticsService.getTelemetryTurn(undefined),
    ).resolves.toEqual({status: 400, body: {error: 'turnId required'}});
    await expect(
      DebugDiagnosticsService.getTelemetryTrace(undefined),
    ).resolves.toEqual({status: 400, body: {error: 'traceId required'}});
  });

  it('gates admin usage on prod + admin-key requirements deterministically', () => {
    expect(
      DebugDiagnosticsService.checkAdminAccess({
        nodeEnv: 'production',
        adminKey: null,
        adminKeyHeader: null,
      }),
    ).toEqual({status: 403, body: {error: 'admin_key_required'}});
    expect(
      DebugDiagnosticsService.checkAdminAccess({
        nodeEnv: 'production',
        adminKey: 'secret',
        adminKeyHeader: 'wrong',
      }),
    ).toEqual({status: 403, body: {error: 'forbidden'}});
    expect(
      DebugDiagnosticsService.checkAdminAccess({
        nodeEnv: 'production',
        adminKey: 'secret',
        adminKeyHeader: 'secret',
      }),
    ).toBeNull();
    expect(
      DebugDiagnosticsService.checkAdminAccess({
        nodeEnv: 'development',
        adminKey: null,
        adminKeyHeader: null,
      }),
    ).toBeNull();
    expect(
      DebugDiagnosticsService.checkAdminAccess({
        nodeEnv: 'development',
        adminKey: 'secret',
        adminKeyHeader: null,
      }),
    ).toEqual({status: 403, body: {error: 'forbidden'}});
  });

  it('returns shape-stable cost telemetry against the test database', async () => {
    const outcome = await DebugDiagnosticsService.getCost({since: null});
    expect(outcome.status).toBe(200);
    const body = outcome.body as {
      totals: {n: number; cost: string};
      byRole: unknown[];
      recent: unknown[];
    };
    expect(body.totals).toEqual(
      expect.objectContaining({n: expect.any(Number), cost: expect.any(String)}),
    );
    expect(Array.isArray(body.byRole)).toBe(true);
    expect(Array.isArray(body.recent)).toBe(true);
  });

  it('returns a recent-entities array from the fixture DB', async () => {
    const outcome = await DebugDiagnosticsService.getRecentEntities();
    expect(outcome.status).toBe(200);
    expect(Array.isArray((outcome.body as {entities: unknown[]}).entities)).toBe(
      true,
    );
  });
});

describe('safeJsonExtract / extractPolishedText', () => {
  it('parses a clean JSON object', () => {
    expect(safeJsonExtract('{"a":1,"b":"two"}')).toEqual({a: 1, b: 'two'});
  });

  it('strips ```json fences before parsing', () => {
    expect(safeJsonExtract('```json\n{"ok":true}\n```')).toEqual({ok: true});
    expect(safeJsonExtract('```\n{"ok":true}\n```')).toEqual({ok: true});
  });

  it('locates an embedded JSON object inside surrounding prose', () => {
    expect(
      safeJsonExtract(
        'Here is the answer: {"build":"slim","voice":"low"} — hope it helps.',
      ),
    ).toEqual({build: 'slim', voice: 'low'});
  });

  it('returns null for unparseable input', () => {
    expect(safeJsonExtract('no json here at all')).toBeNull();
    expect(safeJsonExtract('{ broken json without close')).toBeNull();
    expect(safeJsonExtract('')).toBeNull();
  });

  it('reads the text field when polished output is JSON-wrapped', () => {
    expect(extractPolishedText('{"text":"  polished prose  "}')).toBe(
      'polished prose',
    );
  });

  it('falls back to plain text when polished output is not JSON', () => {
    expect(extractPolishedText('  plain polished prose  ')).toBe(
      'plain polished prose',
    );
    expect(extractPolishedText('```text\npolished\n```')).toBe('polished');
  });
});

describe('CharacterAssistService internals', () => {
  it('returns JSON parsed from clean output', () => {
    const outcome = characterAssistInternals.buildJsonOrRawResponse(
      '{"build":"trim","voice":"hush"}',
    );
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({build: 'trim', voice: 'hush'});
  });

  it('falls back to {raw} when the model text is not parseable JSON', () => {
    const outcome = characterAssistInternals.buildJsonOrRawResponse(
      'sorry I could not comply',
    );
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({raw: 'sorry I could not comply'});
  });

  it('extracts polished prose from JSON-shaped output', () => {
    const outcome = characterAssistInternals.buildPolishedResponse(
      '{"text":"new polished line"}',
      'fallback line',
    );
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({text: 'new polished line'});
  });

  it('uses the caller-provided fallback when polished output is empty', () => {
    const outcome = characterAssistInternals.buildPolishedResponse(
      '',
      'fallback line',
    );
    expect(outcome.body).toEqual({text: 'fallback line'});
  });

  it('maps an Error into a 500 outcome with an opaque body + correlation id (SEC-3)', () => {
    const outcome = characterAssistInternals.errorOutcome(
      new Error('upstream model timeout'),
    );
    expect(outcome.status).toBe(500);
    expect(outcome.body).toEqual({
      error: 'character_assist_failed',
      correlation_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });
    // The internal exception message is never placed in the body.
    expect(JSON.stringify(outcome.body)).not.toContain('upstream model timeout');
  });

  it('does not stringify non-Error thrown values into the 500 body (SEC-3)', () => {
    const outcome = characterAssistInternals.errorOutcome(
      'string-shaped failure',
    );
    expect(outcome.status).toBe(500);
    expect(outcome.body).toEqual({
      error: 'character_assist_failed',
      correlation_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });
    expect(JSON.stringify(outcome.body)).not.toContain('string-shaped failure');
  });

  it('grounds appearance prompts in every identity field that is set', () => {
    const prompt = characterAssistInternals.appearancePrompt({
      identity: {
        pronouns: 'she/they',
        race: 'tiefling',
        anatomy: 'intersex',
        attractions: 'curious',
        age: 28,
      },
      partial_physical: {
        build: 'wiry',
      },
      free_text: 'looks like a sailor',
    });
    expect(prompt).toContain('pronouns: she/they');
    expect(prompt).toContain('race: tiefling');
    expect(prompt).toContain('age: 28');
    expect(prompt).toContain('looks like a sailor');
    expect(prompt).toContain('LOCKED');
    expect(prompt).toContain('build: "wiry"');
  });

  it('caps the parse-freeform prompt at 3500 characters of input', () => {
    const huge = 'x'.repeat(5000);
    const prompt = characterAssistInternals.parsePrompt(huge);
    const inside = prompt.split('"""')[1] ?? '';
    expect(inside.length).toBe(3500);
  });
});

describe('ExaminerSynthesisService internals', () => {
  const transcript = [
    {q: 'name?', a: 'Mara Lightstep'},
    {q: 'describe?', a: 'a hard-edged messenger with bright eyes'},
    {q: 'history?', a: 'fled north after a portal opened on her childhood street'},
  ];

  it('falls back to point-buy defaults when stats are missing or invalid', () => {
    expect(examinerInternals.cleanStats(null)).toEqual(
      examinerInternals.DEFAULT_SYNTHESIS_STATS,
    );
    expect(examinerInternals.cleanStats({STR: 99, DEX: 14, CON: 12, INT: 10, WIS: 15, CHA: 8})).toEqual(
      examinerInternals.DEFAULT_SYNTHESIS_STATS,
    );
    expect(
      examinerInternals.cleanStats({
        STR: 13,
        DEX: 14,
        CON: 12,
        INT: 10,
        WIS: 15,
        CHA: 8,
      }),
    ).toEqual({STR: 13, DEX: 14, CON: 12, INT: 10, WIS: 15, CHA: 8});
  });

  it('repairs missing identity/physical/background from transcript hints', () => {
    const repaired = examinerInternals.repairSynthesisJson({}, transcript);
    expect(repaired['identity']).toEqual(
      expect.objectContaining({
        name: 'Mara Lightstep',
        pronouns: 'player-defined pronouns',
        age: 30,
      }),
    );
    expect(repaired['physical']).toEqual(
      expect.objectContaining({build: expect.any(String)}),
    );
    expect(repaired['background']).toEqual(
      expect.objectContaining({
        origin_paragraph: expect.stringContaining('fled north'),
        notable_skills: expect.any(Array),
      }),
    );
  });

  it('clamps the starting class id and picks fallback skills from the allowed list', () => {
    const repaired = examinerInternals.repairSynthesisJson(
      {starting_class_id: 999, skills: ['BogusSkill']},
      transcript,
    );
    expect(repaired['starting_class_id']).toBe(600);
    const skills = repaired['skills'] as string[];
    expect(Array.isArray(skills)).toBe(true);
    const allowed =
      examinerInternals.CLASS_SKILL_CHOICES[600]?.from ?? [];
    for (const skill of skills) {
      expect(allowed).toContain(skill);
    }
    expect(skills.length).toBe(
      examinerInternals.CLASS_SKILL_CHOICES[600]?.pick,
    );
  });

  it('keeps skills already chosen from the class list and pads from defaults', () => {
    const repaired = examinerInternals.repairSynthesisJson(
      {
        starting_class_id: 601,
        skills: ['Deception', 'Stealth', 'BogusSkill', 'Stealth'],
      },
      transcript,
    );
    const skills = repaired['skills'] as string[];
    expect(skills.slice(0, 2)).toEqual(['Deception', 'Stealth']);
    expect(skills.length).toBe(
      examinerInternals.CLASS_SKILL_CHOICES[601]?.pick,
    );
    expect(new Set(skills).size).toBe(skills.length);
  });

  it('normalizes detected_language to a 2-letter lowercase code', () => {
    expect(examinerInternals.normalizeDetectedLanguage('RU-ru')).toBe('ru');
    expect(examinerInternals.normalizeDetectedLanguage('English')).toBe('en');
    expect(examinerInternals.normalizeDetectedLanguage(null)).toBeNull();
    expect(examinerInternals.normalizeDetectedLanguage(42)).toBeNull();
    expect(examinerInternals.normalizeDetectedLanguage('')).toBeNull();
  });

  it('finalizeSynthesisJson sets input_language, stats_valid/spent, and clamps class id', () => {
    const final = examinerInternals.finalizeSynthesisJson(
      {
        detected_language: 'EN-us',
        stats: {STR: 13, DEX: 14, CON: 12, INT: 10, WIS: 15, CHA: 8},
        starting_class_id: 9999,
      },
      transcript,
      null,
    );
    expect(final['detected_language']).toBe('en');
    expect(final['input_language']).toBe('en');
    expect(final['stats_valid']).toBe(true);
    expect(typeof final['stats_spent']).toBe('number');
    expect(final['starting_class_id']).toBe(600);
  });

  it('flags non-point-buy stats with stats_valid=false but still surfaces the spend', () => {
    const final = examinerInternals.finalizeSynthesisJson(
      {
        stats: {STR: 99, DEX: 14, CON: 12, INT: 10, WIS: 15, CHA: 8},
      },
      transcript,
      null,
    );
    // cleanStats inside repair will replace the invalid stats with the
    // point-buy default, so the surfaced stats are valid by the time
    // applyStatsValidation runs.
    expect(final['stats_valid']).toBe(true);
    expect(final['stats']).toEqual(examinerInternals.DEFAULT_SYNTHESIS_STATS);
  });

  it('produces a 500 unparseable outcome with an opaque body + correlation id (SEC-3)', () => {
    const outcome = examinerInternals.buildUnparseableOutcome(
      'I cannot comply',
      'length',
      {inputTokens: 10, outputTokens: 5},
    );
    expect(outcome.status).toBe(500);
    expect(outcome.body).toEqual({
      error: 'synthesis_unparseable',
      correlation_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });
    // Raw model output, finishReason, and usage must NOT appear in
    // the wire body. They remain available for ops via the
    // `http.error` telemetry record + the `console.warn` line.
    const wire = JSON.stringify(outcome.body);
    expect(wire).not.toContain('I cannot comply');
    expect(wire).not.toContain('length');
    expect(wire).not.toContain('inputTokens');
  });

  it('produces a 500 throw outcome with an opaque body + correlation id (SEC-3)', () => {
    const errOutcome = examinerInternals.buildThrowOutcome(
      new Error('upstream timeout'),
    );
    expect(errOutcome.status).toBe(500);
    expect(errOutcome.body).toEqual({
      error: 'synthesis_failed',
      correlation_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });
    expect(JSON.stringify(errOutcome.body)).not.toContain('upstream timeout');

    const stringOutcome = examinerInternals.buildThrowOutcome(
      'string-shaped failure',
    );
    expect(stringOutcome.status).toBe(500);
    expect(stringOutcome.body).toEqual({
      error: 'synthesis_failed',
      correlation_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });
    expect(JSON.stringify(stringOutcome.body)).not.toContain(
      'string-shaped failure',
    );
  });

  it('builds prompt state with caller language overriding partialState language', () => {
    const state = examinerInternals.buildPromptState({
      transcript,
      partialState: {language: 'ru', sheet: {name: 'X'}},
      language: 'en',
    });
    expect((state as Record<string, unknown>)['language']).toBe('en');
    expect((state as Record<string, unknown>)['sheet']).toEqual({name: 'X'});
  });
});

async function firstId(sql: string, params?: unknown[]): Promise<number> {
  const rows = await queryRows<{id: number}>(sql, params);
  const id = rows[0]?.id;
  if (id == null) throw new Error(`no id returned for query: ${sql}`);
  return Number(id);
}
