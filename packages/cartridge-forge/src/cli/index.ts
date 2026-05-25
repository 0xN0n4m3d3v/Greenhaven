import {readFile} from 'node:fs/promises';
import {
  addRecord,
  addSource,
  initProject,
  listProjects,
  loadProject,
  makeRecord,
  upsertRecord,
} from '../core/projectStore.js';
import type {EntityKind, IngestRecord, SourceRecord} from '../core/types.js';
import {validateProject} from '../validators/validateProject.js';
import {exportPack} from '../exporters/exportPack.js';
import {exportValidatedGrinhavenSql} from '../exporters/exportGrinhavenSqlValidated.js';
import {importGrinhavenMigration} from '../importers/grinhavenMigration.js';
import {deepseekFillRecord} from '../providers/deepseek.js';
import {readJsonl} from '../core/jsonl.js';
import {defaultPayload} from '../core/defaults.js';
import {repairReadableSummaries} from '../core/recordRepair.js';

const [, , command, ...args] = process.argv;

try {
  await main(command ?? 'help', args);
} catch (error) {
  console.error(JSON.stringify({ok: false, error: message(error)}, null, 2));
  process.exitCode = 1;
}

async function main(cmd: string, args: string[]) {
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      return help();
    case 'init':
      return print(await initProject(required(args[0], 'project-slug')));
    case 'list':
      return print(await listProjects());
    case 'import-grinhaven-current': {
      const report = await importGrinhavenMigration({
        projectSlug: required(args[0], 'project-slug'),
        migrationPath: args[1],
      });
      return print(report);
    }
    case 'repair-readable-summaries': {
      return print(await repairReadableSummaries(required(args[0], 'project')));
    }
    case 'add-source': {
      const loaded = await loadProject(required(args[0], 'project'));
      const source = JSON.parse(await readFile(required(args[1], 'source-json'), 'utf8')) as SourceRecord;
      await addSource(loaded.root, source);
      return print({ok: true});
    }
    case 'add-record': {
      const loaded = await loadProject(required(args[0], 'project'));
      const kind = required(args[1], 'kind') as EntityKind;
      const slug = required(args[2], 'slug');
      const name = required(args[3], 'canonical-name');
      const summary = args.slice(4).join(' ') || `${name}.`;
      const record = makeRecord({
        kind,
        slug,
        name,
        summary,
        sourceLanguage: loaded.project.source_language,
        payload: defaultPayload(kind, slug),
        tags: [kind, 'forge-draft'],
      });
      await addRecord(loaded.root, record);
      return print({ok: true, record});
    }
    case 'add-record-json': {
      const loaded = await loadProject(required(args[0], 'project'));
      const record = JSON.parse(await readFile(required(args[1], 'record-json'), 'utf8')) as IngestRecord;
      await addRecord(loaded.root, record);
      return print({ok: true});
    }
    case 'validate': {
      const loaded = await loadProject(required(args[0], 'project'));
      const issues = await validateProject(loaded);
      const ok = issues.every(issue => issue.level !== 'error');
      print({
        ok,
        errors: issues.filter(issue => issue.level === 'error'),
        warnings: issues.filter(issue => issue.level === 'warning'),
        counts: {sources: loaded.sources.length, records: loaded.records.length},
      });
      if (!ok) process.exitCode = 1;
      return;
    }
    case 'ai-fill': {
      const loaded = await loadProject(required(args[0], 'project'));
      const slug = required(args[1], 'record-slug');
      const record = loaded.records.find(row => row.slug === slug || row.record_id === slug);
      if (!record) throw new Error(`record not found: ${slug}`);
      const filled = await deepseekFillRecord(loaded, record);
      await upsertRecord(loaded.root, filled);
      return print({ok: true, record: filled});
    }
    case 'attach-visuals': {
      const loaded = await loadProject(required(args[0], 'project'));
      const manifestPath = required(args[1], 'sticker-manifest-jsonl');
      const visualRows = await readJsonl<{
        slug: string;
        file: string;
        path: string;
        character: string;
        subject_kind?: string;
        asset_role?: string;
        cartridge_slug?: string;
        entity_slug?: string;
        tags?: string[];
        triggers?: string[];
      }>(manifestPath);
      let attached = 0;
      const bySlug = new Map(loaded.records.map(record => [record.slug, record]));
      for (const visual of visualRows) {
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
        await upsertRecord(loaded.root, record);
        attached += 1;
      }
      return print({ok: true, attached});
    }
    case 'export-pack': {
      const loaded = await loadProject(required(args[0], 'project'));
      const issues = await validateProject(loaded);
      const errors = issues.filter(issue => issue.level === 'error');
      if (errors.length > 0) return print({ok: false, errors});
      const out = await exportPack(loaded);
      return print({ok: true, path: out});
    }
    case 'export-grinhaven-sql': {
      const force = args.includes('--force');
      const positional = args.filter(arg => arg !== '--force');
      const loaded = await loadProject(required(positional[0], 'project'));
      const report = await exportValidatedGrinhavenSql(loaded, positional[1], {force});
      if (!report.ok) process.exitCode = 1;
      return print(report);
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function help() {
  console.log(`Cartridge Forge CLI

Commands:
  init <project-slug>
  list
  add-source <project> <source-json>
  add-record <project> <kind> <slug> <name> [summary...]
  add-record-json <project> <record-json>
  import-grinhaven-current <project-slug> [migration-sql]
  repair-readable-summaries <project>
  ai-fill <project> <record-slug>
  attach-visuals <project> <sticker-manifest-jsonl>
  validate <project>
  export-pack <project>
  export-grinhaven-sql <project> [out-sql] [--force]
`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
