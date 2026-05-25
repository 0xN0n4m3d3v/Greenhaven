import path from 'node:path';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {Hono} from 'hono';
import type {Context} from 'hono';
import {
  addSource,
  initProject,
  listProjects,
  loadProject,
  makeRecord,
  replaceRecord,
  upsertRecord,
} from '../core/projectStore.js';
import type {EntityKind, IngestRecord, SourceRecord} from '../core/types.js';
import {packageRoot} from '../core/paths.js';
import {deepseekFillRecord} from '../providers/deepseek.js';
import {exportPack} from '../exporters/exportPack.js';
import {exportValidatedGrinhavenSql} from '../exporters/exportGrinhavenSqlValidated.js';
import {importGrinhavenMigration} from '../importers/grinhavenMigration.js';
import {validateProject} from '../validators/validateProject.js';
import {
  ensureDefaultWorkflow,
  listExecutions,
  listWorkflows,
  loadWorkflow,
  readExecutionLog,
  saveWorkflow,
} from '../core/workflowStore.js';
import {runWorkflow} from '../core/workflowRunner.js';
import {buildEntityGraph, locationTree} from '../core/entityGraph.js';
import {draftQuestFromAnchor, linkGeneratedQuest} from '../core/questFactory.js';
import {defaultPayloadForProject} from '../core/defaults.js';
import {
  createPack,
  listPacks,
  loadPack,
  packDir,
  referencePath,
  savePack,
} from '../visual/packStore.js';
import {readManifest, rebuildManifest} from '../visual/manifest.js';
import type {VisualPack, VisualSubjectKind} from '../visual/types.js';
import {attachVisualManifest} from '../visual/attach.js';

