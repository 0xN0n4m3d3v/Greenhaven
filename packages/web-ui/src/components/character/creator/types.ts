import type {Background, Identity, Physical, Stats} from '../wizardTypes';

export interface IdentityPlus extends Identity {
  name?: string;
}

export interface CharacterSheet {
  name: string;
  description: string;
  history: string;
  rawDescription?: string;
  rawHistory?: string;
}

export interface TranscriptEntry {
  q: string;
  qKey?: string;
  a: string;
}

export interface SynthesisResult {
  detected_language?: string;
  input_language?: string;
  identity?: IdentityPlus;
  physical?: Physical;
  background?: Background;
  starting_class_id?: number;
  class_pick_rationale?: string;
  stats?: Stats;
  stats_valid?: boolean;
  stats_spent?: number;
  stats_budget_rationale?: string;
  skills?: string[];
  skill_picks_rationale?: Record<string, string>;
}

export interface CharacterCardState {
  identity: IdentityPlus;
  physical: Physical;
  background: Background;
  starting_class_id: number | null;
  stats: Stats | null;
  skills: string[];
  class_pick_rationale?: string;
  skill_picks_rationale?: Record<string, string>;
}

export interface CharacterDraft {
  playerId: number;
  sheet: CharacterSheet;
  card: CharacterCardState;
  synthesized: boolean;
  classOverridden: boolean;
}

export const DEFAULT_CHARACTER_STATS: Stats = {
  STR: 13,
  DEX: 14,
  CON: 12,
  INT: 10,
  WIS: 15,
  CHA: 8,
};

export const EMPTY_CHARACTER_CARD: CharacterCardState = {
  identity: {},
  physical: {},
  background: {},
  starting_class_id: null,
  stats: null,
  skills: [],
};

export function createEmptyDraft(playerId: number): CharacterDraft {
  return {
    playerId,
    sheet: {
      name: '',
      description: '',
      history: '',
    },
    card: EMPTY_CHARACTER_CARD,
    synthesized: false,
    classOverridden: false,
  };
}
