/**
 * Health and DB diagnostic routes.
 * Extracted from index.ts (GH-BUG-081).
 */
import {Hono} from 'hono';
import {HealthService} from '../services/HealthService.js';

export const healthRoutes = new Hono();

// Health check — used by web-ui to detect "is the bridge up?" before the
// proper session handshake.
healthRoutes.get('/health', async c => {
  const status = await HealthService.health();
  return c.json(
    status,
    status.ok ? 200 : 503,
  );
});

// DB status. Includes Postgres version + whether pgvector is loaded.
// Returns ok=false (not 503) so the UI can render a "DB offline" badge
// without flipping the whole bridge into error mode.
healthRoutes.get('/db/health', async c => {
  return c.json(await HealthService.dbStatus());
});

// Debug: list tables + row counts. Useful for verifying migrations
// landed cleanly and watching state grow as we add seed data. Pure
// dev convenience — guard or remove before shipping.
healthRoutes.get('/db/tables', async c => {
  return c.json({tables: await HealthService.tableCounts()});
});
