export type VisualSubjectKind =
  | 'person'
  | 'location'
  | 'building'
  | 'scene'
  | 'item'
  | 'faction'
  | 'generic';

export type VisualAssetRole =
  | 'npc_sticker'
  | 'portrait'
  | 'location_view'
  | 'building_view'
  | 'scene_plate'
  | 'item_icon'
  | 'mood_stamp'
  | 'generic_sticker';

export interface VisualEntry {
  pose?: string;
  emotion?: string;
  description?: string;
  tags?: string[];
  triggers?: string[];
  prompt_extra?: string;
}

export interface VisualPack {
  name: string;
  subject_kind: VisualSubjectKind;
  asset_role: VisualAssetRole;
  cartridge_slug: string;
  entity_slug?: string;
  style: string;
  reference_prompt: string;
  decorate_prompt: string;
  output_size: number;
  stickers: Record<string, VisualEntry>;
}

export interface VisualManifestRecord {
  slug: string;
  file: string;
  path: string;
  character: string;
  subject_kind: VisualSubjectKind;
  asset_role: VisualAssetRole;
  cartridge_slug?: string;
  entity_slug?: string;
  emotion: string;
  pose: string;
  description: string;
  tags: string[];
  triggers: string[];
}

