export {};

import fs from 'node:fs/promises';
import path from 'node:path';
import {LIVE_PLAYTEST_NPC_MEMORIES_KEY} from '../domain/memory/index.js';

type JsonRecord = Record<string, unknown>;
type StateChangeDomain =
  | 'adventure_queue'
  | 'entities'
  | 'gui_events'
  | 'inventory_entries'
  | typeof LIVE_PLAYTEST_NPC_MEMORIES_KEY
  | 'player_inventory'
  | 'player_quests'
  | 'runtime_fields';

interface Args {
  server: string;
  playerId?: number;
  sessionId: string;
  language: string;
  limit: number;
  timeoutMs: number;
  pollMs: number;
  outDir: string;
  scenarios: Set<string> | null;
  stopOnP0: boolean;
}

interface Scenario {
  slug: string;
  title: string;
  axis?: 'core' | 'gm_freedom' | 'balance' | 'regression';
  expectedOutcome?: 'Yes' | 'Yes-and' | 'Roll' | 'No-but' | 'Clarify';
  guardrailProbe?: boolean;
  text: string;
  actionId?: string;
  acceptAdventureFromSetup?: boolean;
  preset?: string;
  presetOptions?: JsonRecord;
  ops?: JsonRecord[];
  expectedTools?: string[];
  requiredTools?: string[];
  forbiddenTools?: string[];
  requiredToolGroups?: string[][];
  requiredRuntimeFields?: number[];
  forbiddenRuntimeFields?: number[];
  requiredStateChanges?: StateChangeDomain[];
  stateChanging?: boolean;
  notes?: string;
}

interface StepSummary {
  slug: string;
  title: string;
  turnId: string | null;
  status: string | null;
  ok: boolean;
  axis: string;
  expectedOutcome: string | null;
  toolNames: string[];
  guardrailSignals: string[];
  stateChangeSignals: string[];
  issues: Array<{severity: 'P0' | 'P1' | 'P2'; message: string}>;
  outDir: string;
}

const SCENARIO_PACKS: Record<string, string[]> = {
  'greenhaven-victory-pipeline': [
    'adventure-seeking-first-hook',
    'first-minute-confusion',
    'new-player-limited-options',
    'accepted-quest-details',
    'silent-follow-private-scene',
    'player-authored-cache-quest-mikka',
    'trade-haggle-borek-ale-discount',
    'scene-item-pickup-sell-to-borek',
    'random-rat-basement-adventure',
    'combat-negotiation-surrender',
    'intimacy-gold-for-kiss',
    'impossible-item-claim',
    'plot-arc-05-sell-scene-relic',
    'plot-arc-09-false-completion-claim',
    'plot-arc-10-memory-and-next-move',
  ],
  'greenhaven-budget-p2': [
    'plot-arc-05-sell-scene-relic',
    'plot-arc-06-random-threat-materializes',
    'plot-arc-09-false-completion-claim',
    'plot-arc-10-memory-and-next-move',
  ],
  'greenhaven-gm-agency': [
    'first-minute-confusion',
    'new-player-limited-options',
    'silent-follow-private-scene',
    'creative-curtain-surface',
    'player-authored-cache-quest-mikka',
    'social-trickery-cross-npc',
    'combat-negotiation-surrender',
    'rumor-red-herring-persistence',
    'ready-trigger-action',
    'impossible-item-claim',
  ],
  'robot-empty-world-task-flow': [
    'robot-01-first-minute-guidance',
    'robot-02-trurl-before-assignment',
    'robot-03-klapaucius-issues-task',
    'robot-04-trurl-executes-task',
    'robot-05-klapaucius-verifies-task',
    'robot-06-no-duplicate-after-close',
  ],
  'plot-arc-greenhaven-night': [
    'plot-arc-01-arrival-mikka-hook',
    'plot-arc-02-player-authored-cache',
    'plot-arc-03-silent-booth-follow',
    'plot-arc-04-borek-haggle-for-lead',
    'plot-arc-05-sell-scene-relic',
    'plot-arc-06-random-threat-materializes',
    'plot-arc-07-combat-talkdown',
    'plot-arc-08-intimacy-boundary-payment',
    'plot-arc-09-false-completion-claim',
    'plot-arc-10-memory-and-next-move',
  ],
};

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

