/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-2 — `/api/cartridges/import/jobs` route contract.
//
// Mocks `CartridgeImportPreviewService` so the route's input
// validation + status-code mapping is pinned without booting the
// import pipeline. Service-level behavior is covered by the
// service test file.

import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const createJob = vi.fn();
const getJob = vi.fn();
const cancelJob = vi.fn();

vi.mock('../../services/CartridgeImportPreviewService.js', () => ({
  CartridgeImportPreviewService: {createJob, getJob, cancelJob},
}));
vi.mock('../../services/CartridgeLibraryService.js', () => ({
  CartridgeLibraryService: {
    listCartridges: vi.fn(),
    getCartridge: vi.fn(),
    listHeroes: vi.fn(),
    listPlaythroughs: vi.fn(),
  },
}));

const {cartridgeLibraryRoutes} = await import('../../routes/cartridges.js');

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', cartridgeLibraryRoutes);
  return app;
}

async function postJson(
  app: Hono,
  url: string,
  body: unknown,
): Promise<{status: number; body: Record<string, unknown>}> {
  const res = await app.request(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  return {status: res.status, body: (await res.json()) as Record<string, unknown>};
}

describe('cartridge import job routes (FEAT-CART-LIB-2)', () => {
  beforeEach(() => {
    createJob.mockReset();
    getJob.mockReset();
    cancelJob.mockReset();
  });

  describe('POST /api/cartridges/import/jobs', () => {
    it('returns 201 with the created view on happy path', async () => {
      createJob.mockResolvedValueOnce({
        jobId: 'job-1',
        status: 'running',
        sourceKind: 'forge_project',
        sourcePath: '/tmp/x',
      });
      const app = makeApp();
      const r = await postJson(app, '/api/cartridges/import/jobs', {
        sourceKind: 'forge_project',
        sourcePath: '/tmp/x',
      });
      expect(r.status).toBe(201);
      expect(r.body.jobId).toBe('job-1');
      expect(createJob).toHaveBeenCalledWith({
        sourceKind: 'forge_project',
        sourcePath: '/tmp/x',
      });
    });

    it('returns 400 for an invalid source kind without calling the service', async () => {
      const app = makeApp();
      const r = await postJson(app, '/api/cartridges/import/jobs', {
        sourceKind: 'http_download',
        sourcePath: '/tmp/x',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_source_kind');
      expect(createJob).not.toHaveBeenCalled();
    });

    it('returns 400 for an empty source path', async () => {
      const app = makeApp();
      const r = await postJson(app, '/api/cartridges/import/jobs', {
        sourceKind: 'forge_project',
        sourcePath: '',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_source_path');
      expect(createJob).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid mode', async () => {
      const app = makeApp();
      const r = await postJson(app, '/api/cartridges/import/jobs', {
        sourceKind: 'forge_project',
        sourcePath: '/tmp/x',
        mode: 'delete_everything',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_mode');
      expect(createJob).not.toHaveBeenCalled();
    });

    it('accepts snake_case keys (source_kind / source_path / cartridge_id)', async () => {
      createJob.mockResolvedValueOnce({jobId: 'job-snake'});
      const app = makeApp();
      const r = await postJson(app, '/api/cartridges/import/jobs', {
        source_kind: 'agent_pack',
        source_path: '/tmp/pack',
        cartridge_id: 'demo',
      });
      expect(r.status).toBe(201);
      expect(createJob).toHaveBeenCalledWith({
        sourceKind: 'agent_pack',
        sourcePath: '/tmp/pack',
        cartridgeId: 'demo',
      });
    });

    it('translates a service throw into a 400 body', async () => {
      createJob.mockRejectedValueOnce(
        Object.assign(new Error('boom'), {code: 'transformer_failed'}),
      );
      const app = makeApp();
      const r = await postJson(app, '/api/cartridges/import/jobs', {
        sourceKind: 'forge_project',
        sourcePath: '/tmp/x',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('transformer_failed');
      expect(r.body.message).toBe('boom');
    });

    it('returns 503 when the local PGlite database is unavailable', async () => {
      createJob.mockRejectedValueOnce(
        new Error('RuntimeError: Aborted(). Build with -sASSERTIONS for more info.'),
      );
      const app = makeApp();
      const r = await postJson(app, '/api/cartridges/import/jobs', {
        sourceKind: 'obsidian_vault',
        sourcePath: 'C:\\Greenhaven\\GreenhavenWorld\\GreenhavenNoir',
      });
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('local_database_unavailable');
    });
  });

  describe('GET /api/cartridges/import/jobs/:jobId', () => {
    it('returns 200 with the job view when found', async () => {
      getJob.mockResolvedValueOnce({jobId: 'job-1', status: 'ready'});
      const app = makeApp();
      const res = await app.request('/api/cartridges/import/jobs/job-1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {jobId: string; status: string};
      expect(body).toEqual({jobId: 'job-1', status: 'ready'});
    });

    it('returns 404 when the service returns null', async () => {
      getJob.mockResolvedValueOnce(null);
      const app = makeApp();
      const res = await app.request('/api/cartridges/import/jobs/job-missing');
      expect(res.status).toBe(404);
      expect((await res.json()) as Record<string, unknown>).toEqual({
        error: 'unknown_job',
      });
    });

    it('returns 400 for an oversized job id', async () => {
      const app = makeApp();
      const huge = 'x'.repeat(65);
      const res = await app.request(`/api/cartridges/import/jobs/${huge}`);
      expect(res.status).toBe(400);
      expect(getJob).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/cartridges/import/jobs/:jobId/cancel', () => {
    it('returns 200 + cancelled view on happy path', async () => {
      cancelJob.mockResolvedValueOnce({jobId: 'job-1', status: 'cancelled'});
      const app = makeApp();
      const res = await app.request('/api/cartridges/import/jobs/job-1/cancel', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {status: string};
      expect(body.status).toBe('cancelled');
      expect(cancelJob).toHaveBeenCalledWith('job-1');
    });

    it('returns 404 when the service returns null', async () => {
      cancelJob.mockResolvedValueOnce(null);
      const app = makeApp();
      const res = await app.request(
        '/api/cartridges/import/jobs/missing/cancel',
        {method: 'POST'},
      );
      expect(res.status).toBe(404);
    });
  });
});
