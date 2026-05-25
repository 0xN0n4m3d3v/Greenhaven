/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-2 — `CartridgeImportPreviewService` contract.
//
// Mocks `query()` so the in-memory job lifecycle, on-disk forge-
// project reader, and content-hash determinism are exercised
// without booting PGlite. Obsidian-vault spawn flow is covered
// indirectly by the live smoke at
// `src/scripts/cartridge-import-preview-smoke.ts`.

import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it, vi} from 'vitest';

interface QueryRow {
  [key: string]: unknown;
}
interface QueryResult {
  rows: QueryRow[];
  rowCount?: number;
}

const queryMock =
  vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
const spawnMock = vi.hoisted(() => vi.fn());
const telemetryRecordMock = vi.hoisted(() => vi.fn());

vi.mock('../../db.js', () => ({
  query: queryMock,
}));
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));
vi.mock('../../telemetry/index.js', () => ({
  telemetry: {
    record: telemetryRecordMock,
  },
}));

const {
  CartridgeImportPreviewService,
  readInstallCache,
} = await import('../../services/CartridgeImportPreviewService.js');

// In-memory job table emulated by the mock so create→run→read
// flows correctly. We honor the SQL shape verbatim because the
// service writes patches via `UPDATE ... SET col = $n` strings.
interface FakeJob extends QueryRow {
  job_id: string;
  cartridge_id: string | null;
  mode: string;
  source_kind: string;
  source_path: string;
  status: string;
  phase: string;
  progress_processed: number;
  progress_total: number;
  result: Record<string, unknown>;
  error: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

const jobs = new Map<string, FakeJob>();

function installFakeJobsBackend(): void {
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO cartridge_import_preview_jobs')) {
      const arr = (params ?? []) as Array<string | null | undefined>;
      const jobId = String(arr[0] ?? '');
      const cartridgeId = (arr[1] ?? null) as string | null;
      const mode = String(arr[2] ?? '');
      const sourceKind = String(arr[3] ?? '');
      const sourcePath = String(arr[4] ?? '');
      jobs.set(jobId, {
        job_id: jobId,
        cartridge_id: cartridgeId,
        mode,
        source_kind: sourceKind,
        source_path: sourcePath,
        status: 'queued',
        phase: 'queued',
        progress_processed: 0,
        progress_total: 0,
        result: {},
        error: {},
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        updated_at: new Date().toISOString(),
      });
      return {rows: []};
    }
    if (sql.includes('UPDATE cartridge_import_preview_jobs')) {
      // Reconstruct the SET map from the `col = $n` fragments
      // alongside the trailing `WHERE job_id = $n`. The service
      // pushes params in order: each SET value, then jobId.
      const setMatches = [...sql.matchAll(/(\w+)\s*=\s*\$(\d+)/g)];
      // Drop the trailing `WHERE job_id = $N` capture.
      const wherePart = setMatches.pop();
      const jobId = (params ?? [])[Number(wherePart?.[2] ?? 0) - 1] as string;
      const target = jobs.get(jobId);
      if (target) {
        for (const m of setMatches) {
          const col = m[1] ?? '';
          const idx = Number(m[2]) - 1;
          let value = (params ?? [])[idx];
          if (
            (col === 'result' || col === 'error') &&
            typeof value === 'string'
          ) {
            try {
              value = JSON.parse(value);
            } catch {
              // leave as string
            }
          }
          (target as Record<string, unknown>)[col] = value;
        }
        target.updated_at = new Date().toISOString();
      }
      return {rows: []};
    }
    if (sql.includes('FROM cartridge_import_preview_jobs')) {
      const jobId = (params ?? [])[0] as string;
      const row = jobs.get(jobId);
      return {rows: row ? [row] : []};
    }
    if (sql.includes('FROM cartridge_records')) {
      // No existing cartridge records → every record is `new`.
      return {rows: []};
    }
    if (sql.includes('FROM cartridge_install_cache')) {
      return {rows: []};
    }
    return {rows: []};
  });
}

function makeChild(exitCode = 0): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit('close', exitCode));
  return child;
}