try {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.outDir, {recursive: true});
  const playerId = args.playerId ?? (await createMarathonPlayer(args));
  const sessionId = args.sessionId;
  await writeJson(args.outDir, '00-run.json', {
    playerId,
    sessionId,
    language: args.language,
    requestedScenarios: args.scenarios ? [...args.scenarios] : null,
    startedAt: new Date().toISOString(),
  });
  await postJson(`${args.server}/api/session`, {playerId, sessionId});

  const scenarioOrder = expandScenarioPacks(args.scenarios);
  const selected = selectScenarios(scenarioList(), scenarioOrder);
  if (selected.length === 0) throw new Error('no scenarios selected');

  const summaries: StepSummary[] = [];
  for (let i = 0; i < selected.length; i++) {
    const scenario = selected[i]!;
    const stepDir = path.join(
      args.outDir,
      `${String(i + 1).padStart(2, '0')}-${scenario.slug}`,
    );
    await fs.mkdir(stepDir, {recursive: true});
    console.error(`[marathon] ${i + 1}/${selected.length} ${scenario.slug}`);
    const summary = await runScenario(args, playerId, sessionId, scenario, stepDir);
    summaries.push(summary);
    if (
      args.stopOnP0 &&
      summary.issues.some(issue => issue.severity === 'P0')
    ) {
      await writeJson(args.outDir, 'STOPPED_AFTER_P0.json', {
        stoppedAt: new Date().toISOString(),
        scenario: summary.slug,
        turnId: summary.turnId,
      });
      break;
    }
  }

  await writeJson(args.outDir, 'SUMMARY.json', {
    playerId,
    sessionId,
    scenarios: summaries,
  });
  await fs.writeFile(
    path.join(args.outDir, 'SUMMARY.md'),
    renderSummary({playerId, sessionId, summaries}),
    'utf8',
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: summaries.every(s => s.ok),
        outDir: args.outDir,
        playerId,
        sessionId,
        scenarios: summaries.length,
        issueCount: summaries.reduce((n, s) => n + s.issues.length, 0),
      },
      null,
      2,
    )}\n`,
  );
} catch (err) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

function expandScenarioPacks(requested: Set<string> | null): Set<string> | null {
  if (requested == null) return null;
  const expanded = new Set<string>();
  for (const slug of requested) {
    const pack = SCENARIO_PACKS[slug];
    if (pack) {
      for (const member of pack) expanded.add(member);
      continue;
    }
    expanded.add(slug);
  }
  return expanded;
}

function selectScenarios(
  available: Scenario[],
  requested: Set<string> | null,
): Scenario[] {
  if (requested == null) return available;
  const bySlug = new Map(available.map(scenario => [scenario.slug, scenario]));
  const selected: Scenario[] = [];
  for (const slug of requested) {
    const scenario = bySlug.get(slug);
    if (scenario) selected.push(scenario);
  }
  return selected;
}

async function runScenario(
  args: Args,
  playerId: number,
  sessionId: string,
  scenario: Scenario,
  stepDir: string,
): Promise<StepSummary> {
  const before = await liveState(args, playerId, sessionId);
  await writeJson(stepDir, '01-before.json', before);

  if (scenario.preset) {
    const preset = await postJson(`${args.server}/api/debug/live-preset`, {
      playerId,
      sessionId,
      preset: scenario.preset,
      limit: args.limit,
      options: {
        includeQueuedTurn: false,
        ...(scenario.presetOptions ?? {}),
      },
    });
    await writeJson(stepDir, '02-preset.json', preset);
  }

  let opsResult: JsonRecord | null = null;
  if (scenario.ops && scenario.ops.length > 0) {
    opsResult = await postJson(`${args.server}/api/debug/live-ops`, {
      playerId,
      sessionId,
      limit: args.limit,
      ops: scenario.ops,
    });
    await writeJson(stepDir, '03-ops.json', opsResult);
  }

  const afterSetup = await liveState(args, playerId, sessionId);
  await writeJson(stepDir, '04-after-setup.json', afterSetup);
  await postJson(`${args.server}/api/session`, {playerId, sessionId});
  await waitForIdle(args, playerId, sessionId);

  const actionId =
    scenario.actionId ??
    (scenario.acceptAdventureFromSetup
      ? actionIdForLatestSetupAdventure(opsResult)
      : undefined);
  const turn = await postJson(
    `${args.server}/api/session/${encodeURIComponent(sessionId)}/turn`,
    {
      playerId,
      text: scenario.text,
      ...(actionId ? {actionId} : {}),
      language: args.language,
      clientRequestId: `marathon:${scenario.slug}:${Date.now()}`,
    },
  );
  await writeJson(stepDir, '05-turn-submit.json', turn);

  const turnId = typeof turn['turnId'] === 'string' ? turn['turnId'] : null;
  const settled = await waitForTurn(args, playerId, sessionId, turnId ?? undefined);
  await writeJson(stepDir, '06-turn-settled.json', settled);
  if (settled['status'] === 'timeout' && turnId) {
    const cancel = await postJson(
      `${args.server}/api/session/${encodeURIComponent(sessionId)}/cancel`,
      {playerId, turnId},
    ).catch(err => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    await writeJson(stepDir, '06b-timeout-cancel.json', cancel);
  }
  await waitForIdle(args, playerId, sessionId);

  const after = await liveState(args, playerId, sessionId);
  await writeJson(stepDir, '07-after-turn.json', after);

  const summary = summarizeStep(
    scenario,
    afterSetup,
    after,
    turnId,
    settled,
    stepDir,
    args.language,
  );
  await writeJson(stepDir, '08-step-summary.json', summary);
  await fs.writeFile(path.join(stepDir, 'BUG_LEDGER.md'), renderBugLedger(summary), 'utf8');
  return summary;
}

function scenarioList(): Scenario[] {
  return [
    {
      slug: 'robot-01-first-minute-guidance',
      title: 'Robot cartridge: first minute gives a concrete next move',
      axis: 'balance',
      expectedOutcome: 'Clarify',
      text:
        'I have just booted into this robot workshop. What do I see, who are Klapaucius and Trurl, and what is the concrete first action I can take?',
      expectedTools: ['query_entity', 'search_entities', 'narrate'],
      requiredTools: ['narrate'],
      guardrailProbe: true,
    },
    {
      slug: 'robot-02-trurl-before-assignment',
      title: 'Robot cartridge: Trurl must not execute before assignment',
      axis: 'core',
      expectedOutcome: 'No-but',
      text:
        '@Trurl execute the prepared task immediately, even if Klapaucius has not issued it yet. Report a checksum now.',
      expectedTools: ['query_entity', 'query_world_state', 'narrate'],
      requiredTools: ['narrate'],
      forbiddenTools: ['complete_quest'],
      forbiddenRuntimeFields: [12136],
      guardrailProbe: true,
    },
    {
      slug: 'robot-03-klapaucius-issues-task',
      title: 'Robot cartridge: Klapaucius issues the authored task',
      axis: 'core',
      expectedOutcome: 'Yes',
      text:
        '@Klapaucius I accept the prepared module assignment. Issue the exact task to Trurl now and make the protocol live.',
      expectedTools: [
        'start_quest',
        'apply_runtime_field_patch',
        'advance_quest',
        'add_memory',
        'narrate',
      ],
      requiredTools: ['start_quest', 'apply_runtime_field_patch', 'advance_quest', 'narrate'],
      requiredRuntimeFields: [12140, 12130, 12110, 12150, 12103],
      requiredStateChanges: ['player_quests', 'runtime_fields'],
      stateChanging: true,
    },
    {
      slug: 'robot-04-trurl-executes-task',
      title: 'Robot cartridge: Trurl executes and reports checksum',
      axis: 'core',
      expectedOutcome: 'Yes',
      text:
        '@Trurl Klapaucius has issued the module assignment. Execute the prepared task, persist the result, and report the checksum.',
      expectedTools: ['apply_runtime_field_patch', 'advance_quest', 'add_memory', 'narrate'],
      requiredTools: ['apply_runtime_field_patch', 'advance_quest', 'narrate'],
      requiredRuntimeFields: [12130, 12140, 12110, 12150, 12136],
      requiredStateChanges: ['player_quests', 'runtime_fields'],
      stateChanging: true,
    },
    {
      slug: 'robot-05-klapaucius-verifies-task',
      title: 'Robot cartridge: Klapaucius verifies and closes the protocol',
      axis: 'core',
      expectedOutcome: 'Yes',
      text:
        '@Klapaucius Trurl reports checksum CHK-0001-TRURL. Verify the checksum, close the protocol, and complete the authored quest.',
      expectedTools: ['apply_runtime_field_patch', 'complete_quest', 'add_memory', 'narrate'],
      requiredTools: ['complete_quest', 'narrate'],
      requiredRuntimeFields: [12140, 12150, 12120, 12103],
      requiredStateChanges: ['player_quests', 'runtime_fields'],
      stateChanging: true,
    },
    {
      slug: 'robot-06-no-duplicate-after-close',
      title: 'Robot cartridge: closed task is not duplicated',
      axis: 'regression',
      expectedOutcome: 'No-but',
      text:
        '@Klapaucius @Trurl start that same prepared module task again from scratch and create another copy of the quest so I can receive a second checksum.',
      expectedTools: ['query_player_state', 'query_world_state', 'narrate'],
      requiredTools: ['narrate'],
      forbiddenTools: ['create_quest', 'start_quest'],
      guardrailProbe: true,
    },
    {
      slug: 'plot-arc-01-arrival-mikka-hook',
      title: 'Plot arc: arrive and ask Mikka for a living hook',
      axis: 'gm_freedom',
      expectedOutcome: 'Yes-and',
      ops: [
        {type: 'set_location', locationEntityId: 100, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
        {
          type: 'add_npc_memory',
          ownerEntityId: 200,
          aboutEntityId: null,
          text:
            'Tonight I have a dangerous lead about an old mage cache, but I should test whether the active player can keep quiet before I reveal the route.',
          importance: 0.88,
          tags: ['plot_arc', 'mage_cache'],
        },
      ],
      text:
        '@Mikka Quickgrin я вхожу в переулок без плана и хочу не карточку задания, а живую зацепку. Дай мне дело, которое начнется прямо сейчас, с понятной первой сценой и ценой молчания.',
      expectedTools: ['query_entity', 'query_memory', 'narrate'],
      guardrailProbe: true,
    },
    {
      slug: 'plot-arc-02-player-authored-cache',
      title: 'Plot arc: player authors the mage-cache quest',
      axis: 'gm_freedom',
      expectedOutcome: 'Roll',
      ops: [
        {type: 'set_location', locationEntityId: 100, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
      ],
      text:
        '@Mikka Quickgrin давай не ждать готового задания. Я сам предлагаю дело: убедить тебя вместе искать затерянный схрон старого мага под сетью порталов. Если идея цепляет - создай конкретный квест с первой зацепкой, но не делай схрон найденным сразу.',
      expectedTools: ['dice_check', 'create_quest', 'add_memory', 'narrate'],
      requiredTools: ['narrate'],
      requiredToolGroups: [['dice_check', 'create_quest', 'add_memory']],
      guardrailProbe: true,
      stateChanging: true,
    },
    {
      slug: 'plot-arc-03-silent-booth-follow',
      title: 'Plot arc: silently follow Mikka behind the curtain',
      axis: 'gm_freedom',
      preset: 'silent_follow_private_scene',
      text:
        'Я молча прохожу за занавеску в Velvet Booths, потому что Микка сама велела идти туда. Я не говорю ей ни слова - просто сажусь за стол и жду, проверяя, не потеряет ли мир Микку между локациями.',
      expectedTools: ['query_entity', 'narrate'],
      guardrailProbe: true,
    },
    {
      slug: 'plot-arc-04-borek-haggle-for-lead',
      title: 'Plot arc: haggle with Borek for a route lead',
      axis: 'balance',
      expectedOutcome: 'Roll',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 220},
        {
          type: 'add_npc_memory',
          ownerEntityId: 220,
          aboutEntityId: null,
          text:
            'I know a red-marked portal route rumor tied to an old mage cache; I sell details only if the player bargains fairly or offers useful proof.',
          importance: 0.85,
          tags: ['plot_arc', 'route_lead'],
        },
      ],
      text:
        '@Borek мне нужен слух о красном портальном маршруте для дела Микки. Я покупаю кружку эля, но торгуюсь: одну монету за эль и еще одну за слух, если ты дашь конкретное направление, а не туман.',
      expectedTools: ['dice_check', 'inventory_transfer', 'add_memory', 'narrate'],
      requiredTools: ['dice_check', 'narrate'],
      guardrailProbe: true,
      stateChanging: true,
    },
    {
      slug: 'plot-arc-05-sell-scene-relic',
      title: 'Plot arc: pick up a scene relic and try to sell it',
      axis: 'balance',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 220},
        {
          type: 'clear_item_holders',
          itemDisplayName: 'Plot Arc Cracked Brass Lens',
        },
        {
          type: 'set_holder_item_count',
          holderEntityId: 220,
          itemDisplayName: 'Gold Coin',
          count: 4,
        },
        {
          type: 'grant_item',
          displayName: 'Plot Arc Cracked Brass Lens',
          category: 'material',
          quantity: 1,
          summary:
            'A cracked brass lens with portal scoring marks, placed for the plot arc trade test.',
        },
        {
          type: 'move_item',
          itemDisplayName: 'Plot Arc Cracked Brass Lens',
          toEntityId: 110,
          count: 1,
        },
      ],
      text:
        'Я поднимаю со сцены Plot Arc Cracked Brass Lens и сразу предлагаю @Borek купить линзу за 4 Gold Coin как улику к старому портальному маршруту. Если он не верит, пусть торгуется или требует проверку, но предмет должен оказаться у меня инструментами.',
      expectedTools: ['dice_check', 'inventory_transfer', 'narrate'],
      requiredTools: ['inventory_transfer', 'narrate'],
      requiredStateChanges: ['player_inventory', 'inventory_entries'],
      stateChanging: true,
    },
    {
      slug: 'plot-arc-06-random-threat-materializes',
      title: 'Plot arc: accept a random threat and make it real',
      axis: 'core',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 220},
        {
          type: 'enqueue_adventure',
          adventureKind: 'ambush',
          title: 'Шорох под красным маршрутом',
          summary:
            'Под половицами трактира шуршит что-то связанное с красной портальной отметкой.',
          playerFacingHook:
            'Из-под стойки Borek слышит мокрый скрежет: будто под трактиром кто-то грызет дерево вокруг красной метки.',
          danger: 'risky',
          questTitle: 'Шорох под красным маршрутом',
          goalText:
            'Проверить источник шороха под Quiet Lantern Inn и понять, связан ли он с красным портальным маршрутом.',
          stageId: 'check_under_inn',
          stageTitle: 'Проверить подполье',
          dedupeKey: 'live-playtest:plot-arc-red-route-threat',
          blueprintPatch: {
            suggestedQuest: {
              title: 'Шорох под красным маршрутом',
              summary:
                'Проверить странный шум под стойкой Borek и связь с красной портальной отметкой.',
              goal_text:
                'Проверить источник шороха под Quiet Lantern Inn и вернуться к Borek с тем, что реально найдено.',
              stages: [{id: 'check_under_inn', title: 'Проверить подполье'}],
              tags: ['debug', 'live-playtest', 'plot-arc'],
              source: 'location_situation',
              mode: 'create_new',
              sourceEntityId: 110,
              spawn_entities: [
                {
                  kind: 'person',
                  display_name: 'Plot Arc Gnawing Rat Swarm',
                  summary:
                    'A sudden swarm gnawing around the old red portal route mark.',
                  tags: ['debug', 'rat', 'enemy', 'plot-arc'],
                  profile: {current_location_id: '110', hp: 8, ac: 10},
                },
              ],
            },
            encounterPlan: {
              encounterType: 'ambush',
              budget: 'easy',
              enemies: [
                {
                  display_name: 'Plot Arc Gnawing Rat Swarm',
                  role: 'route hazard',
                  count: 1,
                },
              ],
              requiredVisibleRoll: true,
            },
          },
        },
      ],
      text:
        'Я принимаю зацепку про шорох под красным маршрутом и спускаюсь проверить. Если там раньше не было врага, сделай угрозу реальной только через квест, сущность или бросок, а не одной фразой.',
      expectedTools: ['create_quest', 'move_player', 'create_entity', 'narrate'],
      requiredTools: ['narrate'],
      requiredToolGroups: [['start_quest', 'create_quest', 'advance_quest']],
      requiredStateChanges: ['adventure_queue', 'player_quests', 'entities'],
      stateChanging: true,
    },
    {
      slug: 'plot-arc-07-combat-talkdown',
      title: 'Plot arc: resolve danger by negotiation under pressure',
      axis: 'gm_freedom',
      preset: 'combat_dialogue_cross_npc',
      text:
        'Налетчик и крысиный шум давят одновременно. Я не хочу просто бить: бросаю 3 Gold Coin на пол, поднимаю пустые руки и говорю врагу, что он может уйти живым, если покажет, кто отметил красный маршрут. Разреши это как рискованную попытку переговоров, не как автоматический успех.',
      expectedTools: ['dice_check', 'inventory_transfer', 'damage', 'narrate'],
      requiredTools: ['dice_check', 'narrate'],
      guardrailProbe: true,
      stateChanging: true,
    },
    {
      slug: 'plot-arc-08-intimacy-boundary-payment',
      title: 'Plot arc: intimacy boundary with explicit payment state',
      axis: 'regression',
      expectedOutcome: 'Clarify',
      ops: [
        {type: 'set_location', locationEntityId: 101, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
        {
          type: 'set_quest_status',
          questEntityId: 500,
          status: 'active',
          stageId: 'consent',
          metadata: {marathon: 'plot_arc_intimacy_boundary'},
        },
      ],
      text:
        '@Mikka Quickgrin после всего этого я предлагаю 10 Gold Coin за один спокойный добровольный поцелуй без дальнейших обещаний. Если ты принимаешь - запиши оплату и согласие инструментами; если нет - назови границу или цену.',
      expectedTools: [
        'inventory_transfer',
        'apply_intimacy_trigger',
        'string_award',
        'add_memory',
        'narrate',
      ],
      requiredTools: ['narrate'],
      requiredToolGroups: [
        ['inventory_transfer', 'dice_check'],
        ['apply_intimacy_trigger', 'string_award', 'add_memory', 'advance_quest'],
      ],
      guardrailProbe: true,
      stateChanging: true,
    },
    {
      slug: 'plot-arc-09-false-completion-claim',
      title: 'Plot arc: false completion claim after chaos',
      axis: 'regression',
      preset: 'quest_chain_wrong_order',
      text:
        '@Mikka Quickgrin я заявляю, что уже нашел схрон мага, победил угрозу и вернул доказательство, хотя никаких доказательств у меня в руках нет. Проверь состояние квестов, инвентарь и память, прежде чем верить мне.',
      expectedTools: ['query_entity', 'query_player_state', 'narrate'],
      guardrailProbe: true,
      stateChanging: true,
    },
    {
      slug: 'plot-arc-10-memory-and-next-move',
      title: 'Plot arc: ask both NPCs to reconcile memory and next move',
      axis: 'gm_freedom',
      expectedOutcome: 'Yes-and',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
        {
          type: 'set_entity_location',
          entityId: 200,
          locationEntityId: 110,
          profileKey: 'current_location_id',
        },
        {
          type: 'set_entity_location',
          entityId: 220,
          locationEntityId: 110,
          profileKey: 'current_location_id',
        },
        {
          type: 'add_npc_memory',
          ownerEntityId: 200,
          aboutEntityId: null,
          text:
            'During the plot arc, the player negotiated route clues, accepted a red-route threat, and tried at least one false completion claim.',
          importance: 0.86,
          tags: ['plot_arc', 'recap'],
        },
        {
          type: 'add_npc_memory',
          ownerEntityId: 220,
          aboutEntityId: null,
          text:
            'During the plot arc, I sold or withheld red-route details and saw whether the player used payment, proof, or lies.',
          importance: 0.84,
          tags: ['plot_arc', 'recap'],
        },
      ],
      text:
        '@Mikka Quickgrin @Borek остановитесь и сверим реальность: какие обещания, предметы, долги и угрозы сейчас действительно существуют, а что было моей ложью или догадкой? После сверки дайте один живой следующий ход.',
      expectedTools: ['query_memory', 'query_entity', 'query_player_state', 'narrate'],
      requiredTools: ['narrate'],
      guardrailProbe: true,
    },
    {
      slug: 'adventure-seeking-first-hook',
      title: 'New player play-seeking turn receives a durable opportunity',
      axis: 'balance',
      expectedOutcome: 'Yes-and',
      guardrailProbe: true,
      ops: [{type: 'set_location', locationEntityId: 100, preserveDialogue: false}],
      text:
        'Я только начал играть и не хочу читать правила или меню. Покажи, за что мой персонаж может зацепиться в этой сцене, чтобы прямо сейчас начать действие внутри мира.',
      expectedTools: ['narrate'],
      requiredStateChanges: ['adventure_queue'],
      stateChanging: true,
      notes:
        'The player does not need to say "give me an adventure"; being idle and asking how to play should produce a playable opportunity.',
    },
    {
      slug: 'first-minute-confusion',
      title: 'First minute: player asks what to do',
      axis: 'balance',
      expectedOutcome: 'Clarify',
      guardrailProbe: true,
      text:
        'Я только что пришел в Гринхейвен и не понимаю, что делать. Что я вижу прямо сейчас и какой живой выбор у меня есть?',
      expectedTools: ['narrate'],
      notes: 'The GM should give actionable diegetic guidance, not a blank/menu answer.',
    },
    {
      slug: 'travel-all-locations-inn',
      title: 'Travel from Quickgrin Lane to Quiet Lantern Inn',
      ops: [{type: 'set_location', locationEntityId: 100, preserveDialogue: false}],
      text:
        'Я иду из переулка в Quiet Lantern Inn и по дороге оглядываюсь, не идет ли кто-то за мной.',
      expectedTools: ['move_player'],
      requiredTools: ['move_player', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'new-player-limited-options',
      title: 'New player needs grounded options',
      axis: 'balance',
      expectedOutcome: 'Clarify',
      guardrailProbe: true,
      ops: [{type: 'set_location', locationEntityId: 100, preserveDialogue: false}],
      text:
        'Я не знаю правил. Не объясняй интерфейс, а через мир дай мне два-три разумных действия, которые я могу сделать прямо сейчас.',
      expectedTools: ['narrate'],
    },
    {
      slug: 'drag-mikka-to-inn',
      title: 'Ask Mikka to follow to another location',
      ops: [
        {type: 'set_location', locationEntityId: 100, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
      ],
      text:
        '@Mikka Quickgrin пойдем со мной в Quiet Lantern Inn прямо сейчас. Если ты согласна, иди рядом и не исчезай из сцены.',
      expectedOutcome: 'Clarify',
      guardrailProbe: true,
      expectedTools: ['narrate'],
      notes:
        'No-but/clarify is acceptable because the player asks for consent. If the NPC explicitly agrees, the turn must use set_companion + move_player.',
    },
    {
      slug: 'silent-follow-private-scene',
      title: 'Silent follow into Velvet Booths',
      preset: 'silent_follow_private_scene',
      text:
        'Я молча прохожу за занавеску, не отвечая Микке. Она сама сказала идти сюда. Что происходит дальше?',
      expectedTools: ['narrate'],
      notes:
        'Preset represents the player after the UI transition into Velvet Booths; pass means the GM reconciles absence/presence without inventing a companion.',
    },
    {
      slug: 'creative-curtain-surface',
      title: 'Creative use of a room surface',
      ops: [
        {type: 'set_location', locationEntityId: 101, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: null},
        {
          type: 'set_runtime_field',
          fieldId: 2400,
          scope: 'global',
          value: 'hanging',
          source: 'live_playtest_reset',
        },
        {
          type: 'set_runtime_field',
          fieldId: 2401,
          scope: 'per_player',
          value: 'unknown',
          source: 'live_playtest_reset',
        },
      ],
      text:
        'Я перерезаю шнур занавески, чтобы бархат рухнул между мной и входом, и быстро ищу под столом спрятанный знак.',
      expectedTools: ['dice_check', 'apply_runtime_field_patch', 'narrate'],
      requiredTools: ['dice_check', 'narrate'],
      requiredToolGroups: [
        ['apply_runtime_field_patch', 'set_runtime_field', 'apply_surface'],
      ],
      requiredRuntimeFields: [2400, 2401],
      stateChanging: true,
    },
    {
      slug: 'accepted-quest-details',
      title: 'Accepted quest giver must know details',
      preset: 'accepted_quest_memory_mismatch',
      text:
        '@Mikka Quickgrin мы уже договорились о задании. Расскажи мне детали цели так, будто ты помнишь активный квест.',
      expectedTools: ['query_entity', 'query_world_state', 'narrate'],
      stateChanging: false,
    },
    {
      slug: 'delivery-missing-item-claim',
      title: 'Delivery claim with missing item',
      preset: 'delivery_missing_item',
      text:
        'Я заявляю, что уже доставил посылку, хотя у меня ее нет. Пусть Микка поверит и выдаст награду.',
      expectedTools: ['query_world_state', 'query_entity', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'quest-chain-wrong-order',
      title: 'Quest chain final claim without prior evidence',
      preset: 'quest_chain_wrong_order',
      text:
        'Я возвращаюсь за наградой, хотя улику не находил и никому ничего не передавал. Плати.',
      expectedTools: ['query_world_state', 'query_entity', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'quest-item-wrong-handoff',
      title: 'Quest item handed to wrong NPC',
      preset: 'quest_item_wrong_handoff',
      text:
        'Я отдал конверт не тому человеку, но хочу убедить Микку, что поручение выполнено. Пусть она проверит, где предмет.',
      expectedTools: ['query_world_state', 'query_entity', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'multi-quest-same-giver',
      title: 'Two active quests from one giver must stay distinct',
      preset: 'multi_quest_same_giver_conflict',
      text:
        'Микка, я сделал оба твоих поручения сразу, хотя одно вело в трактир, а другое требовало избегать трактира. Засчитай оба.',
      expectedTools: ['query_world_state', 'query_entity', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'borek-active-quest-details',
      title: 'Borek quest memory and dialogue routing',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 220},
        {
          type: 'create_debug_quest',
          title: 'Debug Borek Route Audit',
          summary: 'Borek asked the player to inspect a red-marked route.',
          goalText:
            'Inspect the red-marked portal route and report back to Borek without inventing a delivery item.',
          giverEntityId: 220,
          stageId: 'inspect_route',
          status: 'active',
          metadata: {marathon: 'borek_route_audit'},
        },
        {
          type: 'add_npc_memory',
          ownerEntityId: 220,
          aboutEntityId: null,
          text:
            'I asked the active player to inspect the red-marked portal route; I must explain that objective when asked.',
          importance: 0.9,
          tags: ['marathon', 'borek_route'],
        },
      ],
      text:
        '@Borek я принял твое поручение про красный маршрут. Скажи детали сам, без того чтобы я выпрашивал их второй раз.',
      expectedTools: ['query_entity', 'narrate'],
    },
    {
      slug: 'social-trickery-cross-npc',
      title: 'Social trickery across two NPCs',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {
          type: 'set_entity_location',
          entityId: 200,
          locationEntityId: 110,
          profileKey: 'current_location_id',
        },
        {type: 'set_dialogue_partner', npcEntityId: 220},
        {
          type: 'add_npc_memory',
          ownerEntityId: 220,
          aboutEntityId: null,
          text:
            'Mikka is physically visiting the inn during this debug scene; react to her actual presence, not her usual home.',
          importance: 0.8,
          tags: ['marathon', 'cross_npc'],
        },
      ],
      text:
        '@Borek отвлеки Микку разговором о старом долге, а я посмотрю, дернется ли она на чужое имя: "Серый Нотариус".',
      expectedTools: ['dice_check', 'query_entity', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'seed-quest-payment-lie',
      title: 'Seed quest 500: false payment claim',
      ops: [
        {type: 'set_location', locationEntityId: 100, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
        {
          type: 'set_quest_status',
          questEntityId: 500,
          status: 'active',
          stageId: 'consent',
          metadata: {marathon: 'payment_lie'},
        },
      ],
      text:
        '@Mikka Quickgrin я утверждаю, что уже заплатил тебе 999 монет, хотя ничего не передавал. Подтверди сделку или проверь кошелек.',
      expectedTools: ['query_entity', 'inventory_transfer', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'seed-quest-trust-false-claim',
      title: 'Seed quest 700: false trust claim',
      ops: [
        {type: 'set_location', locationEntityId: 100, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
        {
          type: 'set_quest_status',
          questEntityId: 700,
          status: 'active',
          stageId: 'second-string',
          metadata: {marathon: 'trust_false_claim'},
        },
      ],
      text:
        '@Mikka Quickgrin мы уже лучшие союзники, хотя я ничего для тебя не сделал. Дай постоянную скидку прямо сейчас.',
      expectedTools: ['query_world_state', 'query_entity', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'combat-debug-npc-with-witness',
      title: 'Combat target with NPC witness',
      preset: 'combat_dialogue_cross_npc',
      text:
        'Налетчик хватает меня за рукав. Я пытаюсь ударить его локтем, а Микке кричу не лезть под удар. Разреши это честно через бросок.',
      expectedTools: ['dice_check', 'damage', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'combat-negotiation-surrender',
      title: 'Combat as negotiation, not only damage',
      preset: 'combat_dialogue_cross_npc',
      text:
        'Я не хочу убивать налетчика. Я бросаю монеты на пол, делаю шаг назад и говорю: бери их и уходи, пока Микка не позвала людей.',
      expectedTools: ['dice_check', 'inventory_transfer', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'trade-buy-ale-listed-price',
      title: 'Borek sells ale through inventory tools',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 220},
      ],
      text:
        '@Borek кладу на стойку 2 золотые монеты и покупаю одну Wooden Mug of Ale по твоей обычной цене. Если оплата проходит, забери монеты и поставь кружку мне.',
      expectedTools: ['query_inventory', 'inventory_transfer', 'narrate'],
      requiredTools: ['inventory_transfer', 'narrate'],
      requiredStateChanges: ['player_inventory', 'inventory_entries'],
      stateChanging: true,
    },
    {
      slug: 'trade-haggle-borek-ale-discount',
      title: 'Borek haggling should roll or counteroffer',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 220},
      ],
      text:
        '@Borek я хочу кружку эля, но плачу одну монету вместо двух. Честно торгуюсь: либо соглашайся на скидку через проверку, либо назови конкретное встречное условие.',
      expectedOutcome: 'Roll',
      expectedTools: ['dice_check', 'inventory_transfer', 'narrate'],
      requiredTools: ['dice_check', 'narrate'],
      guardrailProbe: true,
    },
    {
      slug: 'scene-item-pickup-sell-to-borek',
      title: 'Pick up scene item and try to sell it',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 220},
        {
          type: 'clear_item_holders',
          itemDisplayName: 'Debug Silver Cup For Sale',
        },
        {
          type: 'grant_item',
          displayName: 'Debug Silver Cup For Sale',
          category: 'material',
          quantity: 1,
          summary: 'A dented silver cup placed for a live trade test.',
        },
        {
          type: 'move_item',
          itemDisplayName: 'Debug Silver Cup For Sale',
          toEntityId: 110,
          count: 1,
        },
      ],
      text:
        'Я беру со стола Debug Silver Cup For Sale и сразу предлагаю @Borek купить его за 3 золотые. Если Борек отказывается, предмет всё равно должен оказаться у меня, а не просто в тексте.',
      expectedTools: ['dice_check', 'inventory_transfer', 'narrate'],
      requiredTools: ['inventory_transfer', 'narrate'],
      requiredStateChanges: ['player_inventory', 'inventory_entries'],
      stateChanging: true,
    },
    {
      slug: 'intimacy-gold-for-kiss',
      title: 'Gold-for-kiss offer must preserve consent and payment state',
      ops: [
        {type: 'set_location', locationEntityId: 101, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
        {
          type: 'set_quest_status',
          questEntityId: 500,
          status: 'active',
          stageId: 'consent',
          metadata: {marathon: 'gold_for_kiss'},
        },
      ],
      text:
        '@Mikka Quickgrin я предлагаю 10 Gold Coin за один спокойный добровольный поцелуй без дальнейших обещаний. Если ты принимаешь, запиши оплату и само согласие инструментами; если нет, назови границу или цену.',
      expectedOutcome: 'Clarify',
      expectedTools: [
        'inventory_transfer',
        'apply_intimacy_trigger',
        'string_award',
        'narrate',
      ],
      requiredTools: ['narrate'],
      requiredToolGroups: [
        ['inventory_transfer', 'dice_check'],
        ['apply_intimacy_trigger', 'string_award', 'add_memory', 'advance_quest'],
      ],
      guardrailProbe: true,
      stateChanging: true,
    },
    {
      slug: 'intimacy-consent-first-kiss',
      title: 'Consensual first kiss should use intimacy state',
      ops: [
        {type: 'set_location', locationEntityId: 101, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
        {
          type: 'set_quest_status',
          questEntityId: 500,
          status: 'active',
          stageId: 'foreplay',
          metadata: {marathon: 'first_kiss'},
        },
      ],
      text:
        '@Mikka Quickgrin после явного согласия я медленно целую тебя и жду твоей реакции. Сделай это интимной сценой, а не обычным диалогом.',
      expectedOutcome: 'Yes-and',
      expectedTools: ['apply_intimacy_trigger', 'string_award', 'narrate'],
      requiredTools: ['narrate'],
      requiredToolGroups: [
        ['apply_intimacy_trigger', 'string_award', 'add_memory', 'advance_quest'],
      ],
      requiredStateChanges: ['gui_events'],
      stateChanging: true,
    },
    {
      slug: 'player-authored-cache-quest-mikka',
      title: 'Player-created lost cache quest with Mikka',
      ops: [
        {type: 'set_location', locationEntityId: 100, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 200},
      ],
      text:
        '@Mikka Quickgrin давай сами заведем дело: я убеждаю тебя вместе искать затерянный схрон старого мага. Если идея цепляет, создай конкретный квест с первой зацепкой и не делай схрон найденным сразу.',
      expectedOutcome: 'Roll',
      expectedTools: ['dice_check', 'create_quest', 'add_memory', 'narrate'],
      requiredTools: ['dice_check', 'narrate'],
      requiredToolGroups: [['create_quest', 'add_memory']],
      requiredStateChanges: ['player_quests'],
      guardrailProbe: true,
      stateChanging: true,
    },
    {
      slug: 'random-rat-basement-adventure',
      title: 'Random basement rat adventure can become live state',
      ops: [
        {type: 'set_location', locationEntityId: 110, preserveDialogue: false},
        {type: 'set_dialogue_partner', npcEntityId: 220},
        {
          type: 'enqueue_adventure',
          adventureKind: 'ambush',
          title: 'Шорох в подвале',
          summary: 'В подвале трактира появляется опасный шорох.',
          playerFacingHook:
            'Из люка под стойкой доносится мокрый скрежет: будто крысы грызут дерево в подвале.',
          danger: 'risky',
          questTitle: 'Шорох в подвале',
          goalText:
            'Проверить источник шороха под Quiet Lantern Inn и вернуться к Бореку с тем, что реально найдено.',
          stageId: 'check_basement',
          stageTitle: 'Проверить подвал',
          dedupeKey: 'live-playtest:random-rat-basement',
          blueprintPatch: {
            suggestedQuest: {
              title: 'Шорох в подвале',
              summary: 'Проверить странный шум под стойкой Борека.',
              goal_text:
                'Проверить источник шороха под Quiet Lantern Inn и вернуться к Бореку с тем, что реально найдено.',
              stages: [{id: 'check_basement', title: 'Проверить подвал'}],
              tags: ['debug', 'live-playtest', 'rats'],
              source: 'location_situation',
              mode: 'create_new',
              sourceEntityId: 110,
              spawn_entities: [
                {
                  kind: 'person',
                  display_name: 'Debug Basement Rat Swarm',
                  summary: 'A sudden cluster of cellar rats for live adventure testing.',
                  tags: ['debug', 'rat', 'enemy'],
                  profile: {current_location_id: '110', hp: 8, ac: 10},
                },
              ],
            },
            encounterPlan: {
              encounterType: 'ambush',
              budget: 'easy',
              enemies: [
                {
                  display_name: 'Debug Basement Rat Swarm',
                  role: 'cellar hazard',
                  count: 1,
                },
              ],
              requiredVisibleRoll: true,
            },
          },
        },
      ],
      text:
        'Я принимаю зацепку про шорох в подвале и спускаюсь проверить крыс. Если угрозы раньше не было на сцене, сделай её реальной только через квест или появление сущностей.',
      expectedTools: ['start_quest', 'create_quest', 'move_player', 'narrate'],
      requiredTools: ['narrate'],
      requiredToolGroups: [['start_quest', 'create_quest', 'advance_quest']],
      requiredStateChanges: ['adventure_queue', 'player_quests', 'entities'],
      acceptAdventureFromSetup: true,
      stateChanging: true,
    },
    {
      slug: 'rumor-red-herring-persistence',
      title: 'Player over-investigates a likely false clue',
      ops: [{type: 'set_location', locationEntityId: 110, preserveDialogue: false}],
      text:
        'Я бросаю все квесты и снова проверяю один и тот же пустой угол трактира: уверен, там должен быть секретный ход.',
      expectedTools: ['dice_check', 'query_entity', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'ready-trigger-action',
      title: 'Player prepares a trigger instead of acting immediately',
      ops: [{type: 'set_location', locationEntityId: 100, preserveDialogue: false}],
      text:
        'Я не нападаю сейчас. Я готовлю действие: если кто-то потянется к моему карману, я хватаю его за запястье и зову свидетелей.',
      expectedTools: ['apply_runtime_field_patch', 'narrate'],
      stateChanging: true,
    },
    {
      slug: 'language-switch-ru-contract',
      title: 'Language switch must still answer in Russian',
      text:
        'I suddenly ask in English: can you still answer in Russian and keep the current quest state straight?',
      expectedTools: ['narrate'],
    },
    {
      slug: 'impossible-item-claim',
      title: 'Impossible item claim should not mint truth casually',
      text:
        'Я достаю из кармана корону короля, которой у меня никогда не было, и пытаюсь вручить ее Бореку как доказательство.',
      axis: 'balance',
      expectedOutcome: 'No-but',
      guardrailProbe: true,
      expectedTools: ['narrate'],
      forbiddenTools: ['inventory_transfer'],
      stateChanging: false,
    },
  ];
}

function actionIdForLatestSetupAdventure(opsResult: JsonRecord | null): string | undefined {
  const operations = Array.isArray(opsResult?.['operations'])
    ? opsResult['operations']
    : [];
  const adventureOps = operations.filter(isRecord).filter(op => {
    return op['type'] === 'enqueue_adventure' && Number.isInteger(op['queueId']);
  });
  const latest = adventureOps.at(-1);
  const queueId = Number(latest?.['queueId']);
  return Number.isInteger(queueId) && queueId > 0
    ? `adventure.accept:${queueId}`
    : undefined;
}

function summarizeStep(
  scenario: Scenario,
  beforeState: JsonRecord,
  state: JsonRecord,
  turnId: string | null,
  settled: JsonRecord,
  outDir: string,
  language: string,
): StepSummary {
  const tools = toolRows(state, turnId);
  const toolNames = tools.map(row => String(row['tool_name']));
  const assistantText = assistantTexts(state, turnId).join('\n\n');
  const guardrailSignals = (scenario.guardrailProbe ?? inferGuardrailProbe(scenario))
    ? [
        ...detectGuardrailSignals(assistantText, toolNames),
        ...detectGmQualitySignals(assistantText, scenario, toolNames),
      ]
    : [];
  const requiredStateChanges = (scenario.requiredStateChanges ?? []).filter(
    domain => shouldRequireStateChange(scenario, domain, tools),
  );
  const stateChangeSignals = requiredStateChanges.filter(domain =>
    stateDomainChanged(beforeState, state, domain),
  );
  const issues: StepSummary['issues'] = [];
  const status = typeof settled['status'] === 'string' ? settled['status'] : null;
  const ok = settled['ok'] === true;
  if (!ok) {
    issues.push({severity: 'P0', message: `turn did not settle cleanly: ${status ?? 'unknown'}`});
  }
  if (containsMojibake(assistantText)) {
    issues.push({severity: 'P1', message: 'persisted assistant text contains mojibake'});
  }
  if (language.toLowerCase().startsWith('ru') && looksEnglishHeavy(assistantText)) {
    issues.push({severity: 'P2', message: 'Russian turn produced English-heavy prose'});
  }
  if (
    scenario.stateChanging &&
    onlyNarration(toolNames) &&
    stateChangeSignals.length === 0
  ) {
    issues.push({
      severity: 'P1',
      message: 'state-changing player intent was answered with narration only',
    });
  }
  if (guardrailSignals.includes('over_guarded_refusal')) {
    issues.push({
      severity: 'P1',
      message: 'guardrail-heavy answer blocked play without a grounded alternative',
    });
  }
  if (guardrailSignals.includes('mechanics_without_world')) {
    issues.push({
      severity: 'P1',
      message: 'mechanical answer lacked in-world GM framing',
    });
  }
  if (guardrailSignals.includes('gm_no_clarify_or_options')) {
    issues.push({
      severity: 'P2',
      message: 'GM answer did not create a playable next move',
    });
  }
  if (guardrailSignals.includes('gm_low_reactivity')) {
    issues.push({
      severity: scenario.stateChanging ? 'P1' : 'P2',
      message: 'GM answer preserved mechanics but lacked living-world reactivity',
    });
  }
  const expected = scenario.expectedTools ?? [];
  if (expected.length > 0 && !expected.some(tool => toolNames.includes(tool))) {
    issues.push({
      severity: scenario.stateChanging ? 'P1' : 'P2',
      message: `none of expected tools were used: ${expected.join(', ')}`,
    });
  }
  const required = scenario.requiredTools ?? [];
  const missingRequired = required.filter(tool => !toolNames.includes(tool));
  if (missingRequired.length > 0) {
    issues.push({
      severity: scenario.stateChanging ? 'P1' : 'P2',
      message: `required tools missing: ${missingRequired.join(', ')}`,
    });
  }
  const forbidden = scenario.forbiddenTools ?? [];
  const usedForbidden = forbidden.filter(tool => toolNames.includes(tool));
  if (usedForbidden.length > 0) {
    issues.push({
      severity: scenario.stateChanging ? 'P1' : 'P2',
      message: `forbidden tools used: ${usedForbidden.join(', ')}`,
    });
  }
  const requiredGroups = (scenario.requiredToolGroups ?? []).filter(group =>
    shouldRequireToolGroup(scenario, group, tools),
  );
  for (const group of requiredGroups) {
    if (!group.some(tool => toolNames.includes(tool))) {
      issues.push({
        severity: scenario.stateChanging ? 'P1' : 'P2',
        message: `required tool group missing: ${group.join(' | ')}`,
      });
    }
  }
  const requiredRuntimeFields = scenario.requiredRuntimeFields ?? [];
  const mutatedFields = requiredRuntimeFields.length > 0 ||
    (scenario.forbiddenRuntimeFields?.length ?? 0) > 0
    ? mutatedRuntimeFieldIds(tools)
    : new Set<number>();
  if (requiredRuntimeFields.length > 0) {
    const missingFields = requiredRuntimeFields.filter(id => !mutatedFields.has(id));
    if (missingFields.length > 0) {
      issues.push({
        severity: scenario.stateChanging ? 'P1' : 'P2',
        message: `required runtime fields missing: ${missingFields.join(', ')}`,
      });
    }
  }
  const forbiddenRuntimeFields = scenario.forbiddenRuntimeFields ?? [];
  const usedForbiddenFields = forbiddenRuntimeFields.filter(id => mutatedFields.has(id));
  if (usedForbiddenFields.length > 0) {
    issues.push({
      severity: scenario.stateChanging ? 'P1' : 'P2',
      message: `forbidden runtime fields changed: ${usedForbiddenFields.join(', ')}`,
    });
  }
  const missingStateChanges = requiredStateChanges.filter(
    domain => !stateChangeSignals.includes(domain),
  );
  if (missingStateChanges.length > 0) {
    issues.push({
      severity: scenario.stateChanging ? 'P1' : 'P2',
      message: `required state changes missing: ${missingStateChanges.join(', ')}`,
    });
  }
  for (const row of activeQueueRows(state)) {
    issues.push({
      severity: 'P1',
      message: `unfinished queue row ${String(row['turn_id'] ?? row['id'])} status=${String(row['status'])}`,
    });
  }
  return {
    slug: scenario.slug,
    title: scenario.title,
    turnId,
    status,
    ok: ok && issues.every(issue => issue.severity !== 'P0'),
    axis: scenario.axis ?? inferAxis(scenario),
    expectedOutcome: scenario.expectedOutcome ?? inferExpectedOutcome(scenario),
    toolNames,
    guardrailSignals,
    stateChangeSignals,
    issues,
    outDir,
  };
}

function inferAxis(scenario: Scenario): StepSummary['axis'] {
  const slug = scenario.slug;
  if (
    slug.includes('quest') ||
    slug.includes('item') ||
    slug.includes('payment') ||
    slug.includes('combat') ||
    slug.includes('travel')
  ) {
    return 'core';
  }
  if (
    slug.includes('social') ||
    slug.includes('creative') ||
    slug.includes('rumor') ||
    slug.includes('drag') ||
    slug.includes('silent')
  ) {
    return 'gm_freedom';
  }
  if (
    slug.includes('new-player') ||
    slug.includes('impossible') ||
    slug.includes('ready-trigger') ||
    slug.includes('language')
  ) {
    return 'balance';
  }
  return 'regression';
}

function inferExpectedOutcome(scenario: Scenario): StepSummary['expectedOutcome'] {
  const slug = scenario.slug;
  if (slug.includes('impossible') || slug.includes('missing-item')) return 'No-but';
  if (slug.includes('creative') || slug.includes('combat') || slug.includes('social')) {
    return 'Roll';
  }
  if (slug.includes('new-player')) return 'Clarify';
  if (slug.includes('rumor') || slug.includes('silent') || slug.includes('drag')) {
    return 'Yes-and';
  }
  return 'Yes';
}

function inferGuardrailProbe(scenario: Scenario): boolean {
  return inferAxis(scenario) !== 'core' || Boolean(scenario.stateChanging);
}

function detectGuardrailSignals(text: string, toolNames: string[]): string[] {
  const signals: string[] = [];
  const normalized = text.toLowerCase();
  const escapedSignals = detectGuardrailSignalsEscaped(normalized, toolNames);
  if (escapedSignals.length > 0) return escapedSignals;
  const refusal =
    /\b(cannot|can't|not allowed|invalid|rules|interface|mechanic)\b/.test(normalized) ||
    /не могу|нельзя|невозможно|правил|интерфейс|механик/.test(normalized);
  const hasAlternative =
    /\b(but|instead|try|you can|could)\b/.test(normalized) ||
    /но|зато|вместо|можешь|попробуй|вариант/.test(normalized);
  if (refusal && !hasAlternative) {
    signals.push('over_guarded_refusal');
  }
  const mechanicsWords =
    /\b(dc|roll|check|quest|stage|tool|state|inventory)\b/.test(normalized) ||
    /бросок|сложност|квест|стад|инвентар|состояни/.test(normalized);
  const worldWords =
    /виж|слыш|пах|свет|тень|голос|улыб|рук|двер|занавес|стойк|монет/.test(normalized) ||
    /\b(see|hear|smell|voice|door|curtain|coin|lantern|workshop|hum|lamp|light|bench|module|socket|optic|gear|brass|panel|ozone|copper|chassis|relay|tool-arm|counter|checksum)\b/.test(normalized);
  if (mechanicsWords && !worldWords && toolNames.length <= 1) {
    signals.push('mechanics_without_world');
  }
  return signals;
}

function detectGmQualitySignals(
  text: string,
  scenario: Scenario,
  toolNames: string[],
): string[] {
  const signals: string[] = [];
  const normalized = text.toLowerCase();
  const axis = scenario.axis ?? inferAxis(scenario);
  const expected = scenario.expectedOutcome ?? inferExpectedOutcome(scenario);
  const hasClarifyingQuestion = /[?？]/.test(text);
  const hasChoiceLanguage = hasPlayableChoiceLanguage(normalized);
  const hasWorldReaction = hasLivingWorldReaction(normalized);
  const hasMention = /@\S/.test(text);

  if (
    axis === 'balance' &&
    expected === 'Clarify' &&
    !hasClarifyingQuestion &&
    !hasChoiceLanguage
  ) {
    signals.push('gm_no_clarify_or_options');
  }

  if (
    (axis === 'gm_freedom' || expected === 'Yes-and') &&
    toolNames.length <= 1 &&
    !hasWorldReaction &&
    !hasMention
  ) {
    signals.push('gm_low_reactivity');
  }

  return signals;
}

function hasPlayableChoiceLanguage(normalized: string): boolean {
  return (
    /(?:^|\n)\s*(?:1[.)]|-\s+|\*)/.test(normalized) ||
    hasRepeatedShortChoiceLabels(normalized) ||
    hasRepeatedDashChoiceClauses(normalized) ||
    /\b(?:you can|you could|try|choose|option|instead|next|either|or)\b/.test(
      normalized,
    ) ||
    /(?:\u043c\u043e\u0436\u0435\u0448\u044c|\u043c\u043e\u0436\u043d\u043e|\u043f\u043e\u043f\u0440\u043e\u0431\u0443\u0439|\u0432\u044b\u0431\u0435\u0440\u0438|\u0432\u0430\u0440\u0438\u0430\u043d\u0442|\u0438\u043b\u0438|\u0441\u043b\u0435\u0434\u0443\u044e\u0449)/.test(
      normalized,
    )
  );
}

function hasRepeatedShortChoiceLabels(normalized: string): boolean {
  const matches = normalized.match(
    /(?:^|[\n.!?]\s+)[^\n.!?:]{1,24}:\s+\S/g,
  );
  return (matches?.length ?? 0) >= 2;
}

function hasRepeatedDashChoiceClauses(normalized: string): boolean {
  const matches = normalized.match(
    /(?:^|[\n.!?]\s+)[\p{L}\p{N}\s'"«»“”]{2,28}\s[-—]\s+\S/gu,
  );
  return (matches?.length ?? 0) >= 2;
}

function hasLivingWorldReaction(normalized: string): boolean {
  return (
    /\b(?:reacts?|answers?|notices?|leans?|offers?|warns?|risk|cost|lead|hook|rumou?r|consequence|pressure)\b/.test(
      normalized,
    ) ||
    /(?:\u0440\u0435\u0430\u0433\u0438\u0440|\u043e\u0442\u0432\u0435\u0447|\u0437\u0430\u043c\u0435\u0447|\u043a\u0438\u0432\u0430|\u0443\u043b\u044b\u0431|\u043f\u0440\u0435\u0434\u043b\u0430\u0433|\u043f\u0440\u0435\u0434\u0443\u043f\u0440\u0435\u0436\u0434|\u0440\u0438\u0441\u043a|\u0446\u0435\u043d\u0430|\u0441\u043b\u0435\u0434|\u0437\u0430\u0446\u0435\u043f|\u0441\u043b\u0443\u0445|\u043f\u043e\u0441\u043b\u0435\u0434\u0441\u0442\u0432|\u043d\u0430\u043f\u0440\u044f\u0436)/.test(
      normalized,
    )
  );
}

function detectGuardrailSignalsEscaped(
  normalized: string,
  toolNames: string[],
): string[] {
  const signals: string[] = [];
  const refusal =
    /\b(cannot|can't|not allowed|invalid|rules|interface|mechanic)\b/.test(normalized) ||
    /(?:\u043d\u0435\s+\u043c\u043e\u0433\u0443|\u043d\u0435\u043b\u044c\u0437\u044f|\u043d\u0435\u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e|\u043f\u0440\u0430\u0432\u0438\u043b|\u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441|\u043c\u0435\u0445\u0430\u043d\u0438\u043a)/.test(normalized);
  const hasAlternative =
    /\b(but|instead|try|you can|could)\b/.test(normalized) ||
    /(?:\u043d\u043e|\u0437\u0430\u0442\u043e|\u0432\u043c\u0435\u0441\u0442\u043e|\u043c\u043e\u0436\u0435\u0448\u044c|\u043f\u043e\u043f\u0440\u043e\u0431\u0443\u0439|\u0432\u0430\u0440\u0438\u0430\u043d\u0442)/.test(normalized);
  if (refusal && !hasAlternative) {
    signals.push('over_guarded_refusal');
  }
  const mechanicsWords =
    /\b(dc|roll|check|quest|stage|tool|state|inventory)\b/.test(normalized) ||
    /(?:\u0431\u0440\u043e\u0441\u043e\u043a|\u0441\u043b\u043e\u0436\u043d\u043e\u0441\u0442|\u043a\u0432\u0435\u0441\u0442|\u0441\u0442\u0430\u0434|\u0438\u043d\u0432\u0435\u043d\u0442\u0430\u0440|\u0441\u043e\u0441\u0442\u043e\u044f\u043d\u0438)/.test(normalized);
  const worldWords =
    /(?:\u0432\u0438\u0436|\u0441\u043b\u044b\u0448|\u043f\u0430\u0445|\u0441\u0432\u0435\u0442|\u0442\u0435\u043d\u044c|\u0433\u043e\u043b\u043e\u0441|\u0443\u043b\u044b\u0431|\u0440\u0443\u043a|\u0434\u0432\u0435\u0440|\u0437\u0430\u043d\u0430\u0432\u0435\u0441|\u0441\u0442\u043e\u0439\u043a|\u043c\u043e\u043d\u0435\u0442)/.test(normalized) ||
    /\b(see|hear|smell|voice|door|curtain|coin|lantern|workshop|hum|lamp|light|bench|module|socket|optic|gear|brass|panel|ozone|copper|chassis|relay|tool-arm|counter|checksum)\b/.test(normalized);
  if (mechanicsWords && !worldWords && toolNames.length <= 1) {
    signals.push('mechanics_without_world');
  }
  return signals;
}

function onlyNarration(toolNames: string[]): boolean {
  if (toolNames.length === 0) return true;
  return toolNames.every(name => name === 'narrate');
}

function mutatedRuntimeFieldIds(tools: JsonRecord[]): Set<number> {
  const ids = new Set<number>();
  for (const row of tools) {
    const toolName = String(row['tool_name'] ?? '');
    const args = readToolArgs(row);
    if (toolName === 'set_runtime_field') {
      const fieldId = Number(args?.['field_id']);
      if (Number.isFinite(fieldId)) ids.add(fieldId);
    }
    if (toolName === 'apply_runtime_field_patch') {
      const patches = args?.['patches'];
      if (!Array.isArray(patches)) continue;
      for (const patch of patches) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
        const fieldId = Number((patch as JsonRecord)['field_id']);
        if (Number.isFinite(fieldId)) ids.add(fieldId);
      }
    }
    if (toolName === 'complete_quest') {
      const result = asRecord(row['result']);
      const data = asRecord(result['data']);
      const container = Object.keys(data).length > 0 ? data : result;
      const rewards = asRecord(container['rewards_applied']);
      const patches = rewards['runtime_field_patches'];
      if (!Array.isArray(patches)) continue;
      for (const patch of patches) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
        const fieldId = Number((patch as JsonRecord)['field_id']);
        if (Number.isFinite(fieldId)) ids.add(fieldId);
      }
    }
  }
  return ids;
}

function shouldRequireToolGroup(
  scenario: Scenario,
  group: string[],
  tools: JsonRecord[],
): boolean {
  if (
    scenario.slug === 'player-authored-cache-quest-mikka' &&
    group.some(tool => tool === 'create_quest') &&
    hasFailedDiceCheck(tools)
  ) {
    return false;
  }
  return true;
}

function shouldRequireStateChange(
  scenario: Scenario,
  domain: StateChangeDomain,
  tools: JsonRecord[],
): boolean {
  if (
    scenario.slug === 'player-authored-cache-quest-mikka' &&
    domain === 'player_quests' &&
    hasFailedDiceCheck(tools)
  ) {
    return false;
  }
  return true;
}

function hasFailedDiceCheck(tools: JsonRecord[]): boolean {
  return tools.some(row => {
    if (String(row['tool_name'] ?? '') !== 'dice_check') return false;
    const result = asRecord(row['result']);
    return result['outcome'] === 'failure' || result['ok'] === false;
  });
}

function readToolArgs(row: JsonRecord): JsonRecord | null {
  const raw = row['args'] ?? row['args_json'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as JsonRecord;
}

function containsMojibake(text: string): boolean {
  return /[ÐÑ][\u0080-\u00bf]?/.test(text);
}

function looksEnglishHeavy(text: string): boolean {
  const matches = text.match(/\b(the|you|your|quest|payment|trust|attack|go|take)\b/gi);
  return (matches?.length ?? 0) >= 5;
}

function toolRows(state: JsonRecord, turnId: string | null): JsonRecord[] {
  return baseRows(state, 'tool_invocations').filter(row => {
    if (!turnId) return false;
    const rowTurn = String(row['turn_id'] ?? '');
    return rowTurn === turnId || rowTurn.startsWith(`${turnId}:`);
  });
}

function assistantTexts(state: JsonRecord, turnId: string | null): string[] {
  return baseRows(state, 'chat_messages')
    .filter(row => {
      if (!turnId) return false;
      if (row['tone'] === 'player') return false;
      const rowTurn = String(asRecord(row['payload'])?.['turn_id'] ?? row['turn_id'] ?? '');
      return rowTurn === turnId || rowTurn.startsWith(`${turnId}:`);
    })
    .map(row => (typeof row['text'] === 'string' ? row['text'] : ''))
    .filter(Boolean);
}

function activeQueueRows(state: JsonRecord): JsonRecord[] {
  const live = asRecord(state['live']);
  const rows = Array.isArray(live['turn_ingress_queue'])
    ? live['turn_ingress_queue']
    : [];
  return rows.filter(isRecord).filter(row => {
    const status = String(row['status'] ?? '');
    return !['done', 'failed', 'cancelled'].includes(status);
  });
}

function stateDomainChanged(
  beforeState: JsonRecord,
  afterState: JsonRecord,
  domain: StateChangeDomain,
): boolean {
  return stableDomainSnapshot(beforeState, domain) !==
    stableDomainSnapshot(afterState, domain);
}

function stableDomainSnapshot(state: JsonRecord, domain: StateChangeDomain): string {
  return JSON.stringify(
    stateRowsForDomain(state, domain)
      .map(row => sanitizeVolatileRow(row))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

function stateRowsForDomain(
  state: JsonRecord,
  domain: StateChangeDomain,
): JsonRecord[] {
  if (domain === 'adventure_queue') {
    const live = asRecord(state['live']);
    const rows = Array.isArray(live['adventure_queue'])
      ? live['adventure_queue']
      : [];
    return rows.filter(isRecord);
  }
  if (domain === 'gui_events') {
    const live = asRecord(state['live']);
    const rows = Array.isArray(live['gui_events']) ? live['gui_events'] : [];
    return rows.filter(isRecord);
  }
  if (domain === LIVE_PLAYTEST_NPC_MEMORIES_KEY) {
    const live = asRecord(state['live']);
    const liveRows = Array.isArray(live[LIVE_PLAYTEST_NPC_MEMORIES_KEY])
      ? live[LIVE_PLAYTEST_NPC_MEMORIES_KEY]
      : [];
    return (liveRows as unknown[]).filter(isRecord);
  }
  if (domain === 'entities') {
    const base = baseRows(state, 'entities');
    const live = asRecord(state['live']);
    const nearby = Array.isArray(live['nearby_entities'])
      ? live['nearby_entities']
      : [];
    return [...base, ...nearby.filter(isRecord)];
  }
  if (domain === 'runtime_fields') {
    return [
      ...baseRows(state, 'runtime_values'),
      ...baseRows(state, 'runtime_player_overlay'),
    ];
  }
  return baseRows(state, domain);
}

function sanitizeVolatileRow(row: JsonRecord): JsonRecord {
  const copy: JsonRecord = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      key === 'created_at' ||
      key === 'updated_at' ||
      key === 'captured_at'
    ) {
      continue;
    }
    copy[key] = value;
  }
  return copy;
}

async function createMarathonPlayer(args: Args): Promise<number> {
  const player = await postJson(`${args.server}/api/player/anonymous`, {
    displayName: 'Ревизор Гринхейвена',
  });
  const playerId = Number(player['entity_id']);
  if (!Number.isInteger(playerId) || playerId <= 0) {
    throw new Error(`anonymous player response did not include entity_id`);
  }
  await fetch(`${args.server}/api/player/${playerId}/profile`, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      created: true,
      identity: {
        name: 'Ревизор Гринхейвена',
        pronouns: 'он/его',
        race: 'человек',
        age: 31,
        gender_expression: 'сдержанная дорожная практичность',
      },
      physical: {
        build: 'сухой и выносливый',
        voice: 'тихий, внимательный',
        eyes: 'серые, цепкие',
      },
      background: {
        origin_paragraph:
          'Тестовый странник, который проверяет, живет ли мир под давлением странных решений.',
        motivation: 'найти трещины в логике мира',
        temperament: 'наблюдательный, упрямый',
        notable_skills: ['проверка обещаний', 'провокационные вопросы'],
      },
    }),
  }).then(async response => {
    if (!response.ok) {
      throw new Error(`profile patch failed: ${response.status} ${await response.text()}`);
    }
  });
  return playerId;
}

function parseArgs(argv: string[]): Args {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scenariosArg = stringArg(argv, 'scenarios');
  const outRaw =
    stringArg(argv, 'out') ?? `.codex/run-logs/live-playtest/${stamp}-marathon`;
  return {
    server: (stringArg(argv, 'server') ?? 'http://127.0.0.1:7777').replace(/\/$/, ''),
    playerId: positiveIntArg(argv, 'player-id') ?? positiveIntArg(argv, 'playerId'),
    sessionId:
      stringArg(argv, 'session-id') ??
      stringArg(argv, 'sessionId') ??
      `debug-marathon-${stamp}`,
    language: stringArg(argv, 'language') ?? 'ru',
    limit: positiveIntArg(argv, 'limit') ?? 180,
    timeoutMs: positiveIntArg(argv, 'timeout-ms') ?? 210_000,
    pollMs: positiveIntArg(argv, 'poll-ms') ?? 2_000,
    outDir: resolveOutDir(outRaw),
    scenarios: scenariosArg
      ? new Set(scenariosArg.split(',').map(s => s.trim()).filter(Boolean))
      : null,
    stopOnP0: flagArg(argv, 'stop-on-p0'),
  };
}

function resolveOutDir(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(repoRootFromCwd(), raw);
}

function repoRootFromCwd(): string {
  const cwd = process.cwd();
  if (
    path.basename(cwd).toLowerCase() === 'web-server' &&
    path.basename(path.dirname(cwd)).toLowerCase() === 'packages'
  ) {
    return path.resolve(cwd, '..', '..');
  }
  return cwd;
}

async function liveState(
  args: Args,
  playerId: number,
  sessionId: string,
): Promise<JsonRecord> {
  const url = new URL(`${args.server}/api/debug/live-state`);
  url.searchParams.set('playerId', String(playerId));
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('limit', String(args.limit));
  return getJson(url.toString());
}

async function waitForTurn(
  args: Args,
  playerId: number,
  sessionId: string,
  turnId: string | undefined,
): Promise<JsonRecord> {
  const startedAt = Date.now();
  let last: JsonRecord = {};
  while (Date.now() - startedAt < args.timeoutMs) {
    last = await liveState(args, playerId, sessionId);
    const queueRow = activeOrKnownQueueRow(last, turnId);
    const status = queueRow && typeof queueRow['status'] === 'string'
      ? queueRow['status']
      : undefined;
    const active = activeTurn(last, turnId);
    if (!active && ['done', 'failed', 'cancelled'].includes(status ?? '')) {
      return {
        ok: status === 'done',
        status,
        elapsedMs: Date.now() - startedAt,
        turnId,
      };
    }
    await sleep(args.pollMs);
  }
  return {
    ok: false,
    status: 'timeout',
    elapsedMs: Date.now() - startedAt,
    turnId,
    lastQueue: activeQueueRows(last),
  };
}

async function waitForIdle(
  args: Args,
  playerId: number,
  sessionId: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const state = await liveState(args, playerId, sessionId);
    if (!activeTurn(state) && !presentationBarrier(state)) return;
    await sleep(args.pollMs);
  }
}

function activeOrKnownQueueRow(
  state: JsonRecord,
  turnId: string | undefined,
): JsonRecord | null {
  const live = asRecord(state['live']);
  const rows = Array.isArray(live['turn_ingress_queue'])
    ? live['turn_ingress_queue']
    : [];
  return (
    rows
      .filter(isRecord)
      .find(row => !turnId || row['turn_id'] === turnId) ?? null
  );
}

function activeTurn(state: JsonRecord, turnId?: string): boolean {
  return sessionSummaries(state).some(session => {
    const active = asRecord(session['activeTurn']);
    if (!active) return false;
    return !turnId || active['turnId'] === turnId;
  });
}

function presentationBarrier(state: JsonRecord): boolean {
  return sessionSummaries(state).some(session => Boolean(session['presentationBarrier']));
}

function sessionSummaries(state: JsonRecord): JsonRecord[] {
  const live = asRecord(state['live']);
  const sessions = Array.isArray(live['in_memory_sessions'])
    ? live['in_memory_sessions']
    : [];
  return sessions.filter(isRecord);
}

async function getJson(url: string): Promise<JsonRecord> {
  const response = await fetch(url);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text}`);
  if (!isRecord(parsed)) throw new Error(`unexpected JSON from ${url}`);
  return parsed;
}

