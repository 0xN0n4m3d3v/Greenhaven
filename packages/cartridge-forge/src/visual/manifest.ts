import path from 'node:path';
import {readFile, writeFile} from 'node:fs/promises';
import {
  manifestPath,
  normalizeSubjectKind,
  stickersDir,
  defaultAssetRole,
} from './packStore.js';
import type {VisualManifestRecord, VisualPack} from './types.js';

export async function rebuildManifest(root: string, pack: VisualPack): Promise<number> {
  const subjectKind = normalizeSubjectKind(pack.subject_kind);
  const assetRole = pack.asset_role ?? defaultAssetRole(subjectKind);
  const records: VisualManifestRecord[] = [];
  for (const [slug, meta] of Object.entries(pack.stickers)) {
    const file = `${slug}.png`;
    const assetPath = path.join(stickersDir(root, pack.name), file);
    records.push({
      slug,
      file,
      path: assetPath,
      character: pack.name,
      subject_kind: subjectKind,
      asset_role: assetRole,
      cartridge_slug: pack.cartridge_slug,
      entity_slug: pack.entity_slug,
      emotion: meta.emotion ?? '',
      pose: meta.pose ?? '',
      description: meta.description ?? '',
      tags: meta.tags ?? [],
      triggers: meta.triggers ?? [],
    });
  }
  const text = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(manifestPath(root, pack.name), text, 'utf8');
  return records.length;
}

export async function readManifest(root: string, name: string): Promise<VisualManifestRecord[]> {
  try {
    const text = await readFile(manifestPath(root, name), 'utf8');
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as VisualManifestRecord);
  } catch {
    return [];
  }
}
