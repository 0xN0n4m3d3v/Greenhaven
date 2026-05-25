/**
 * Focused tests for the OWV-17 scene-instructions runtime bridge.
 *
 *   • `loadProject` parses `audit/scene-instructions.jsonl` into
 *     `LoadedProject.bridge.sceneInstructions` and tolerates a
 *     missing artifact;
 *   • `exportGrinhavenSql` emits a deterministic
 *     `forge_scene_instructions` `cartridge_meta` row sorted by
 *     `(location_slug, owner_npc_slug, scene_slug, source_path)`,
 *     namespaced by the `project_slug`, and does not touch
 *     production keys;
 *   • projects without the artifact still export normally — no
 *     `forge_scene_instructions` meta is written.
 */

import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {initProject, loadProject} from '../src/core/projectStore.js';
import {exportGrinhavenSql} from '../src/exporters/exportGrinhavenSql.js';

async function seedProject(label: string): Promise<{slug: string; root: string}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `forge-scene-instructions-${label}-`),
  );
  process.env.CARTRIDGE_FORGE_PROJECTS = root;
  const slug = `scene-instructions-${label}`;
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
    path.join(auditDir, 'scene-instructions.jsonl'),
    rows.map(row => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
}

function liveRows() {
  return [
    {
      schema_version: 'greenhaven.scene_instructions.v1',
      scene_slug: 'first-descent-into-thiefs-market',
      scene_mention: "@First descent into Thief's market",
      source_kind: 'scene',
      source_path: 'A.md',
      location_slug: 'thiefs-market',
      owner_npc_slug: null,
      participant_slugs: ['sable-vey', 'mikka'],
      trigger: 'Player enters market via the hatch.',
      priority: 'normal',
      hook: 'The hatch creaks underfoot.',
      beat_by_beat: '1. Descend.\n2. Sable names the price.',
      player_choices: '- Listen.\n- Threaten.\n- Ask for a sponsor.',
      memory_and_string_changes: '- @Sable Vey: +strings for listening.',
      success_result: 'The market admits the hero as a provisional guest.',
      failure_result: 'The lanterns turn red.',
      behavior: 'Market reacts to a stranger.',
      do_not: 'Do not let the market read like a shop on first entry.',
      voice: '',
      model_instructions: ['Make rules visible.', 'Watch for trouble.'],
      state_fields: [
        {
          key: 'first-descent-into-thiefs-market_seen',
          type: 'bool',
          default: false,
          scope: 'session',
          description: 'one-shot first-entry guard',
        },
      ],
      visual_asset: {path: 'images/first-descent.png', role: 'scene_plate'},
    },
    {
      schema_version: 'greenhaven.scene_instructions.v1',
      scene_slug: 'mikka-close-combat-dagger',
      scene_mention: '@Mikka close combat dagger',
      source_kind: 'scene',
      source_path: 'B.md',
      location_slug: 'town-square',
      owner_npc_slug: 'mikka',
      participant_slugs: ['mikka'],
      trigger: 'Enemy grapples @Mikka in melee.',
      priority: 'high',
      behavior: 'Strike at hands, hips, hamstrings.',
      do_not: 'Do not turn this into a long duel.',
      voice: '"Closer was not the right call."',
      model_instructions: ['Open windows fast.', 'Disengage when possible.'],
      state_fields: [],
      visual_asset: null,
    },
  ];
}

describe('OWV-17 scene-instructions bridge', () => {
  it('loadProject populates bridge.sceneInstructions when the artifact exists', async () => {
    const {slug} = await seedProject('load-present');
    const loaded = await loadProject(slug);
    await writeArtifact(loaded.root, liveRows());
    const reloaded = await loadProject(slug);
    expect(reloaded.bridge.sceneInstructions).toBeDefined();
    expect(reloaded.bridge.sceneInstructions?.schema_version).toBe(
      'greenhaven.scene_instructions.v1',
    );
    const rows = reloaded.bridge.sceneInstructions?.rows ?? [];
    expect(rows).toHaveLength(2);
    // Sort: thiefs-market (location) before town-square; within town-square,
    // owner_npc_slug 'mikka' ahead.
    expect(rows[0]!.scene_slug).toBe('first-descent-into-thiefs-market');
    expect(rows[1]!.scene_slug).toBe('mikka-close-combat-dagger');
    expect(rows[1]!.owner_npc_slug).toBe('mikka');
    expect(rows[0]!.participant_slugs).toEqual(['sable-vey', 'mikka']);
    expect(rows[0]!.player_choices).toContain('Ask for a sponsor');
    expect(rows[0]!.memory_and_string_changes).toContain('+strings');
  });

  it('loadProject tolerates a missing artifact without crashing', async () => {
    const {slug} = await seedProject('load-missing');
    const loaded = await loadProject(slug);
    expect(loaded.bridge.sceneInstructions).toBeUndefined();
  });

  it('exportGrinhavenSql writes the forge_scene_instructions meta row', async () => {
    const {slug, root} = await seedProject('sql');
    const seeded = await loadProject(slug);
    await writeArtifact(seeded.root, liveRows());
    const reloaded = await loadProject(slug);
    const out = path.join(root, 'scene-instructions.sql');
    const report = await exportGrinhavenSql(reloaded, out);
    expect(report.sceneInstructions).toBe(2);
    const text = await readFile(out, 'utf8');
    expect(text).toContain("'forge_scene_instructions'");
    expect(text).toContain('OWV-17 scene-instructions bridge');
    expect(text).toContain('"schema_version":"greenhaven.scene_instructions.v1"');
    expect(text).toContain(`"source_project":"${slug}"`);
    expect(text).toContain('"location_slug":"thiefs-market"');
    expect(text).toContain('"owner_npc_slug":"mikka"');
    expect(text).toContain('"scene_slug":"mikka-close-combat-dagger"');
    // Production keys must NOT be touched.
    expect(text).not.toContain("'starting_location_id'\n");
    expect(text).not.toContain("'world_clock'");
  });

  it('exportGrinhavenSql is a no-op when the scene-instructions artifact is absent', async () => {
    const {slug, root} = await seedProject('sql-empty');
    const loaded = await loadProject(slug);
    const out = path.join(root, 'no-scene-instructions.sql');
    const report = await exportGrinhavenSql(loaded, out);
    expect(report.sceneInstructions).toBe(0);
    const text = await readFile(out, 'utf8');
    expect(text).not.toContain('forge_scene_instructions');
  });

  it('exportGrinhavenSql produces deterministic scene-instructions SQL across re-runs', async () => {
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
