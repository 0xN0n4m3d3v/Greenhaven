import {upsertRecord} from '../core/projectStore.js';
import type {IngestRecord} from '../core/types.js';

export async function attachVisualManifest(
  root: string,
  records: IngestRecord[],
  manifest: Array<{
    slug: string;
    file: string;
    path: string;
    character: string;
    subject_kind?: string;
    asset_role?: string;
    entity_slug?: string;
    tags?: string[];
    triggers?: string[];
  }>,
): Promise<number> {
  let attached = 0;
  const bySlug = new Map(records.map(record => [record.slug, record]));
  for (const visual of manifest) {
    if (!visual.entity_slug) continue;
    const record = bySlug.get(visual.entity_slug);
    if (!record) continue;
    const assets = Array.isArray(record.payload.visual_assets)
      ? record.payload.visual_assets
      : [];
    record.payload.visual_assets = [
      ...assets.filter(
        asset =>
          !(
            typeof asset === 'object' &&
            asset &&
            'pack_name' in asset &&
            'asset_slug' in asset &&
            (asset as {pack_name?: unknown}).pack_name === visual.character &&
            (asset as {asset_slug?: unknown}).asset_slug === visual.slug
          ),
      ),
      {
        pack_name: visual.character,
        asset_slug: visual.slug,
        asset_role: visual.asset_role ?? 'generic_sticker',
        subject_kind: visual.subject_kind ?? 'generic',
        file: visual.file,
        path: visual.path,
        tags: visual.tags ?? [],
        triggers: visual.triggers ?? [],
      },
    ];
    await upsertRecord(root, record);
    attached += 1;
  }
  return attached;
}
