import type {
  CoordinatorBrief,
  CoordinatorInput,
  CoordinatorModelBrief,
} from './intimacyCoordinatorTypes.js';

type ToolPlanItem = CoordinatorBrief['tool_plan'][number];
type ToolName = ToolPlanItem['name'];
type PolicyInput = CoordinatorBrief | CoordinatorModelBrief;

const QUEST_MUTATION_TOOLS = new Set<ToolName>([
  'start_quest',
  'advance_quest',
  'complete_quest',
  'create_quest',
]);

const DYNAMIC_QUEST_START_PHASES = new Set(['approach', 'consent']);
const ADVANCE_PHASES = new Set(['consent', 'foreplay', 'climax']);
const SEX_MOVE_TOOLS = new Set<ToolName>([
  'add_memory',
  'apply_runtime_field_patch',
  'inventory_transfer',
  'string_award',
]);

export function normalizeCoordinatorBrief(
  brief: PolicyInput,
  input: CoordinatorInput,
): CoordinatorBrief {
  const toolPlan = proposedToolsFromModelOutput(brief);
  const language = brief.language ?? input.language ?? undefined;

  const phase = brief.phase;
  const base: CoordinatorBrief = {
    phase,
    quest_strategy: 'none',
    cartridge_quest_name: undefined,
    tool_plan: [],
    memory_canon: brief.memory_canon,
    handoff_recommend: brief.handoff_recommend,
    reason: brief.reason,
    language,
  };

  if (phase === 'skip') {
    return {
      ...base,
      quest_strategy: 'none',
      cartridge_quest_name: undefined,
      tool_plan: [],
      memory_canon: [],
      handoff_recommend: false,
      language,
    };
  }

  const activeQuest = input.partner.intimacy_quest_active;
  if (activeQuest) {
    return {
      ...base,
      quest_strategy: 'cartridge',
      cartridge_quest_name: activeQuest,
      tool_plan: compileToolPlan(base, input, 'cartridge', activeQuest, toolPlan),
      language,
    };
  }

  const canCreateDynamicQuest = DYNAMIC_QUEST_START_PHASES.has(phase);
  const questStrategy =
    wantsDynamicQuest(brief) && canCreateDynamicQuest
      ? 'dynamic'
      : 'none';

  return {
    ...base,
    quest_strategy: questStrategy,
    cartridge_quest_name: undefined,
    tool_plan: compileToolPlan(base, input, questStrategy, null, toolPlan),
    language,
  };
}

function wantsDynamicQuest(brief: PolicyInput): boolean {
  if ('quest_strategy' in brief) return brief.quest_strategy === 'dynamic';
  return Boolean(brief.dynamic_quest_copy) || DYNAMIC_QUEST_START_PHASES.has(brief.phase);
}

function proposedToolsFromModelOutput(brief: PolicyInput): ToolPlanItem[] {
  if ('tool_plan' in brief) {
    return brief.tool_plan.map(tool => ({
      name: tool.name,
      args: {...tool.args},
    }));
  }

  const out: ToolPlanItem[] = [];
  if (brief.dynamic_quest_copy) {
    out.push({
      name: 'create_quest',
      args: {
        ...brief.dynamic_quest_copy,
      },
    });
  }

  for (const intent of brief.resource_intents ?? []) {
    if (intent.kind === 'inventory_transfer') {
      const args: Record<string, unknown> = {};
      if (intent.item) args['item'] = intent.item;
      if (intent.count !== undefined) args['count'] = intent.count;
      if (intent.from_player_id !== undefined) {
        args['from_player_id'] = intent.from_player_id;
      }
      if (intent.to_player_id !== undefined) {
        args['to_player_id'] = intent.to_player_id;
      }
      if (intent.to) args['to'] = intent.to;
      if (intent.reason) args['reason'] = intent.reason;
      out.push({name: 'inventory_transfer', args});
      continue;
    }
    if (intent.kind === 'relationship_delta') {
      const args: Record<string, unknown> = {};
      if (intent.npc) args['npc'] = intent.npc;
      if (intent.delta !== undefined) args['delta'] = intent.delta;
      if (intent.reason) args['reason'] = intent.reason;
      out.push({name: 'string_award', args});
    }
  }

  return out;
}

