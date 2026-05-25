import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import {
  clearConfigEnv,
  config,
  rawConfigEnv,
  setConfigEnv,
} from '../config.js';

interface Check {
  name: string;
  status: 'pass' | 'fail';
  details?: Record<string, unknown>;
}

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.existingDb) {
    clearConfigEnv('DATABASE_URL');
    const base =
      rawConfigEnv('GREENHAVEN_DEVTOOLS_TMP') ??
      (process.platform === 'win32' ? 'C:\\tmp' : '/tmp');
    await mkdir(base, { recursive: true });
    setConfigEnv(
      'PGLITE_DATA_DIR',
      await mkdtemp(path.join(base, 'greenhaven-robot-cartridge-')),
    );
  }

  const { runMigrations } = await import('../migrate.js');
  const { query, closeDb } = await import('../db.js');
  const { clearMetaCache } = await import('../cartridge.js');
  const { createAnonymousPlayer } = await import('../playerService.js');
  const { buildTurnContext } = await import('../turnContext/index.js');
  const { dispatch } = await import('../tools/index.js');

  const checks: Check[] = [];
  const expect = (
    name: string,
    condition: boolean,
    details?: Record<string, unknown>,
  ) => {
    checks.push({ name, status: condition ? 'pass' : 'fail', details });
  };
  const expectTool = async (
    name: string,
    call: Promise<{ ok: boolean; error?: string; data?: unknown }>,
  ) => {
    const result = await call;
    expect(name, result.ok, { result });
    return result;
  };

  await runMigrations();
  await query(
    `INSERT INTO cartridge_meta (key, value, description) VALUES
       ('cartridge_id', '"robot-empty-world"'::jsonb, 'Identifier of the active cartridge.'),
       ('cartridge_version', '"0.2.0"'::jsonb, 'Robot Empty World cartridge version.'),
       ('world_entity_id', '12000'::jsonb, 'Active robot cartridge world entity.'),
       ('starting_location_id', '12010'::jsonb, 'Robot cartridge starting location.'),
       ('starting_scene_id', '12011'::jsonb, 'Robot cartridge starting scene.'),
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
           updated_at = now()`,
  );
  clearMetaCache();

  const meta = await query<{ key: string; value: unknown }>(
    `SELECT key, value
       FROM cartridge_meta
      WHERE key IN ('cartridge_id', 'world_entity_id', 'starting_location_id', 'starting_scene_id')
      ORDER BY key`,
  );
  const metaMap = new Map(meta.rows.map((row) => [row.key, row.value]));
  expect(
    'active_cartridge_is_robot',
    metaMap.get('cartridge_id') === 'robot-empty-world',
    {
      cartridge_id: metaMap.get('cartridge_id'),
    },
  );
  expect(
    'robot_start_meta',
    metaMap.get('world_entity_id') === 12000 &&
      metaMap.get('starting_location_id') === 12010 &&
      metaMap.get('starting_scene_id') === 12011,
    {
      world_entity_id: metaMap.get('world_entity_id'),
      starting_location_id: metaMap.get('starting_location_id'),
      starting_scene_id: metaMap.get('starting_scene_id'),
    },
  );

  const player = await createAnonymousPlayer('Robot Smoke Player');
  expect(
    'new_player_starts_in_robot_scene',
    player.current_location_id === 12010 && player.current_scene_id === 12011,
    {
      current_location_id: player.current_location_id,
      current_scene_id: player.current_scene_id,
    },
  );

  const sessionId = `robot-cartridge-smoke-${Date.now()}`;
  await query(
    `INSERT INTO sessions (id, player_id, metadata)
     VALUES ($1, $2, $3::jsonb)`,
    [
      sessionId,
      player.entity_id,
      JSON.stringify({ source: 'robot-cartridge-smoke' }),
    ],
  );
  const ctx = {
    sessionId,
    playerId: player.entity_id,
    turnId: `${sessionId}:turn-1`,
  };

  const turnContext = await buildTurnContext(sessionId, player.entity_id, {
    lang: 'en',
    scope: 'full',
  });
  const contextText = `${turnContext.static}\n${turnContext.dynamic}`;
  expect(
    'context_contains_robot_entities',
    contextText.includes('Robot Empty World') &&
      contextText.includes('(id 12020)') &&
      contextText.includes('(id 12021)') &&
      contextText.includes('id 12040'),
    {
      static_chars: turnContext.static.length,
      dynamic_chars: turnContext.dynamic.length,
    },
  );
  expect(
    'context_excludes_old_greenhaven_entities',
    !contextText.includes('Mikka Quickgrin') &&
      !contextText.includes('Borek') &&
      !contextText.includes('Quickgrin Lane'),
  );

  const robotEntity = await dispatch(
    'query_entity',
    { id_or_name: '12020' },
    ctx,
  );
  expect(
    'query_entity_allows_robot_entity',
    robotEntity.ok &&
      Boolean((robotEntity.data as { found?: boolean } | undefined)?.found),
    {
      result: robotEntity,
    },
  );

  const oldEntity = await dispatch(
    'query_entity',
    { id_or_name: 'Mikka Quickgrin' },
    ctx,
  );
  expect(
    'query_entity_blocks_old_cartridge_entity',
    oldEntity.ok &&
      (oldEntity.data as { found?: boolean } | undefined)?.found === false,
    {
      result: oldEntity,
    },
  );

  const oldSearch = await dispatch(
    'search_entities',
    { query: 'Mikka', limit: 5 },
    ctx,
  );
  const oldSearchRows =
    (oldSearch.data as { entities?: unknown[] } | undefined)?.entities ?? [];
  expect(
    'search_blocks_old_cartridge_entity',
    oldSearch.ok && oldSearchRows.length === 0,
    {
      result: oldSearch,
    },
  );

  await expectTool(
    'start_robot_quest',
    dispatch('start_quest', { quest_id: 12040 }, ctx),
  );
  await expectTool(
    'issue_robot_task_state',
    dispatch(
      'apply_runtime_field_patch',
      {
        source: 'robot_smoke_issue',
        patches: [
          { field_id: 12140, value: 'issued' },
          { field_id: 12130, value: 'assigned' },
          { field_id: 12110, value: 'issued' },
          { field_id: 12150, value: 'assignment' },
          { field_id: 12103, value: 'protocol_alive' },
        ],
      },
      ctx,
    ),
  );
  await expectTool(
    'advance_robot_quest_to_executing',
    dispatch('advance_quest', { quest_id: 12040, to_stage: 'executing' }, ctx),
  );
  await expectTool(
    'klapaucius_issue_memory',
    dispatch(
      'add_memory',
      {
        owner: 12020,
        about: player.entity_id,
        text: 'Smoke: Klapaucius issued the prepared task to Trurl.',
        importance: 0.6,
        tags: ['robot_smoke', 'issued'],
      },
      ctx,
    ),
  );
  await expectTool(
    'execute_robot_task_state',
    dispatch(
      'apply_runtime_field_patch',
      {
        source: 'robot_smoke_execute',
        patches: [
          { field_id: 12130, value: 'done' },
          { field_id: 12140, value: 'executed' },
          { field_id: 12110, value: 'completed' },
          { field_id: 12150, value: 'verification' },
          { field_id: 12136, value: 'CHK-0001-TRURL' },
        ],
      },
      ctx,
    ),
  );
  await expectTool(
    'advance_robot_quest_to_reported',
    dispatch('advance_quest', { quest_id: 12040, to_stage: 'reported' }, ctx),
  );
  await expectTool(
    'trurl_execution_memory',
    dispatch(
      'add_memory',
      {
        owner: 12021,
        about: player.entity_id,
        text: 'Smoke: Trurl executed the prepared module and returned CHK-0001-TRURL.',
        importance: 0.65,
        tags: ['robot_smoke', 'executed'],
      },
      ctx,
    ),
  );
  await expectTool(
    'report_robot_task_state',
    dispatch(
      'apply_runtime_field_patch',
      {
        source: 'robot_smoke_report',
        patches: [
          { field_id: 12140, value: 'reported' },
          { field_id: 12150, value: 'closed' },
          { field_id: 12120, value: 'satisfied' },
          { field_id: 12103, value: 'verified' },
        ],
      },
      ctx,
    ),
  );
  await expectTool(
    'complete_robot_quest',
    dispatch('complete_quest', { quest_id: 12040 }, ctx),
  );

  const finalState = await query<{
    quest_status: string;
    current_stage_id: string | null;
    execution_status: unknown;
    task_status: unknown;
    protocol_phase: unknown;
    checksum: unknown;
  }>(
    `SELECT pq.status AS quest_status,
            pq.current_stage_id,
            qov.value AS execution_status,
            t.value AS task_status,
            ph.value AS protocol_phase,
            chk.value AS checksum
       FROM player_quests pq
       LEFT JOIN runtime_player_overlay qov
              ON qov.field_id = 12140 AND qov.player_id = pq.player_id
       LEFT JOIN runtime_values t ON t.field_id = 12130
       LEFT JOIN runtime_values ph ON ph.field_id = 12150
       LEFT JOIN runtime_values chk ON chk.field_id = 12136
      WHERE pq.player_id = $1
        AND pq.quest_entity_id = 12040`,
    [player.entity_id],
  );
  const baseRow = finalState.rows[0];
  const { countNpcMemoriesByOwnersAndTags } = await import(
    '../domain/memory/index.js'
  );
  const memories = await countNpcMemoriesByOwnersAndTags({
    ownerEntityIds: [12020, 12021],
    tags: ['robot_smoke'],
  });
  const row = baseRow ? { ...baseRow, memories } : undefined;
  expect(
    'robot_quest_reaches_reported_completed_state',
    row?.quest_status === 'completed' &&
      row.current_stage_id === 'reported' &&
      row.execution_status === 'reported' &&
      row.task_status === 'done' &&
      row.protocol_phase === 'closed' &&
      row.checksum === 'CHK-0001-TRURL' &&
      Number(row.memories) >= 2,
    { row },
  );

  await closeDb();
  const ok = checks.every((check) => check.status === 'pass');
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        data_dir: config().pgliteDataDir,
        checks,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  process.stdout.write(
    `${JSON.stringify(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

function parseArgs(argv: string[]): { existingDb: boolean } {
  const out = { existingDb: false };
  for (const arg of argv) {
    if (arg === '--existing-db') {
      out.existingDb = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return out;
}
