import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import type {IngestRecord, LoadedProject} from '../core/types.js';
import {agentPacksRoot} from '../core/paths.js';
import {writeJsonl} from '../core/jsonl.js';

const KIND_FILE: Record<string, string> = {
  activity: 'activities.jsonl',
  dialogue: 'dialogues.jsonl',
  event: 'events.jsonl',
  faction: 'factions.jsonl',
  item: 'items.jsonl',
  location: 'locations.jsonl',
  person: 'npcs.jsonl',
  quest: 'quests.jsonl',
  relationship: 'relationships.jsonl',
  scene: 'scenes.jsonl',
  world_fact: 'world-facts.jsonl',
};

export async function exportPack(loaded: LoadedProject, outRoot = agentPacksRoot()): Promise<string> {
  const packDir = path.join(outRoot, loaded.project.pack_slug);
  await mkdir(path.join(packDir, 'records'), {recursive: true});
  await mkdir(path.join(packDir, 'audit'), {recursive: true});
  await writeFile(
    path.join(packDir, 'manifest.json'),
    JSON.stringify(
      {
        schema_version: 'greenhaven.cartridge_ingest_pack.v1',
        pack_slug: loaded.project.pack_slug,
        mode: loaded.project.mode,
        target_cartridge_id: loaded.project.target_cartridge_id,
        source_language: loaded.project.source_language,
        created_by: {
          agent: 'cartridge-forge',
          model: loaded.project.provider.model,
          prompt_id: 'GH-CARTRIDGE-FORGE-MVP',
        },
        density_goal: loaded.project.density_goal,
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeJsonl(path.join(packDir, 'sources.jsonl'), loaded.sources);

  const byKind = groupByKind(loaded.records);
  for (const [kind, rows] of byKind) {
    await writeJsonl(path.join(packDir, 'records', KIND_FILE[kind] ?? `${kind}s.jsonl`), rows);
  }

  await writeFile(
    path.join(packDir, 'audit', 'agent-notes.md'),
    `# ${loaded.project.pack_slug}\n\nExported by Cartridge Forge.\n\nRecords: ${loaded.records.length}\nSources: ${loaded.sources.length}\n`,
    'utf8',
  );
  await writeJsonl(path.join(packDir, 'audit', 'dedupe-candidates.jsonl'), []);
  await writeJsonl(path.join(packDir, 'audit', 'rejected-ideas.jsonl'), []);
  return packDir;
}

function groupByKind(records: IngestRecord[]): Map<string, IngestRecord[]> {
  const out = new Map<string, IngestRecord[]>();
  for (const record of records) {
    const rows = out.get(record.kind) ?? [];
    rows.push(record);
    out.set(record.kind, rows);
  }
  return out;
}