function compileToolPlan(
  brief: CoordinatorBrief,
  input: CoordinatorInput,
  questStrategy: CoordinatorBrief['quest_strategy'],
  activeQuest: string | null,
  modelTools: ToolPlanItem[],
): ToolPlanItem[] {
  const out: ToolPlanItem[] = [
    ...compileQuestTools(brief, input, questStrategy, activeQuest, modelTools),
  ];

  for (const tool of modelTools) {
    if (QUEST_MUTATION_TOOLS.has(tool.name)) continue;
    const normalized = normalizeNonQuestTool(tool, brief, input);
    if (normalized) out.push(normalized);
  }

  const sexMove = compileSexMoveTool(brief, input);
  if (sexMove) out.push(sexMove);

  return dedupeToolPlan(out).slice(0, 8);
}

function compileQuestTools(
  brief: CoordinatorBrief,
  input: CoordinatorInput,
  questStrategy: CoordinatorBrief['quest_strategy'],
  activeQuest: string | null,
  modelTools: ToolPlanItem[],
): ToolPlanItem[] {
  if (questStrategy === 'cartridge' && activeQuest) {
    if (ADVANCE_PHASES.has(brief.phase)) {
      if (input.active_intimacy_quest_phase === brief.phase) return [];
      return [
        {
          name: 'advance_quest',
          args: {quest: activeQuest, to_stage: brief.phase},
        },
      ];
    }
    if (brief.phase === 'aftermath') {
      return [
        {
          name: 'complete_quest',
          args: {quest: activeQuest, outcome: 'completed'},
        },
      ];
    }
    return [];
  }

  if (
    questStrategy === 'dynamic' &&
    DYNAMIC_QUEST_START_PHASES.has(brief.phase)
  ) {
    const proposed = modelTools.find(tool => tool.name === 'create_quest');
    return [
      {
        name: 'create_quest',
        args: buildDynamicQuestArgs(proposed?.args ?? {}, input),
      },
    ];
  }

  return [];
}

function normalizeNonQuestTool(
  tool: ToolPlanItem,
  brief: CoordinatorBrief,
  input: CoordinatorInput,
): ToolPlanItem | null {
  if (tool.name === 'add_memory') return null;
  if (tool.name === 'award_xp') {
    if (brief.phase !== 'aftermath') return null;
    return {
      name: tool.name,
      args: {
        ...tool.args,
        player_id: input.player.id,
        amount: clampInt(tool.args['amount'], 50, 100, 75),
        reason: textOrFallback(tool.args['reason'], brief.reason),
      },
    };
  }
  if (tool.name === 'string_award') {
    return {
      name: tool.name,
      args: {
        ...tool.args,
        npc: textOrFallback(tool.args['npc'], input.partner.name),
        delta: clampInt(tool.args['delta'], -3, 3, 1),
      },
    };
  }
  if (tool.name === 'apply_runtime_field_patch') {
    const patches = Array.isArray(tool.args['patches'])
      ? tool.args['patches'].filter(isValidRuntimePatch)
      : [];
    if (patches.length === 0) return null;
    return {
      name: tool.name,
      args: {
        ...tool.args,
        patches,
      },
    };
  }
  if (tool.name === 'inventory_transfer') {
    return {
      name: tool.name,
      args: normalizeInventoryTransferArgs(tool.args, input.player.id),
    };
  }
  return tool;
}

