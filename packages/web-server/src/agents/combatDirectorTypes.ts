import {z} from 'zod';

export const DirectorOutput = z.object({
  roll_plan: z.object({
    skip_attack_roll: z.boolean(),
    reason: z.string().min(1).max(300),
  }),
  damage_plan: z.object({
    target: z.string().min(1),
    amount: z.number().int().min(0).max(60),
    type: z.string().optional(),
    source: z.string().optional(),
  }),
  position: z.enum(['controlled', 'risky', 'desperate']),
  effect: z.enum(['limited', 'standard', 'great']),
  conditions: z
    .array(
      z.object({
        target: z.string(),
        tag: z.string(),
        duration_turns: z.number().int().min(1).max(10),
        severity: z.number().int().min(1).max(3),
      }),
    )
    .max(2)
    .optional(),
  memory_canon: z
    .array(
      z.object({
        owner: z.union([z.string(), z.number()]),
        about: z.union([z.string(), z.number()]),
        text: z.string().min(1).max(400),
        importance: z.number().min(0.5).max(0.95),
        tags: z.array(z.string()).max(6),
      }),
    )
    .max(2),
  language: z.string().min(2).max(8).optional(),
});

export type DirectorBrief = z.infer<typeof DirectorOutput>;

export interface DirectorInput {
  player_prose: string;
  player: {id: number; name: string; hp: number; max_hp: number};
  target: {
    name: string;
    hp: number;
    max_hp: number;
    ac?: number;
    prof?: number;
    conditions: Array<{tag: string; severity: number}>;
  };
  recent_damage: Array<{when: string; amount: number; target: string}>;
  inventory: {
    equipped_weapons: CombatInventoryItem[];
    carried_weapons: CombatInventoryItem[];
    carried_tools: CombatInventoryItem[];
    unarmed_source: 'unarmed_strike';
  };
  environment: {
    location_name: string | null;
    location_summary: string | null;
    items_here: CombatEnvironmentItem[];
    active_surfaces: unknown[];
  };
  language_hint: string | null;
}

export interface CombatInventoryItem {
  slug: string;
  item_name: string;
  category: string;
  quantity: number;
  equipped: boolean;
  damage_die: string | null;
  damage_type: string | null;
}

export interface CombatEnvironmentItem {
  id: number;
  display_name: string;
  kind: string;
  summary: string | null;
  slug: string | null;
  category: string | null;
  count: number;
}
