/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-CART-LIB-3 — apply route contract.
//
// Mocks `CartridgeImportApplyService` so the route validation,
// status-code mapping, and snake_case/camelCase body parity are
// pinned without the full pipeline.

import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const apply = vi.fn();

vi.mock('../../services/CartridgeImportApplyService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/CartridgeImportApplyService.js')
  >('../../services/CartridgeImportApplyService.js');
  return {
    ...actual,
    CartridgeImportApplyService: {apply},
  };
});

vi.mock('../../services/CartridgeImportPreviewService.js', () => ({
  CartridgeImportPreviewService: {
    createJob: vi.fn(),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
  },
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
const {ApplyServiceError} = await import(
  '../../services/CartridgeImportApplyService.js'
);

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

describe('cartridge import apply routes (FEAT-CART-LIB-3)', () => {
  beforeEach(() => {
    apply.mockReset();
  });

  describe('POST /api/cartridges/import/jobs/:jobId/apply', () => {
    it('returns 200 + view on happy path', async () => {
      apply.mockResolvedValueOnce({jobId: 'j1', status: 'applied'});
      const app = makeApp();
      const r = await postJson(app, '/api/cartridges/import/jobs/j1/apply', {});
      expect(r.status).toBe(200);
      expect(r.body.jobId).toBe('j1');
      expect(apply).toHaveBeenCalledWith({jobId: 'j1', acceptWarnings: false});
    });

    it('passes acceptWarnings through (camelCase + snake_case)', async () => {
      apply.mockResolvedValueOnce({jobId: 'j2', status: 'applied'});
      const app = makeApp();
      await postJson(app, '/api/cartridges/import/jobs/j2/apply', {
        acceptWarnings: true,
      });
      expect(apply).toHaveBeenLastCalledWith({
        jobId: 'j2',
        acceptWarnings: true,
      });
      apply.mockResolvedValueOnce({jobId: 'j3', status: 'applied'});
      await postJson(app, '/api/cartridges/import/jobs/j3/apply', {
        accept_warnings: true,
      });
      expect(apply).toHaveBeenLastCalledWith({
        jobId: 'j3',
        acceptWarnings: true,
      });
    });

    it('translates ApplyServiceError(unknown_job) to 404', async () => {
      apply.mockRejectedValueOnce(
        new ApplyServiceError('unknown_job', 'no such job'),
      );
      const app = makeApp();
      const r = await postJson(app, '/api/cartridges/import/jobs/x/apply', {});
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('unknown_job');
    });

    it('translates job_not_ready / validation_errors / validation_warnings / cartridge_id_mismatch to 409', async () => {
      apply.mockRejectedValueOnce(
        new ApplyServiceError('job_not_ready', 'queued'),
      );
      let r = await postJson(makeApp(), '/api/cartridges/import/jobs/x/apply', {});
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('job_not_ready');
      apply.mockRejectedValueOnce(
        new ApplyServiceError('validation_errors', '3 errors'),
      );
      r = await postJson(makeApp(), '/api/cartridges/import/jobs/y/apply', {});
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('validation_errors');
      apply.mockRejectedValueOnce(
        new ApplyServiceError('validation_warnings', '2 warnings'),
      );
      r = await postJson(makeApp(), '/api/cartridges/import/jobs/z/apply', {});
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('validation_warnings');
      apply.mockRejectedValueOnce(
        new ApplyServiceError('cartridge_id_mismatch', 'wrong url'),
      );
      r = await postJson(makeApp(), '/api/cartridges/import/jobs/w/apply', {});
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('cartridge_id_mismatch');
    });

    it('translates other ApplyServiceError shapes to 400', async () => {
      apply.mockRejectedValueOnce(
        new ApplyServiceError('source_changed', 'hash drift'),
      );
      const r = await postJson(makeApp(), '/api/cartridges/import/jobs/x/apply', {});
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('source_changed');
    });

    it('rejects an oversized job id without calling the service', async () => {
      const app = makeApp();
      const r = await postJson(
        app,
        `/api/cartridges/import/jobs/${'x'.repeat(65)}/apply`,
        {},
      );
      expect(r.status).toBe(400);
      expect(apply).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/cartridges/import/apply (body shape)', () => {
    it('accepts {jobId} + camelCase acceptWarnings', async () => {
      apply.mockResolvedValueOnce({jobId: 'jB', status: 'applied'});
      const r = await postJson(makeApp(), '/api/cartridges/import/apply', {
        jobId: 'jB',
        acceptWarnings: true,
      });
      expect(r.status).toBe(200);
      expect(apply).toHaveBeenCalledWith({
        jobId: 'jB',
        acceptWarnings: true,
      });
    });

    it('accepts snake_case job_id + accept_warnings', async () => {
      apply.mockResolvedValueOnce({jobId: 'jB2', status: 'applied'});
      const r = await postJson(makeApp(), '/api/cartridges/import/apply', {
        job_id: 'jB2',
        accept_warnings: true,
      });
      expect(r.status).toBe(200);
      expect(apply).toHaveBeenCalledWith({
        jobId: 'jB2',
        acceptWarnings: true,
      });
    });

    it('400s when body lacks jobId', async () => {
      const r = await postJson(makeApp(), '/api/cartridges/import/apply', {
        acceptWarnings: true,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_job_id');
      expect(apply).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/cartridges/:id/reimport/apply', () => {
    it('forwards URL :id as expectedCartridgeId on the happy path', async () => {
      apply.mockResolvedValueOnce({
        jobId: 'jR',
        status: 'applied',
        result: {cartridgeId: 'demo'},
      });
      const r = await postJson(
        makeApp(),
        '/api/cartridges/demo/reimport/apply',
        {jobId: 'jR'},
      );
      expect(r.status).toBe(200);
      expect(apply).toHaveBeenCalledWith({
        jobId: 'jR',
        acceptWarnings: false,
        expectedCartridgeId: 'demo',
      });
    });

    it('forwards URL :id as expectedCartridgeId with acceptWarnings', async () => {
      apply.mockResolvedValueOnce({
        jobId: 'jR-aw',
        status: 'applied',
        result: {cartridgeId: 'demo'},
      });
      await postJson(makeApp(), '/api/cartridges/demo/reimport/apply', {
        jobId: 'jR-aw',
        acceptWarnings: true,
      });
      expect(apply).toHaveBeenLastCalledWith({
        jobId: 'jR-aw',
        acceptWarnings: true,
        expectedCartridgeId: 'demo',
      });
    });

    it('translates service cartridge_id_mismatch to 409 (no post-commit check)', async () => {
      apply.mockRejectedValueOnce(
        new ApplyServiceError(
          'cartridge_id_mismatch',
          `reimport URL targeted 'demo' but preview job applies to 'other'`,
        ),
      );
      const r = await postJson(
        makeApp(),
        '/api/cartridges/demo/reimport/apply',
        {jobId: 'jR2'},
      );
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('cartridge_id_mismatch');
      expect(apply).toHaveBeenCalledWith({
        jobId: 'jR2',
        acceptWarnings: false,
        expectedCartridgeId: 'demo',
      });
    });

    it('400s on missing jobId', async () => {
      const r = await postJson(
        makeApp(),
        '/api/cartridges/demo/reimport/apply',
        {},
      );
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_job_id');
    });
  });
});
