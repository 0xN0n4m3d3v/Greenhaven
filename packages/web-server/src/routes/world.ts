/**
 * World overview route.
 * Extracted from index.ts (GH-BUG-081).
 *
 * Generic world-state inspector. Cartridge-agnostic — works with any
 * entity in any cartridge. Two modes:
 *
 *   GET /api/world                    — overview: cartridge identity,
 *                                       per-kind entity counts, totals.
 *
 *   GET /api/world?entity=<id>        — full state for one entity.
 *   GET /api/world?npc=<id>           — alias of ?entity=  (any kind).
 *   GET /api/world?location=<id>      — alias.
 *   GET /api/world?scene=<id>         — alias.
 *   GET /api/world?item=<id>          — alias.
 *   GET /api/world?quest=<id>         — alias.
 */
import {Hono, type Context} from 'hono';
import {WorldService} from '../services/WorldService.js';

export const worldRoutes = new Hono();

worldRoutes.get('/world', async c => {
  const entityIdRaw = firstQueryValue(c, [
    'entity',
    'npc',
    'location',
    'scene',
    'item',
    'quest',
  ]);

  if (!entityIdRaw) {
    return c.json(await WorldService.overview());
  }

  const entityId = Number(entityIdRaw);
  if (!Number.isInteger(entityId) || entityId <= 0) {
    return c.json({ok: false, error: 'invalid entity id'}, 400);
  }

  const detail = await WorldService.entity(entityId);
  if (!detail) {
    return c.json({ok: false, error: `unknown entity ${entityId}`}, 404);
  }
  return c.json(detail);
});

function firstQueryValue(
  c: Context,
  params: string[],
): string | undefined {
  for (const param of params) {
    const value = c.req.query(param);
    if (value) return value;
  }
  return undefined;
}