const publicRoot = path.join(packageRoot, 'public');
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createApp(): Hono {
  const app = new Hono();

  app.onError((error, c) =>
    c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    ),
  );

  app.get('/api/health', c =>
    c.json({
      ok: true,
      service: 'cartridge-forge',
      time: new Date().toISOString(),
    }),
  );

  app.get('/api/projects', async c => {
    const projects = await Promise.all(
      (await listProjects()).map(async slug => {
        const loaded = await loadProject(slug);
        await ensureDefaultWorkflow(loaded.root);
        return {
          slug,
          project: loaded.project,
          counts: {
            sources: loaded.sources.length,
            records: loaded.records.length,
            visuals: (await listPacks(visualRoot(loaded.root))).length,
            workflows: (await listWorkflows(loaded.root)).length,
            executions: (await listExecutions(loaded.root)).length,
          },
        };
      }),
    );
    return c.json({ok: true, projects});
  });

  app.post('/api/projects', async c => {
    const body = await c.req.json<{slug?: string}>();
    const slug = requireSlug(body.slug, 'project slug');
    const project = await initProject(slug);
    const loaded = await loadProject(slug);
    await ensureDefaultWorkflow(loaded.root);
    return c.json({ok: true, project});
  });

  app.post('/api/projects/import-grinhaven-current', async c => {
    const body = (await c.req.json<{slug?: string; migrationPath?: string}>().catch(() => ({}))) as {
      slug?: string;
      migrationPath?: string;
    };
    const report = await importGrinhavenMigration({
      projectSlug: requireSlug(body.slug ?? 'grinhaven-full-current', 'project slug'),
      migrationPath: body.migrationPath,
    });
    return c.json(report);
  });

  app.get('/api/projects/:slug', async c => {
    const loaded = await loadByParam(c);
    await ensureDefaultWorkflow(loaded.root);
    return c.json({
      ok: true,
      project: loaded.project,
      sources: loaded.sources,
      records: loaded.records,
      visuals: await listPacks(visualRoot(loaded.root)),
      workflows: await listWorkflows(loaded.root),
      executions: await listExecutions(loaded.root),
    });
  });

  app.get('/api/projects/:slug/sources', async c => {
    const loaded = await loadByParam(c);
    return c.json({ok: true, sources: loaded.sources});
  });

  app.post('/api/projects/:slug/sources', async c => {
    const loaded = await loadByParam(c);
    const body = await c.req.json<Partial<SourceRecord>>();
    const source: SourceRecord = {
      source_id: String(body.source_id ?? '').trim(),
      url: body.url?.trim() || undefined,
      title: String(body.title ?? '').trim(),
      publisher: body.publisher?.trim() || undefined,
      retrieved_at: body.retrieved_at?.trim() || new Date().toISOString().slice(0, 10),
      license: String(body.license ?? 'internal').trim(),
      robots_status: body.robots_status ?? 'internal',
      notes: String(body.notes ?? '').trim(),
    };
    requireSource(source);
    await addSource(loaded.root, source);
    return c.json({ok: true, source});
  });

  app.get('/api/projects/:slug/records', async c => {
    const loaded = await loadByParam(c);
    return c.json({ok: true, records: loaded.records});
  });

  app.post('/api/projects/:slug/records', async c => {
    const loaded = await loadByParam(c);
    const body = await c.req.json<{
      kind?: EntityKind;
      slug?: string;
      name?: string;
      summary?: string;
      tags?: string[];
      payload?: Record<string, unknown>;
    }>();
    const kind = requireKind(body.kind);
    const recordSlug = requireSlug(body.slug, 'record slug');
    const record = makeRecord({
      kind,
      slug: recordSlug,
      name: body.name?.trim() || titleFromSlug(recordSlug),
      summary: body.summary?.trim() || `${titleFromSlug(recordSlug)}.`,
      tags: body.tags?.length ? body.tags : [kind, 'forge-draft'],
      payload: body.payload ?? defaultPayloadForProject(kind, recordSlug, loaded.records),
      sourceLanguage: loaded.project.source_language,
    });
    await upsertRecord(loaded.root, record);
    return c.json({ok: true, record});
  });

  app.put('/api/projects/:slug/records/:recordSlug', async c => {
    const loaded = await loadByParam(c);
    const recordSlug = c.req.param('recordSlug');
    const body = await c.req.json<IngestRecord>();
    const previous = loaded.records.find(row => row.slug === recordSlug);
    const record = normalizeRecord(body, previous);
    await replaceRecord(loaded.root, previous, record);
    return c.json({ok: true, record});
  });

  app.post('/api/projects/:slug/records/:recordSlug/link', async c => {
    const loaded = await loadByParam(c);
    const recordSlug = c.req.param('recordSlug');
    const record = loaded.records.find(row => row.slug === recordSlug);
    if (!record) throw new Error(`record not found: ${recordSlug}`);
    const body = await c.req.json<{rel?: string; target?: string; note?: string}>();
    const rel = String(body.rel ?? '').trim();
    const target = String(body.target ?? '').trim();
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(rel)) throw new Error('rel is invalid');
    if (!target) throw new Error('target is required');
    const links = record.links ?? [];
    if (!links.some(link => link.rel === rel && link.target === target)) {
      record.links = [...links, {rel, target, note: body.note?.trim() || undefined}];
      await upsertRecord(loaded.root, record);
    }
    return c.json({ok: true, record});
  });

  app.delete('/api/projects/:slug/records/:recordSlug/link', async c => {
    const loaded = await loadByParam(c);
    const recordSlug = c.req.param('recordSlug');
    const record = loaded.records.find(row => row.slug === recordSlug);
    if (!record) throw new Error(`record not found: ${recordSlug}`);
    const body = (await c.req.json<{rel?: string; target?: string}>().catch(() => ({}))) as {
      rel?: string;
      target?: string;
    };
    const rel = String(body.rel ?? '').trim();
    const target = String(body.target ?? '').trim();
    if (!rel || !target) throw new Error('rel and target are required');
    const links = record.links ?? [];
    const next = links.filter(link => !(link.rel === rel && link.target === target));
    record.links = next;
    await upsertRecord(loaded.root, record);
    return c.json({ok: true, removed: links.length - next.length, record});
  });

  app.post('/api/projects/:slug/records/:recordSlug/create-quest', async c => {
    const loaded = await loadByParam(c);
    const recordSlug = c.req.param('recordSlug');
    const anchor = loaded.records.find(row => row.slug === recordSlug);
    if (!anchor) throw new Error(`record not found: ${recordSlug}`);
    if (anchor.kind === 'quest') throw new Error('quest records cannot create another quest');
    const quest = draftQuestFromAnchor(loaded, anchor);
    const linkedAnchor = linkGeneratedQuest(anchor, quest);
    await upsertRecord(loaded.root, quest);
    await upsertRecord(loaded.root, linkedAnchor);
    return c.json({ok: true, quest, anchor: linkedAnchor});
  });

  app.post('/api/projects/:slug/records/:recordSlug/ai-fill', async c => {
    const loaded = await loadByParam(c);
    const record = loaded.records.find(row => row.slug === c.req.param('recordSlug'));
    if (!record) throw new Error(`record not found: ${c.req.param('recordSlug')}`);
    const filled = await deepseekFillRecord(loaded, record);
    await upsertRecord(loaded.root, filled);
    return c.json({ok: true, record: filled});
  });

  app.post('/api/projects/:slug/validate', async c => {
    const loaded = await loadByParam(c);
    const issues = await validateProject(loaded);
    return c.json({
      ok: issues.every(issue => issue.level !== 'error'),
      errors: issues.filter(issue => issue.level === 'error'),
      warnings: issues.filter(issue => issue.level === 'warning'),
      counts: {sources: loaded.sources.length, records: loaded.records.length},
    });
  });

  app.post('/api/projects/:slug/export', async c => {
    const loaded = await loadByParam(c);
    const issues = await validateProject(loaded);
    const errors = issues.filter(issue => issue.level === 'error');
    if (errors.length > 0) return c.json({ok: false, errors}, 400);
    const out = await exportPack(loaded);
    return c.json({ok: true, path: out});
  });

  app.post('/api/projects/:slug/export-grinhaven-sql', async c => {
    const loaded = await loadByParam(c);
    const body = (await c.req.json<{outFile?: string; force?: boolean}>().catch(() => ({}))) as {
      outFile?: string;
      force?: boolean;
    };
    const report = await exportValidatedGrinhavenSql(loaded, body.outFile, {force: body.force});
    if (!report.ok) return c.json(report, 400);
    return c.json(report);
  });

  app.get('/api/projects/:slug/workflows', async c => {
    const loaded = await loadByParam(c);
    return c.json({ok: true, workflows: await listWorkflows(loaded.root)});
  });

  app.get('/api/projects/:slug/workflows/:workflowSlug', async c => {
    const loaded = await loadByParam(c);
    return c.json({
      ok: true,
      workflow: await loadWorkflow(loaded.root, c.req.param('workflowSlug')),
    });
  });

  app.put('/api/projects/:slug/workflows/:workflowSlug', async c => {
    const loaded = await loadByParam(c);
    const body = await c.req.json();
    const workflow = {...body, workflow_slug: c.req.param('workflowSlug')};
    await saveWorkflow(loaded.root, workflow);
    return c.json({ok: true, workflow});
  });

  app.post('/api/projects/:slug/workflows/:workflowSlug/run', async c => {
    const loaded = await loadByParam(c);
    const workflow = await loadWorkflow(loaded.root, c.req.param('workflowSlug'));
    const result = await runWorkflow(loaded.root, workflow);
    return c.json({ok: true, succeeded: result.execution.status === 'success', ...result});
  });

  app.get('/api/projects/:slug/executions', async c => {
    const loaded = await loadByParam(c);
    return c.json({ok: true, executions: await listExecutions(loaded.root)});
  });

  app.get('/api/projects/:slug/executions/:executionId', async c => {
    const loaded = await loadByParam(c);
    const logs = await readExecutionLog(loaded.root, c.req.param('executionId'));
    return c.json({ok: true, execution: logs.length > 0 ? logs[0].execution_id : null, logs});
  });

  app.get('/api/projects/:slug/visuals', async c => {
    const loaded = await loadByParam(c);
    return c.json({ok: true, visuals: await listPacks(visualRoot(loaded.root))});
  });

  app.post('/api/projects/:slug/visuals', async c => {
    const loaded = await loadByParam(c);
    const body = await c.req.json<{
      name?: string;
      subjectKind?: VisualSubjectKind;
      entitySlug?: string;
    }>();
    const name = requireSlug(body.name, 'visual pack name');
    const pack = await createPack(visualRoot(loaded.root), name, body.subjectKind ?? 'generic', {
      cartridgeSlug: loaded.project.target_cartridge_id,
      entitySlug: body.entitySlug,
    });
    return c.json({ok: true, pack});
  });

  app.get('/api/projects/:slug/visuals/:name', async c => {
    const loaded = await loadByParam(c);
    const root = visualRoot(loaded.root);
    const pack = await loadPack(root, c.req.param('name'));
    return c.json({ok: true, pack, manifest: await readManifest(root, pack.name)});
  });

  app.put('/api/projects/:slug/visuals/:name', async c => {
    const loaded = await loadByParam(c);
    const body = await c.req.json<VisualPack>();
    const pack = {...body, name: c.req.param('name')};
    await savePack(visualRoot(loaded.root), pack);
    return c.json({ok: true, pack});
  });

  app.post('/api/projects/:slug/visuals/:name/reference', async c => {
    const loaded = await loadByParam(c);
    const body = await c.req.json<{dataBase64?: string}>();
    const data = decodeBase64(body.dataBase64);
    const root = visualRoot(loaded.root);
    await mkdir(packDir(root, c.req.param('name')), {recursive: true});
    await writeFile(referencePath(root, c.req.param('name')), data);
    return c.json({ok: true});
  });

  app.post('/api/projects/:slug/visuals/:name/manifest', async c => {
    const loaded = await loadByParam(c);
    const root = visualRoot(loaded.root);
    const pack = await loadPack(root, c.req.param('name'));
    const count = await rebuildManifest(root, pack);
    return c.json({ok: true, count, manifest: await readManifest(root, pack.name)});
  });

  app.post('/api/projects/:slug/visuals/:name/attach', async c => {
    const loaded = await loadByParam(c);
    const root = visualRoot(loaded.root);
    const pack = await loadPack(root, c.req.param('name'));
    const manifest = await readManifest(root, pack.name);
    const attached = await attachVisualManifest(loaded.root, loaded.records, manifest);
    return c.json({ok: true, attached});
  });

  app.get('/api/projects/:slug/graph', async c => {
    const loaded = await loadByParam(c);
    const graph = buildEntityGraph(loaded.records, await listPacks(visualRoot(loaded.root)));
    return c.json({ok: true, graph});
  });

  app.post('/api/projects/:slug/graph/validate', async c => {
    const loaded = await loadByParam(c);
    const graph = buildEntityGraph(loaded.records, await listPacks(visualRoot(loaded.root)));
    return c.json({
      ok: graph.issues.every(issue => issue.level !== 'error'),
      errors: graph.issues.filter(issue => issue.level === 'error'),
      warnings: graph.issues.filter(issue => issue.level === 'warning'),
      graph,
    });
  });

  app.get('/api/projects/:slug/locations/:locationSlug/tree', async c => {
    const loaded = await loadByParam(c);
    const graph = buildEntityGraph(loaded.records, await listPacks(visualRoot(loaded.root)));
    return c.json({
      ok: true,
      tree: locationTree(graph, c.req.param('locationSlug')),
    });
  });

  app.get('*', async c => servePublic(c));

  return app;
}