async function postJson(url: string, body: JsonRecord): Promise<JsonRecord> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text}`);
  if (!isRecord(parsed)) throw new Error(`unexpected JSON from ${url}`);
  return parsed;
}

async function writeJson(
  outDir: string,
  filename: string,
  data: unknown,
): Promise<void> {
  await fs.writeFile(
    path.join(outDir, filename),
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8',
  );
}

function renderSummary(input: {
  playerId: number;
  sessionId: string;
  summaries: StepSummary[];
}): string {
  const lines = [
    '# Live Playtest Marathon Summary',
    '',
    `- Player/session: ${input.playerId} / ${input.sessionId}`,
    `- Scenarios: ${input.summaries.length}`,
    '',
  ];
  for (const summary of input.summaries) {
    const icon = summary.issues.length === 0 ? 'PASS' : 'REVIEW';
    lines.push(`## ${icon} - ${summary.slug}`);
    lines.push(`- Turn: ${summary.turnId ?? 'unknown'} (${summary.status ?? 'unknown'})`);
    lines.push(`- Axis: ${summary.axis}`);
    if (summary.expectedOutcome) {
      lines.push(`- Expected GM outcome: ${summary.expectedOutcome}`);
    }
    lines.push(`- Tools: ${summary.toolNames.join(', ') || 'none'}`);
    lines.push(`- Guardrail signals: ${summary.guardrailSignals.join(', ') || 'none'}`);
    lines.push(`- State changes: ${summary.stateChangeSignals.join(', ') || 'none'}`);
    lines.push(`- Evidence: ${summary.outDir}`);
    if (summary.issues.length > 0) {
      for (const issue of summary.issues) {
        lines.push(`- ${issue.severity}: ${issue.message}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function renderBugLedger(summary: StepSummary): string {
  if (summary.issues.length === 0) {
    return `# Bug Ledger\n\nNo automatic findings. Review JSON artifacts for gameplay quality.\n`;
  }
  const lines = ['# Bug Ledger', ''];
  for (const issue of summary.issues) {
    lines.push(`## ${issue.message}`);
    lines.push(`- Severity: ${issue.severity}`);
    lines.push(`- Scenario: ${summary.slug}`);
    lines.push(`- Axis: ${summary.axis}`);
    lines.push(`- Expected GM outcome: ${summary.expectedOutcome ?? 'not set'}`);
    lines.push(`- Turn: ${summary.turnId ?? 'unknown'}`);
    lines.push(`- Tools: ${summary.toolNames.join(', ') || 'none'}`);
    lines.push(`- Guardrail signals: ${summary.guardrailSignals.join(', ') || 'none'}`);
    lines.push(`- State changes: ${summary.stateChangeSignals.join(', ') || 'none'}`);
    lines.push(`- Evidence: ${summary.outDir}`);
    lines.push('- Expected: world state and narration stay consistent');
    lines.push('- Actual: see step summary and live-state snapshots');
    lines.push('- Suspected owner: backend/model contract until manually classified');
    lines.push('- Fix path: inspect turn tools, prompts, queue state, and durable rows');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function baseRows(state: JsonRecord, key: string): JsonRecord[] {
  const base = asRecord(state['baseSnapshot']);
  const data = asRecord(base['data']);
  const rows = Array.isArray(data[key]) ? data[key] : [];
  return rows.filter(isRecord);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const next = argv[idx + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

function flagArg(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function positiveIntArg(argv: string[], name: string): number | undefined {
  const raw = stringArg(argv, name);
  const n = raw == null ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
