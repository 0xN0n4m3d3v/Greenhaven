/**
 * Focused tests for the OWV-17 materializer runtime bridge.
 *
 *   • `loadProject` parses the optional `audit/materializes.jsonl`
 *     into `LoadedProject.bridge.materializers`, mints stable per-row
 *     `materializer_id`s, and tolerates a missing artifact;
 *   • `exportGrinhavenSql` emits a deterministic
 *     `forge_materializer_bridge` `cartridge_meta` row sorted by
 *     `(source_slug, type, entity_slug, scope, materializer_id)`,
 *     namespaced by the `project_slug`, and does not touch
 *     production keys;
 *   • projects without the artifact still export normally — no
 *     `forge_materializer_bridge` meta is written.
 */

import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  initProject,
  loadProject,
  materializerEntryId,
} from '../src/core/projectStore.js';
import {exportGrinhavenSql} from '../src/exporters/exportGrinhavenSql.js';

async function seedProject(label: string): Promise<{slug: string; root: string}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `forge-materializer-${label}-`),
  );
  process.env.CARTRIDGE_FORGE_PROJECTS = root;
  const slug = `materializer-${label}`;
  await initProject(slug);
  return {slug, root};
}

async function writeMaterializerArtifact(
  projectRoot: string,
  rows: object[],
): Promise<void> {
  const auditDir = path.join(projectRoot, 'audit');
  await mkdir(auditDir, {recursive: true});
  await writeFile(
    path.join(auditDir, 'materializes.jsonl'),
    rows.map(row => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
}

function liveRows() {
  return [
    {
      effect: 'open hatch under barrels and new path down.',
      entity: "@Thief's market",
      entity_slug: 'thiefs-market',
      scope: '@Town square',
      source_kind: 'quest',
      source_mention: "@Way to Thief's market",
      source_path: 'x.md',
      source_slug: 'way-to-thiefs-market',
      target_status: 'existing',
      type: 'location/hidden-exit',
    },
    {
      effect: 'hero has paid shelter for one night.',
      entity: "@Back room under Thief's market",
      entity_slug: 'back-room-under-thiefs-market',
      scope: "inside @Thief's market",
      source_kind: 'person',
      source_mention: '@Sable Vey',
      source_path: 'y.md',
      source_slug: 'sable-vey',
      target_status: 'new',
      type: 'location/shelter',
    },
    {
      effect: 'hero may trade in market until end of day.',
      entity: '@Quiet trading token',
      entity_slug: 'quiet-trading-token',
      scope: "hero inventory and @Thief's market",
      source_kind: 'person',
      source_mention: '@Sable Vey',
      source_path: 'z.md',
      source_slug: 'sable-vey',
      target_status: 'new',
      type: 'item/access-state',
    },
  ];
}

describe('OWV-17 materializer bridge', () => {
  it('loadProject populates bridge.materializers when the artifact exists', async () => {
    const {slug} = await seedProject('load-present');
    const loaded = await loadProject(slug);
    await writeMaterializerArtifact(loaded.root, liveRows());
    const reloaded = await loadProject(slug);
    expect(reloaded.bridge.materializers).toBeDefined();
    expect(reloaded.bridge.materializers?.schema_version).toBe(
      'greenhaven.materializers.v1',
    );
    const rows = reloaded.bridge.materializers?.rows ?? [];
    expect(rows).toHaveLength(3);
    const hiddenExit = rows.find(r => r.type === 'location/hidden-exit')!;
    expect(hiddenExit.materializer_id).toBe(
      materializerEntryId(
        'way-to-thiefs-market',
        'thiefs-market',
        'location/hidden-exit',
        '@Town square',
        'open hatch under barrels and new path down.',
      ),
    );
    // Sorted: sable-vey rows come before way-to-thiefs-market; within
    // sable-vey, item/access-state precedes location/shelter
    // lexicographically.
    expect(rows[0]!.source_slug).toBe('sable-vey');
    expect(rows[0]!.type).toBe('item/access-state');
    expect(rows[1]!.source_slug).toBe('sable-vey');
    expect(rows[1]!.type).toBe('location/shelter');
    expect(rows[2]!.source_slug).toBe('way-to-thiefs-market');
  });

  it('loadProject tolerates a missing artifact without crashing', async () => {
    const {slug} = await seedProject('load-missing');
    const loaded = await loadProject(slug);
    expect(loaded.bridge.materializers).toBeUndefined();
  });

  it('exportGrinhavenSql writes the forge_materializer_bridge meta row', async () => {
    const {slug, root} = await seedProject('sql');
    const seeded = await loadProject(slug);
    await writeMaterializerArtifact(seeded.root, liveRows());
    const reloaded = await loadProject(slug);
    const out = path.join(root, 'materializers.sql');
    const report = await exportGrinhavenSql(reloaded, out);
    expect(report.materializerEntries).toBe(3);
    const text = await readFile(out, 'utf8');
    expect(text).toContain("'forge_materializer_bridge'");
    expect(text).toContain('OWV-17 materializer bridge');
    expect(text).toContain('"schema_version":"greenhaven.materializers.v1"');
    expect(text).toContain(`"source_project":"${slug}"`);
    expect(text).toContain('"source_slug":"sable-vey"');
    expect(text).toContain('"type":"location/hidden-exit"');
    expect(text).toContain('"entity_slug":"thiefs-market"');
    // Production keys must NOT be touched.
    expect(text).not.toContain("'starting_location_id'\n");
    expect(text).not.toContain("'world_clock'");
  });

  it('exportGrinhavenSql is a no-op when the materializer artifact is absent', async () => {
    const {slug, root} = await seedProject('sql-empty');
    const loaded = await loadProject(slug);
    const out = path.join(root, 'no-materializers.sql');
    const report = await exportGrinhavenSql(loaded, out);
    expect(report.materializerEntries).toBe(0);
    const text = await readFile(out, 'utf8');
    expect(text).not.toContain('forge_materializer_bridge');
  });

  it('exportGrinhavenSql produces deterministic materializer SQL across re-runs', async () => {
    const {slug, root} = await seedProject('sql-stable');
    const seeded = await loadProject(slug);
    await writeMaterializerArtifact(seeded.root, liveRows());
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
