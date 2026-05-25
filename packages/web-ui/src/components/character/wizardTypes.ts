// Shared character creation data types used by the unified creator,
// profile synthesis, and card review editor.

export interface Identity {
  pronouns?: string;
  gender_expression?: string;
  race?: string;
  anatomy?: string;
  attractions?: string;
  age?: number;
}
export interface Physical {
  build?: string;
  voice?: string;
  skin?: string;
  hair?: string;
  eyes?: string;
  distinguishing_marks?: string;
}
export interface Background {
  origin_paragraph?: string;
  motivation?: string;
  temperament?: string;
  notable_skills?: string[];
}
export interface Stats {
  STR: number;
  DEX: number;
  CON: number;
  INT: number;
  WIS: number;
  CHA: number;
}
export interface ClassRow {
  id: number;
  display_name: string;
  summary: string | null;
  profile: {
    skill_choices?: {from?: string[]; pick?: number};
  } | null;
}
export interface SkillMeta {
  name: string;
  ability: string;
  description: string;
}
export interface WizardState {
  identity: Identity;
  physical: Physical;
  background: Background;
  starting_class_id: number | null;
  stats: Stats | null;
  stat_method: 'standard_array' | 'point_buy' | 'rolled';
  skills: string[];
}
