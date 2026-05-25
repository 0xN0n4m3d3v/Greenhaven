import path from 'node:path';
import {readFileSync} from 'node:fs';
import {mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import YAML from 'yaml';
import type {
  VisualAssetRole,
  VisualEntry,
  VisualPack,
  VisualSubjectKind,
} from './types.js';
import {repoRoot} from '../core/paths.js';

export interface VisualPackSummary {
  name: string;
  sticker_count: number;
  has_reference: boolean;
  last_modified: string | null;
  subject_kind: VisualSubjectKind;
  asset_role: VisualAssetRole;
  entity_slug: string | null;
}

export function normalizeSubjectKind(value: unknown): VisualSubjectKind {
  const v = typeof value === 'string' ? value : 'person';
  if (
    v === 'person' ||
    v === 'location' ||
    v === 'building' ||
    v === 'scene' ||
    v === 'item' ||
    v === 'faction' ||
    v === 'generic'
  ) {
    return v;
  }
  return 'generic';
}

export function defaultAssetRole(kind: VisualSubjectKind): VisualAssetRole {
  switch (kind) {
    case 'person':
      return 'npc_sticker';
    case 'location':
      return 'location_view';
    case 'building':
      return 'building_view';
    case 'scene':
      return 'scene_plate';
    case 'item':
      return 'item_icon';
    case 'faction':
      return 'mood_stamp';
    default:
      return 'generic_sticker';
  }
}

export function normalizePack(input: Partial<VisualPack>): VisualPack {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('pack name is required');
  const subjectKind = normalizeSubjectKind(input.subject_kind);
  return {
    name,
    subject_kind: subjectKind,
    asset_role: input.asset_role ?? defaultAssetRole(subjectKind),
    cartridge_slug: input.cartridge_slug ?? 'grinhaven-full',
    entity_slug: input.entity_slug,
    style: input.style ?? defaultStyle(name, subjectKind),
    reference_prompt: input.reference_prompt ?? defaultReferencePrompt(subjectKind),
    decorate_prompt: input.decorate_prompt ?? '',
    output_size: input.output_size ?? 512,
    stickers: input.stickers ?? defaultStickers(subjectKind),
  };
}

export function packDir(root: string, name: string): string {
  return path.join(root, name);
}

export function yamlPath(root: string, name: string): string {
  return path.join(packDir(root, name), 'character.yaml');
}

export function referencePath(root: string, name: string): string {
  return path.join(packDir(root, name), 'reference.png');
}

export function rawDir(root: string, name: string): string {
  return path.join(packDir(root, name), 'raw');
}

export function stickersDir(root: string, name: string): string {
  return path.join(packDir(root, name), 'stickers');
}

export function manifestPath(root: string, name: string): string {
  return path.join(packDir(root, name), 'manifest.jsonl');
}

export async function listPacks(root: string): Promise<VisualPackSummary[]> {
  try {
    await mkdir(root, {recursive: true});
    const entries = await readdir(root, {withFileTypes: true});
    const out: VisualPackSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      try {
        const pack = await loadPack(root, name);
        const stickerFiles = await countPngs(stickersDir(root, name));
        const yamlStats = await stat(yamlPath(root, name)).catch(() => null);
        out.push({
          name,
          sticker_count: stickerFiles,
          has_reference: await isFile(referencePath(root, name)),
          last_modified: yamlStats?.mtimeMs ? String(Math.floor(yamlStats.mtimeMs)) : null,
          subject_kind: normalizeSubjectKind(pack.subject_kind),
          asset_role: pack.asset_role ?? defaultAssetRole(normalizeSubjectKind(pack.subject_kind)),
          entity_slug: pack.entity_slug ?? null,
        });
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function loadPack(root: string, name: string): Promise<VisualPack> {
  const file = yamlPath(root, name);
  const text = await readFile(file, 'utf8');
  const parsed = YAML.parse(text) as Partial<VisualPack> | null;
  return normalizePack({...(parsed ?? {}), name});
}

export async function savePack(root: string, pack: VisualPack): Promise<void> {
  const normalized = normalizePack(pack);
  const dir = packDir(root, normalized.name);
  await mkdir(dir, {recursive: true});
  await writeFile(yamlPath(root, normalized.name), YAML.stringify(normalized), 'utf8');
}

export async function createPack(
  root: string,
  name: string,
  subjectKind: VisualSubjectKind = 'person',
  options: {cartridgeSlug?: string; entitySlug?: string} = {},
): Promise<VisualPack> {
  if (await isFile(yamlPath(root, name))) {
    throw new Error(`pack '${name}' already exists`);
  }
  const pack = normalizePack({
    name,
    subject_kind: subjectKind,
    cartridge_slug: options.cartridgeSlug,
    entity_slug: options.entitySlug,
  });
  await savePack(root, pack);
  return pack;
}

export function defaultStickers(kind: VisualSubjectKind): Record<string, VisualEntry> {
  if (kind === 'person' || kind === 'generic') {
    try {
      const template = path.join(
        repoRoot,
        'ena-chat',
        'tools',
        'sticker-studio',
        'templates',
        'default_pack.yaml',
      );
      const parsed = YAML.parse(requireText(template)) as {
        stickers?: Record<string, VisualEntry>;
      };
      return parsed.stickers ?? {};
    } catch {
      return {};
    }
  }
  if (kind === 'location' || kind === 'building') {
    return {
      establishing_view: {
        pose: 'wide exterior or room establishing view',
        emotion: 'clear, inviting, readable',
        description: 'A clean view that lets the game master recognize the place.',
        tags: ['location', 'establishing'],
        triggers: ['first_seen', 'travel'],
      },
      detail_hook: {
        pose: 'close detail on the most playable object or doorway',
        emotion: 'intriguing',
        description: 'A visual clue players can turn into action.',
        tags: ['location', 'hook'],
        triggers: ['investigate', 'quest_hook'],
      },
    };
  }
  if (kind === 'scene') {
    return {
      scene_plate: {
        pose: 'cinematic scene composition',
        emotion: 'strong mood readable at thumbnail size',
        description: 'A scene plate showing participants, pressure, and mood.',
        tags: ['scene', 'mood'],
        triggers: ['scene_start'],
      },
    };
  }
  if (kind === 'item') {
    return {
      icon: {
        pose: 'single object icon centered',
        emotion: 'usable and recognizable',
        description: 'Inventory-ready icon with clean silhouette.',
        tags: ['item', 'icon'],
        triggers: ['inventory', 'loot'],
      },
    };
  }
  return {};
}

export function defaultStyle(name: string, kind: VisualSubjectKind): string {
  if (kind === 'person' || kind === 'generic') {
    return `${name} visual identity - must remain identical across every generated asset:
  * Describe build, age range, species, gender presentation.
  * Hair, eyes, skin/fur/marks, outfit, accessories, and silhouette.
  * No held props unless the specific sticker explicitly asks for one.
  * Style reference: anime cel-shaded, painterly hand-illustrated.`;
  }
  if (kind === 'location' || kind === 'building') {
    return `${name} place identity - must remain consistent:
  * Architecture, materials, signage, color palette, weathering, light sources.
  * Navigation affordances: doors, stairs, counters, exits, windows.
  * Playable hooks: objects, notices, shadows, crowds, traces of conflict.
  * Style reference: readable fantasy game background, painterly but practical.`;
  }
  if (kind === 'scene') {
    return `${name} scene identity - keep mood and staging consistent:
  * Main participants and their spatial relationship.
  * Scene pressure, emotional temperature, and visual focus.
  * No unreadable clutter; the player should understand where attention belongs.`;
  }
  if (kind === 'item') {
    return `${name} item identity - clean inventory silhouette:
  * Shape, material, damage/wear, scale hints, magical or civic marks.
  * Transparent or neutral background, no extra props unless required.`;
  }
  return `${name} visual identity.`;
}

export function defaultReferencePrompt(kind: VisualSubjectKind): string {
  if (kind === 'person' || kind === 'generic') {
    return 'Canonical reference art - full-body standing relaxed neutral pose, facing the viewer, hands visible and empty, square frame. This image defines the subject look for all future stickers.';
  }
  if (kind === 'location' || kind === 'building') {
    return 'Canonical place reference - clean establishing view, readable entrances and functional details, square frame. This image defines the architecture and palette for future variants.';
  }
  if (kind === 'scene') {
    return 'Canonical scene plate - readable composition with clear mood, participants, and focal point.';
  }
  if (kind === 'item') {
    return 'Canonical item reference - centered object, clean silhouette, readable material and scale.';
  }
  return 'Canonical visual reference.';
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null))?.isFile() ?? false;
}

async function countPngs(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, {withFileTypes: true});
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.png')).length;
  } catch {
    return 0;
  }
}

function requireText(file: string): string {
  return readFileSync(file, 'utf8');
}