function visualRoot(projectRoot: string): string {
  return path.join(projectRoot, 'visual-packs');
}

async function loadByParam(c: Context) {
  return loadProject(requireSlug(c.req.param('slug'), 'project slug'));
}

function requireSlug(value: unknown, label: string): string {
  const slug = String(value ?? '').trim();
  if (!slugPattern.test(slug)) throw new Error(`${label} must be kebab-case`);
  return slug;
}

function requireKind(value: unknown): EntityKind {
  const kind = String(value ?? '') as EntityKind;
  const allowed = new Set<EntityKind>([
    'activity',
    'dialogue',
    'event',
    'faction',
    'item',
    'location',
    'person',
    'quest',
    'relationship',
    'scene',
    'world_fact',
  ]);
  if (!allowed.has(kind)) throw new Error('kind is invalid');
  return kind;
}

function requireSource(source: SourceRecord) {
  if (!/^src:[a-z0-9][a-z0-9:-]*$/.test(source.source_id)) {
    throw new Error('source_id must start with src: and use lowercase slug characters');
  }
  if (!source.title) throw new Error('source title is required');
  if (
    source.robots_status !== 'allowed' &&
    source.robots_status !== 'disallowed' &&
    source.robots_status !== 'not_checked' &&
    source.robots_status !== 'internal'
  ) {
    throw new Error('robots_status is invalid');
  }
}

