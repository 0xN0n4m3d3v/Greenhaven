/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {Hono} from 'hono';
import {errorResponse} from '../httpErrors.js';
import {SaveSlotService} from '../services/SaveSlotService.js';

export const savesRoutes = new Hono();

function parsePositiveInt(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

savesRoutes.get('/:id/saves', async c => {
  const playerId = parsePositiveInt(c.req.param('id'));
  if (playerId == null) {
    return c.json({error: 'invalid player id'}, 400);
  }
  return c.json({slots: await SaveSlotService.list(playerId)});
});

savesRoutes.post('/:id/saves', async c => {
  const playerId = parsePositiveInt(c.req.param('id'));
  if (playerId == null) {
    return c.json({error: 'invalid player id'}, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    slot_name?: string;
    is_auto?: boolean;
  };
  const slotName = (body.slot_name ?? '').trim();
  if (slotName.length === 0 || slotName.length > 40) {
    return c.json({error: 'slot_name must be 1..40 chars'}, 400);
  }
  const created = await SaveSlotService.create(
    playerId,
    slotName,
    body.is_auto ?? false,
  );
  return c.json({ok: true, id: created.id, size_bytes: created.size_bytes});
});

savesRoutes.post('/:id/saves/:slotId/restore', async c => {
  const playerId = parsePositiveInt(c.req.param('id'));
  const slotId = parsePositiveInt(c.req.param('slotId'));
  if (playerId == null) {
    return c.json({error: 'invalid player id'}, 400);
  }
  if (slotId == null) {
    return c.json({error: 'invalid slot id'}, 400);
  }
  try {
    const restored = await SaveSlotService.restore(playerId, slotId);
    if (!restored) return c.json({error: 'slot not found'}, 404);
  } catch (err) {
    // SEC-3 / DEEP-7 — opaque body + correlation id; full error
    // captured via `http.error` telemetry + console.error.
    return errorResponse(c, 500, 'save_restore_failed', {internal: err});
  }
  return c.json({ok: true});
});

savesRoutes.delete('/:id/saves/:slotId', async c => {
  const playerId = parsePositiveInt(c.req.param('id'));
  const slotId = parsePositiveInt(c.req.param('slotId'));
  if (playerId == null) {
    return c.json({error: 'invalid player id'}, 400);
  }
  if (slotId == null) {
    return c.json({error: 'invalid slot id'}, 400);
  }
  await SaveSlotService.delete(playerId, slotId);
  return c.json({ok: true});
});