function buildDynamicQuestArgs(
  proposed: Record<string, unknown>,
  input: CoordinatorInput,
): Record<string, unknown> {
  const title = clampText(
    textOrFallback(proposed['title'], input.partner.name),
    4,
    80,
  );
  const summary = clampText(
    textOrFallback(
      proposed['summary'],
      textOrFallback(proposed['goal_text'], input.player_prose || title),
    ),
    8,
    400,
  );
  const goalText = clampText(
    textOrFallback(proposed['goal_text'], summary),
    8,
    600,
  );
  const out: Record<string, unknown> = {
    ...proposed,
    title,
    summary,
    giver: input.partner.name,
    goal_text: goalText,
    stages: normalizeDynamicStages(proposed['stages']),
    rewards: normalizeDynamicRewards(proposed['rewards'], input.partner.name),
    tags: mergeTags(proposed['tags'], ['intimate', 'dynamic']),
    auto_start: true,
  };
  delete out['spawn_entities'];
  return out;
}

function normalizeDynamicStages(value: unknown): Array<{
  id: string;
  title: string;
  next_stage?: string;
}> {
  const proposed = Array.isArray(value) ? value : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of proposed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = typeof row['id'] === 'string' ? row['id'] : '';
    if (id) byId.set(id, row);
  }
  const ids = ['approach', 'consent', 'foreplay', 'climax', 'aftermath'];
  return ids.map((id, index) => {
    const row = byId.get(id);
    const title = clampText(textOrFallback(row?.['title'], id), 2, 120);
    const next = ids[index + 1];
    return next ? {id, title, next_stage: next} : {id, title};
  });
}

function normalizeDynamicRewards(
  value: unknown,
  partnerName: string,
): Record<string, unknown> {
  const proposed =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const strings = Array.isArray(proposed['strings'])
    ? proposed['strings']
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map(item => item as Record<string, unknown>)
        .slice(0, 5)
        .map(item => ({
          npc: textOrFallback(item['npc'], partnerName),
          delta: clampInt(item['delta'], -3, 3, 1),
        }))
    : [{npc: partnerName, delta: 1}];
  return {
    ...proposed,
    xp: clampInt(proposed['xp'], 0, 2000, 80),
    strings,
  };
}

function compileSexMoveTool(
  brief: CoordinatorBrief,
  input: CoordinatorInput,
): ToolPlanItem | null {
  if (brief.phase !== 'aftermath') return null;
  const sexMove = input.partner.sex_move;
  const name = sexMove?.['effect_tool'];
  if (typeof name !== 'string' || !SEX_MOVE_TOOLS.has(name as ToolName)) {
    return null;
  }
  const args = sexMove?.['effect_args'];
  return {
    name: name as ToolName,
    args:
      args && typeof args === 'object' && !Array.isArray(args)
        ? {...(args as Record<string, unknown>)}
        : {},
  };
}

function dedupeToolPlan(tools: ToolPlanItem[]): ToolPlanItem[] {
  const seen = new Set<string>();
  const out: ToolPlanItem[] = [];
  for (const tool of tools) {
    const key = JSON.stringify(tool);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tool);
  }
  return out;
}

function normalizeInventoryTransferArgs(
  args: Record<string, unknown>,
  playerId: number,
): Record<string, unknown> {
  const out = {...args};
  if ('from_player_id' in out) out['from_player_id'] = playerId;
  if ('to_player_id' in out) out['to_player_id'] = playerId;
  return out;
}

function isValidRuntimePatch(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fieldId = (value as Record<string, unknown>)['field_id'];
  return Number.isInteger(fieldId) && Number(fieldId) > 0;
}

function mergeTags(value: unknown, required: string[]): string[] {
  const tags = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  for (const tag of required) {
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 8);
}

function textOrFallback(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function clampText(value: string, min: number, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const padded =
    compact.length >= min
      ? compact
      : `${compact} ${compact}`.trim().padEnd(min, '.');
  return padded.length <= max ? padded : padded.slice(0, max).trimEnd();
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  const n = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  return Math.max(min, Math.min(max, n));
}