function normalizeRecord(input: IngestRecord, previous?: IngestRecord): IngestRecord {
  const record = {
    ...(previous ?? {}),
    ...input,
    payload: input.payload ?? previous?.payload ?? {},
    links: input.links ?? previous?.links ?? [],
    provenance: input.provenance ?? previous?.provenance ?? [],
    quality: input.quality ?? previous?.quality ?? {review_status: 'draft', playable: true},
  } as IngestRecord;
  requireKind(record.kind);
  requireSlug(record.slug, 'record slug');
  return record;
}

function decodeBase64(value: unknown): Buffer {
  const text = String(value ?? '');
  if (!text) throw new Error('dataBase64 is required');
  const payload = text.includes(',') ? text.slice(text.indexOf(',') + 1) : text;
  return Buffer.from(payload, 'base64');
}

async function servePublic(c: Context) {
  const rawPath = c.req.path === '/' ? '/index.html' : c.req.path;
  const full = path.resolve(publicRoot, `.${rawPath}`);
  if (!full.startsWith(publicRoot)) return c.json({ok: false, error: 'forbidden'}, 403);
  const file = await readFile(full).catch(() => null);
  if (!file) return c.json({ok: false, error: 'not found'}, 404);
  return c.body(file, 200, {'content-type': contentType(full)});
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
