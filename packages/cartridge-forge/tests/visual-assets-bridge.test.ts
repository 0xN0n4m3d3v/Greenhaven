/**
 * Focused tests for the OWV-17 visual-assets runtime bridge.
 *
 *   • `loadProject` parses `audit/visual-assets.jsonl` into
 *     `LoadedProject.bridge.visualAssets` and tolerates a missing
 *     artifact;
 *   • `exportGrinhavenSql` emits a deterministic
 *     `forge_visual_assets` `cartridge_meta` row sorted by
 *     `(kind, slug, role, path)`, namespaced by the
 *     `project_slug`, and does not touch production keys;
 *   • projects without the artifact still export normally — no
 *     `forge_visual_assets` meta is written.
 */

import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {initProject, loadProject} from '../src/core/projectStore.js';
import {exportGrinhavenSql} from '../src/exporters/exportGrinhavenSql.js';

async function seedProject(label: string): Promise<{slug: string; root: string}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `forge-visual-assets-${label}-`),
  );
  process.env.CARTRIDGE_FORGE_PROJECTS = root;
  const slug = `visual-assets-${label}`;
  await initProject(slug);
  return {slug, root};
}

async function writeArtifact(
  projectRoot: string,
  rows: object[],
): Promise<void> {
  const auditDir = path.join(projectRoot, 'audit');
  await mkdir(auditDir, {recursive: true});
  await writeFile(
    path.join(auditDir, 'visual-assets.jsonl'),
    rows.map(row => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
}

function liveRows() {
  return [
    {
      kind: 'item',
      mention: '@Copper coin',
      path: 'GreenHavenWorld/Economy/items/@Copper coin/images/icon.png',
      role: 'item_icon',
      slug: 'copper-coin',
      source_path: 'GreenHavenWorld/Economy/items/@Copper coin/CopperCoinMind.md',
    },
    {
      kind: 'person',
      mention: '@Mikka',
      path: 'GreenHavenWorld/Locations/.../images/portrait.png',
      role: 'portrait',
      slug: 'mikka',
      source_path: 'x.md',
    },
    {
      kind: 'scene',
      mention: '@First descent',
      path: 'GreenHavenWorld/.../images/first-descent.png',
      role: 'scene_plate',
      slug: 'first-descent-into-thiefs-market',
      source_path: 'y.md',
    },
  ];
}

describe('OWV-17 visual-assets bridge', () => {
  it('loadProject populates bridge.visualAssets when the artifact exists', async () => {
    const {slug} = await seedProject('load-present');
    const loaded = await loadProject(slug);
    await writeArtifact(loaded.root, liveRows());
    const reloaded = await loadProject(slug);
    expect(reloaded.bridge.visualAssets).toBeDefined();
    expect(reloaded.bridge.visualAssets?.schema_version).toBe(
      'greenhaven.visual_assets.v1',
    );
    const rows = reloaded.bridge.visualAssets?.rows ?? [];
    expect(rows).toHaveLength(3);
    // Sorted by kind first: item < person < scene.
    expect(rows.map(r => r.kind)).toEqual(['item', 'person', 'scene']);
    expect(rows[0]!.slug).toBe('copper-coin');
    expect(rows[0]!.role).toBe('item_icon');
  });

  it('loadProject tolerates a missing artifact without crashing', async () => {
    const {slug} = await seedProject('load-missing');
    const loaded = await loadProject(slug);
    expect(loaded.bridge.visualAssets).toBeUndefined();
  });

  it('exportGrinhavenSql writes the forge_visual_assets meta row', async () => {
    const {slug, root} = await seedProject('sql');
    const seeded = await loadProject(slug);
    await writeArtifact(seeded.root, liveRows());
    const reloaded = await loadProject(slug);
    const out = path.join(root, 'visual-assets.sql');
    const report = await exportGrinhavenSql(reloaded, out);
    expect(report.visualAssets).toBe(3);
    const text = await readFile(out, 'utf8');
    expect(text).toContain("'forge_visual_assets'");
    expect(text).toContain('OWV-17 visual-assets bridge');
    expect(text).toContain('"schema_version":"greenhaven.visual_assets.v1"');
    expect(text).toContain(`"source_project":"${slug}"`);
    expect(text).toContain('"kind":"item"');
    expect(text).toContain('"role":"portrait"');
    expect(text).toContain('"slug":"copper-coin"');
    // Production keys must NOT be touched.
    expect(text).not.toContain("'starting_location_id'\n");
    expect(text).not.toContain("'world_clock'");
  });

  it('exportGrinhavenSql is a no-op when the visual-assets artifact is absent', async () => {
    const {slug, root} = await seedProject('sql-empty');
    const loaded = await loadProject(slug);
    const out = path.join(root, 'no-visual-assets.sql');
    const report = await exportGrinhavenSql(loaded, out);
    expect(report.visualAssets).toBe(0);
    const text = await readFile(out, 'utf8');
    expect(text).not.toContain('forge_visual_assets');
  });

  it('exportGrinhavenSql produces deterministic visual-assets SQL across re-runs', async () => {
    const {slug, root} = await seedProject('sql-stable');
    const seeded = await loadProject(slug);
    await writeArtifact(seeded.root, liveRows());
    const reloaded = await loadProject(slug);
    const first = path.join(root, 'first.sql');
    const second = path.join(root, 'second.sql');
    await exportGrinhavenSql(reloaded, first);
    await exportGrinhavenSql(reloaded, second);
    const strip = (text: string) =>
      text
        .split('\n')
        .filter(line => !line.includes("'forge_last_sql_export'"))
        .filter(line => !line.includes('"exported_at"'))
        .join('\n');
    const a = strip(await readFile(first, 'utf8'));
    const b = strip(await readFile(second, 'utf8'));
    expect(a).toBe(b);
  });
});