async function writeForgeProject(
  dir: string,
  opts: {createdAt?: string} = {},
): Promise<void> {
  await mkdir(path.join(dir, 'records'), {recursive: true});
  await mkdir(path.join(dir, 'audit'), {recursive: true});
  await writeFile(
    path.join(dir, 'forge.project.json'),
    JSON.stringify(
      {
        schema_version: 'greenhaven.cartridge_forge_project.v1',
        project_slug: 'unit-test',
        pack_slug: 'unit-test',
        target_cartridge_id: 'unit-test-cartridge',
        ...(opts.createdAt ? {created_at: opts.createdAt} : {}),
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(dir, 'sources.jsonl'),
    JSON.stringify({source_id: 'src:unit-test', title: 'Unit test'}) + '\n',
  );
  await writeFile(
    path.join(dir, 'records', 'locations.jsonl'),
    [
      {record_id: 'ghc:location:square', slug: 'square', kind: 'location'},
      {record_id: 'ghc:location:market', slug: 'market', kind: 'location'},
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  await writeFile(
    path.join(dir, 'records', 'npcs.jsonl'),
    [
      {record_id: 'ghc:person:mira', slug: 'mira', kind: 'person'},
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  await writeFile(
    path.join(dir, 'audit', 'validation.md'),
    '# Validation\n\nClean.\n',
  );
}

async function writeForgeProjectWithBootAsset(
  dir: string,
  assetBytes: string,
): Promise<void> {
  await writeForgeProject(dir);
  await mkdir(path.join(dir, 'GreenHavenWorld', 'media', 'boot'), {
    recursive: true,
  });
  await writeFile(
    path.join(dir, 'GreenHavenWorld', 'media', 'boot', '01.png'),
    assetBytes,
  );
  await writeFile(
    path.join(dir, 'audit', 'visual-assets.jsonl'),
    JSON.stringify({
      kind: 'cartridge',
      slug: 'boot',
      role: 'boot_poster_01',
      mention: '@Boot 01',
      path: 'GreenHavenWorld/media/boot/01.png',
      source_path: 'GreenHavenWorld/media/boot/01.png',
    }) + '\n',
  );
}

async function makeForgeProject(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-preview-test-'));
  await writeForgeProject(dir);
  return dir;
}

async function pollUntilTerminal(
  jobId: string,
  maxMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const view = await CartridgeImportPreviewService.getJob(jobId);
    if (
      view &&
      (view.status === 'ready' ||
        view.status === 'failed' ||
        view.status === 'cancelled')
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} did not reach a terminal state in ${maxMs}ms`);
}

describe('CartridgeImportPreviewService (FEAT-CART-LIB-2)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeChild(0));
    telemetryRecordMock.mockReset();
    jobs.clear();
    installFakeJobsBackend();
  });

  describe('createJob() validation', () => {
    it('rejects an invalid source kind', async () => {
      await expect(
        CartridgeImportPreviewService.createJob({
          sourceKind: 'bogus' as 'forge_project',
          sourcePath: '/tmp/anything',
        }),
      ).rejects.toMatchObject({code: 'invalid_source_kind'});
    });

    it('rejects an empty source path', async () => {
      await expect(
        CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: '   ',
        }),
      ).rejects.toMatchObject({code: 'invalid_source_path'});
    });
  });

  describe('forge_project preview', () => {
    it('parses manifest + records + content hash and reaches ready', async () => {
      const dir = await makeForgeProject();
      try {
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: dir,
        });
        expect(['queued', 'running']).toContain(view.status);
        await pollUntilTerminal(view.jobId);
        const after = await CartridgeImportPreviewService.getJob(view.jobId);
        expect(after?.status).toBe('ready');
        expect(after?.result?.cartridgeId).toBe('unit-test-cartridge');
        expect(after?.result?.totalRecords).toBe(3);
        expect(after?.result?.counts).toEqual({locations: 2, npcs: 1});
        expect(after?.result?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(after?.result?.validation.errors).toBe(0);
        // Diff against empty cartridge_records → 3 new.
        expect(after?.result?.diff.new).toBe(3);
        expect(after?.result?.generatedArtifacts).toContain(
          'forge.project.json',
        );
      } finally {
        await rm(dir, {recursive: true, force: true});
      }
    });

    it('does not count "- none" unresolved-links reports as warnings', async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-none-links-'));
      const dir = path.join(parent, 'cartridge-forge-project');
      try {
        await writeForgeProject(dir);
        await writeFile(
          path.join(parent, 'unresolved-links.md'),
          '# Unresolved Runtime Mentions\n\n- none\n',
        );
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: dir,
        });
        await pollUntilTerminal(view.jobId);
        const after = await CartridgeImportPreviewService.getJob(view.jobId);
        expect(after?.status).toBe('ready');
        expect(after?.result?.validation.unresolvedLinks).toBe(0);
        expect(after?.result?.validation.warnings).toBe(0);
      } finally {
        await rm(parent, {recursive: true, force: true});
      }
    });

    it('keeps the cartridge content hash stable when only manifest timestamps change', async () => {
      const first = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-hash-a-'));
      const second = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-hash-b-'));
      try {
        await writeForgeProject(first, {
          createdAt: '2026-05-18T01:00:00.000Z',
        });
        await writeForgeProject(second, {
          createdAt: '2026-05-18T02:00:00.000Z',
        });

        const a = await CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: first,
        });
        await pollUntilTerminal(a.jobId);
        const aAfter = await CartridgeImportPreviewService.getJob(a.jobId);

        const b = await CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: second,
        });
        await pollUntilTerminal(b.jobId);
        const bAfter = await CartridgeImportPreviewService.getJob(b.jobId);

        expect(aAfter?.status, JSON.stringify(aAfter?.error)).toBe('ready');
        expect(bAfter?.status, JSON.stringify(bAfter?.error)).toBe('ready');
        expect(aAfter?.result?.contentHash).toBe(
          bAfter?.result?.contentHash,
        );
      } finally {
        await rm(first, {recursive: true, force: true});
        await rm(second, {recursive: true, force: true});
      }
    });

    it('changes the cartridge content hash when a referenced boot asset changes', async () => {
      const first = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-asset-a-'));
      const second = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-asset-b-'));
      try {
        await writeForgeProjectWithBootAsset(first, 'old-poster-bytes');
        await writeForgeProjectWithBootAsset(second, 'new-poster-bytes');

        const a = await CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: first,
        });
        await pollUntilTerminal(a.jobId);
        const aAfter = await CartridgeImportPreviewService.getJob(a.jobId);

        const b = await CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: second,
        });
        await pollUntilTerminal(b.jobId);
        const bAfter = await CartridgeImportPreviewService.getJob(b.jobId);

        expect(aAfter?.status, JSON.stringify(aAfter?.error)).toBe('ready');
        expect(bAfter?.status, JSON.stringify(bAfter?.error)).toBe('ready');
        expect(aAfter?.result?.contentHash).not.toBe(
          bAfter?.result?.contentHash,
        );
      } finally {
        await rm(first, {recursive: true, force: true});
        await rm(second, {recursive: true, force: true});
      }
    });

    it('fails with source_path_missing for a non-existent path', async () => {
      const view = await CartridgeImportPreviewService.createJob({
        sourceKind: 'forge_project',
        sourcePath: path.join(os.tmpdir(), 'definitely-not-a-real-dir-' + Date.now()),
      });
      await pollUntilTerminal(view.jobId);
      const after = await CartridgeImportPreviewService.getJob(view.jobId);
      expect(after?.status).toBe('failed');
      expect(after?.error?.code).toBe('source_path_missing');
    });

    it('returns a typed error when forge_project points at a non-forge directory', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-not-forge-'));
      try {
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: dir,
        });
        await pollUntilTerminal(view.jobId);
        const after = await CartridgeImportPreviewService.getJob(view.jobId);
        expect(after?.status).toBe('failed');
        expect(after?.error?.code).toBe('forge_project_manifest_missing');
        expect(after?.error?.message).toContain('choose source kind obsidian_vault');
      } finally {
        await rm(dir, {recursive: true, force: true});
      }
    });

    it('treats a Greenhaven Obsidian child folder as obsidian_vault instead of failing on forge.project.json', async () => {
      const vault = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-vault-'));
      try {
        await mkdir(path.join(vault, '.greenhaven-agent-manual'), {
          recursive: true,
        });
        await mkdir(path.join(vault, 'GreenHavenWorld'), {recursive: true});
        const generatedForge = path.join(
          vault,
          '.greenhaven-agent-manual',
          'generated',
          'cartridge-forge-project',
        );
        await writeForgeProject(generatedForge);
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: path.join(vault, 'GreenHavenWorld'),
        });
        await pollUntilTerminal(view.jobId);
        const after = await CartridgeImportPreviewService.getJob(view.jobId);
        expect(after?.status).toBe('ready');
        expect(after?.result?.generatedArtifacts).toContain(
          'forge.project.json',
        );
        expect(spawnMock).toHaveBeenCalled();
      } finally {
        await rm(vault, {recursive: true, force: true});
      }
    });

    it('accepts a minimal Obsidian vault with WORLD_MANIFEST.md and no agent manual', async () => {
      const vault = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-min-vault-'));
      try {
        await writeFile(path.join(vault, 'WORLD_MANIFEST.md'), '# Unit Vault\n');
        await mkdir(path.join(vault, 'GreenHavenWorld'), {recursive: true});
        const generatedForge = path.join(
          vault,
          '.greenhaven-agent-manual',
          'generated',
          'cartridge-forge-project',
        );
        await writeForgeProject(generatedForge);
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'obsidian_vault',
          sourcePath: path.join(vault, 'GreenHavenWorld'),
        });
        await pollUntilTerminal(view.jobId);
        const after = await CartridgeImportPreviewService.getJob(view.jobId);
        expect(after?.status).toBe('ready');
        expect(after?.result?.cartridgeId).toBe('unit-test-cartridge');
        expect(spawnMock).toHaveBeenCalled();
      } finally {
        await rm(vault, {recursive: true, force: true});
      }
    });

    it('finds the transformer when the dev server cwd is packages/web-server', async () => {
      const webServerDir = process.cwd().endsWith('web-server')
        ? process.cwd()
        : path.resolve(process.cwd(), 'packages', 'web-server');
      const cwdSpy = vi
        .spyOn(process, 'cwd')
        .mockReturnValue(webServerDir);
      const vault = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-cwd-vault-'));
      try {
        await writeFile(path.join(vault, 'WORLD_MANIFEST.md'), '# Unit Vault\n');
        await mkdir(path.join(vault, 'GreenHavenWorld'), {recursive: true});
        const generatedForge = path.join(
          vault,
          '.greenhaven-agent-manual',
          'generated',
          'cartridge-forge-project',
        );
        await writeForgeProject(generatedForge);
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'obsidian_vault',
          sourcePath: path.join(vault, 'GreenHavenWorld'),
        });
        await pollUntilTerminal(view.jobId);
        const after = await CartridgeImportPreviewService.getJob(view.jobId);
        expect(after?.status).toBe('ready');
        expect(after?.result?.cartridgeId).toBe('unit-test-cartridge');
        expect(spawnMock).toHaveBeenCalled();
      } finally {
        cwdSpy.mockRestore();
        await rm(vault, {recursive: true, force: true});
      }
    });

    it('finds the transformer beside the selected vault when packaged cwd is elsewhere', async () => {
      const packagedCwd = await mkdtemp(
        path.join(os.tmpdir(), 'greenhaven-win-unpacked-'),
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(packagedCwd);
      const vault = await mkdtemp(
        path.join(os.tmpdir(), 'cart-lib-packaged-vault-'),
      );
      try {
        await writeFile(path.join(vault, 'WORLD_MANIFEST.md'), '# Unit Vault\n');
        await mkdir(path.join(vault, 'GreenHavenWorld'), {recursive: true});
        const scriptDir = path.join(
          vault,
          '.greenhaven-agent-manual',
          'skills',
          'greenhaven-human-world-transformer',
          'scripts',
        );
        await mkdir(scriptDir, {recursive: true});
        const transformerScript = path.join(scriptDir, 'compile_vault_to_forge.py');
        await writeFile(transformerScript, '# test transformer placeholder\n');
        const generatedForge = path.join(
          vault,
          '.greenhaven-agent-manual',
          'generated',
          'cartridge-forge-project',
        );
        await writeForgeProject(generatedForge);
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'obsidian_vault',
          sourcePath: path.join(vault, 'GreenHavenWorld'),
        });
        await pollUntilTerminal(view.jobId);
        const after = await CartridgeImportPreviewService.getJob(view.jobId);
        expect(after?.status).toBe('ready');
        expect(spawnMock).toHaveBeenCalled();
        const spawnArgs = spawnMock.mock.calls[0] ?? [];
        expect(spawnArgs[1]).toEqual([
          transformerScript,
          '--vault-root',
          vault,
        ]);
        expect(spawnArgs[2]).toMatchObject({cwd: scriptDir});
      } finally {
        cwdSpy.mockRestore();
        await rm(vault, {recursive: true, force: true});
        await rm(packagedCwd, {recursive: true, force: true});
      }
    });
  });

  describe('agent_pack preview', () => {
    it('uses manifest.json instead of forge.project.json', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-agent-pack-'));
      try {
        await mkdir(path.join(dir, 'records'), {recursive: true});
        await writeFile(
          path.join(dir, 'manifest.json'),
          JSON.stringify({pack_slug: 'agent-pack-test'}),
        );
        await writeFile(
          path.join(dir, 'records', 'locations.jsonl'),
          JSON.stringify({record_id: 'x', slug: 'x', kind: 'location'}) + '\n',
        );
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'agent_pack',
          sourcePath: dir,
        });
        await pollUntilTerminal(view.jobId);
        const after = await CartridgeImportPreviewService.getJob(view.jobId);
        expect(after?.status).toBe('ready');
        expect(after?.result?.cartridgeId).toBe('agent-pack-test');
        expect(after?.result?.totalRecords).toBe(1);
      } finally {
        await rm(dir, {recursive: true, force: true});
      }
    });

    it('fails when manifest.json is missing', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'cart-lib-agent-pack-no-'));
      try {
        await mkdir(path.join(dir, 'records'), {recursive: true});
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'agent_pack',
          sourcePath: dir,
        });
        await pollUntilTerminal(view.jobId);
        const after = await CartridgeImportPreviewService.getJob(view.jobId);
        expect(after?.status).toBe('failed');
        expect(after?.error?.message).toMatch(/manifest\.json missing/);
      } finally {
        await rm(dir, {recursive: true, force: true});
      }
    });
  });

  describe('cancelJob()', () => {
    it('returns null for an unknown job', async () => {
      const out = await CartridgeImportPreviewService.cancelJob('nope');
      expect(out).toBeNull();
    });

    it('does NOT write into cartridge_records / cartridges / entities (preview is read-only)', async () => {
      const dir = await makeForgeProject();
      try {
        const view = await CartridgeImportPreviewService.createJob({
          sourceKind: 'forge_project',
          sourcePath: dir,
        });
        await pollUntilTerminal(view.jobId);
        const writeShape =
          /(INSERT|UPDATE|DELETE)\s+(INTO\s+)?(cartridge_records|cartridges|cartridge_meta_scoped|entities|players)\b/i;
        const offendingSql = queryMock.mock.calls
          .map((call) => String(call[0] ?? ''))
          .find((sql) => writeShape.test(sql));
        expect(offendingSql).toBeUndefined();
      } finally {
        await rm(dir, {recursive: true, force: true});
      }
    });
  });

  describe('readInstallCache()', () => {
    it('returns null when no row exists', async () => {
      const out = await readInstallCache('missing');
      expect(out).toBeNull();
    });
  });
});
