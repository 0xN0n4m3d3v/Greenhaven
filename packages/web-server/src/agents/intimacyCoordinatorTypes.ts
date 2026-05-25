import {z} from 'zod';

const Phase = z.enum([
  'approach',
  'consent',
  'foreplay',
  'climax',
  'aftermath',
  'skip',
]);

const MemoryCanon = z
  .array(
    z.object({
      owner: z.union([z.string(), z.number()]),
      about: z.union([z.string(), z.number()]).nullable(),
      text: z.string().min(1).max(400),
      importance: z.number().min(0.5).max(0.95),
      tags: z.array(z.string()).max(6),
    }),
  )
  .max(2);

const DynamicQuestCopy = z.object({
  title: z.string().min(1).max(120).optional(),
  summary: z.string().min(1).max(500).optional(),
  goal_text: z.string().min(1).max(700).optional(),
});

const InventoryTransferIntent = z.object({
  kind: z.literal('inventory_transfer'),
  item: z.string().min(1).max(160).optional(),
  count: z.union([z.number(), z.string()]).optional(),
  from_player_id: z.number().int().positive().optional(),
  to_player_id: z.number().int().positive().optional(),
  to: z.string().min(1).max(160).optional(),
  reason: z.string().max(240).optional(),
});

const RelationshipDeltaIntent = z.object({
  kind: z.literal('relationship_delta'),
  npc: z.string().min(1).max(160).optional(),
  delta: z.number().int().min(-3).max(3).optional(),
  reason: z.string().max(240).optional(),
});

export const CoordinatorModelOutput = z.object({
  phase: Phase,
  dynamic_quest_copy: DynamicQuestCopy.nullable().optional(),
  resource_intents: z
    .array(z.discriminatedUnion('kind', [InventoryTransferIntent, RelationshipDeltaIntent]))
    .max(5)
    .optional(),
  memory_canon: MemoryCanon,
  handoff_recommend: z.boolean(),
  reason: z.string().min(1).max(300),
  language: z.string().min(2).max(8).optional(),
});

export const ToolPlan = z
  .array(
    z.object({
      name: z.enum([
        'start_quest',
        'advance_quest',
        'complete_quest',
        'create_quest',
        'add_memory',
        'string_award',
        'apply_runtime_field_patch',
        'inventory_transfer',
        'award_xp',
      ]),
      args: z.record(z.string(), z.unknown()),
    }),
  )
  .max(8);

export const CoordinatorRuntimeBrief = z.object({
  phase: Phase,
  quest_strategy: z.enum(['cartridge', 'dynamic', 'none']),
  cartridge_quest_name: z.string().optional(),
  tool_plan: ToolPlan,
  memory_canon: MemoryCanon,
  handoff_recommend: z.boolean(),
  reason: z.string().min(1).max(300),
  language: z.string().min(2).max(8).optional(),
});

// Specialist model output. The model is no longer allowed to author mutation
// tool calls directly; policy compiles this weaker proposal into a runtime
// brief with a tool_plan.
export const CoordinatorOutput = CoordinatorModelOutput;

export type CoordinatorModelBrief = z.infer<typeof CoordinatorModelOutput>;
export type CoordinatorBrief = z.infer<typeof CoordinatorRuntimeBrief>;

export interface PartnerState {
  name: string;
  mood: string | null;
  strings: number;
  intimacy_quest_active: string | null;
  sex_move: Record<string, unknown> | null;
}

export interface ParticipantState {
  id: number;
  name: string;
  mood: string | null;
  strings: number;
}

export interface CoordinatorInput {
  player: {
    id: number;
    name: string;
  };
  player_prose: string;
  partner: PartnerState;
  language: string | null;
  participants: ParticipantState[];
  active_intimacy_quest_phase: string | null;
  recent_intimate_beats: Array<{phase: string; when: string}>;
}
