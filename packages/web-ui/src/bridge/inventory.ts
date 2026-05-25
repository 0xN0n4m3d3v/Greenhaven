/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-INV-1 — Inventory bridge.
//
// Owns the `/api/player/:id/inventory` read surface so
// `InventorySurface` and `useInventorySnapshot` never call
// `fetch(...)` directly.

export type InventoryCategory =
  | 'weapon'
  | 'armor'
  | 'consumable'
  | 'tool'
  | 'quest'
  | 'material'
  | 'currency'
  | 'misc';

export interface InventoryItem {
  id: string;
  rowId: number | null;
  source: 'player_inventory' | 'inventory_entries';
  slug: string | null;
  name: string;
  summary: string | null;
  category: InventoryCategory;
  quantity: number;
  stackable: boolean;
  weightKg: number;
  rarity: string | null;
  iconKey: string | null;
  iconUrl: string | null;
  equipped: boolean;
  equippedSlot: string | null;
  attributes: Record<string, unknown>;
}

export interface InventoryTotals {
  itemCount: number;
  uniqueItems: number;
  weightKg: number;
  equippedCount: number;
}

export interface InventorySnapshot {
  playerId: number;
  currency: {count: number};
  equipment: InventoryItem[];
  items: InventoryItem[];
  totals: InventoryTotals;
}

/**
 * Returns `null` when the endpoint replies non-2xx so the hook
 * can surface a focused error state without leaking HTTP details
 * to the surface body.
 */
export async function fetchPlayerInventory(args: {
  playerId: number;
  language?: string | null;
  baseUrl?: string;
}): Promise<InventorySnapshot | null> {
  const params = args.language
    ? `?language=${encodeURIComponent(args.language)}`
    : '';
  const r = await fetch(
    `${args.baseUrl ?? ''}/api/player/${args.playerId}/inventory${params}`,
    {credentials: 'include'},
  );
  if (!r.ok) return null;
  const data = (await r.json()) as Partial<InventorySnapshot>;
  return {
    playerId: data.playerId ?? args.playerId,
    currency: data.currency ?? {count: 0},
    equipment: data.equipment ?? [],
    items: data.items ?? [],
    totals:
      data.totals ?? {
        itemCount: 0,
        uniqueItems: 0,
        weightKg: 0,
        equippedCount: 0,
      },
  };
}

// FEAT-INV-1 mutation helpers. The surface calls these from the
// detail panel; the server endpoint dispatches into the existing
// `use_item` / `equip_item` / `give_to_npc` tools so validation,
// transactional state mutation, and the `inventory:changed` SSE
// fan-out are all shared with the LLM-driven path. Returning a
// structured `{ok, error?}` lets the surface render a focused
// error chip without exposing HTTP details.

export type InventoryActionKind = 'use' | 'equip' | 'unequip' | 'give';

export interface InventoryActionRequest {
  playerId: number;
  sessionId: string;
  action: InventoryActionKind;
  itemSlug: string;
  /** `give` only. */
  npc?: string;
  /** `give` only. */
  quantity?: number;
  /** `use` only. */
  targetLocation?: string;
  /** `use` only. */
  targetEntity?: string;
  baseUrl?: string;
}

export interface InventoryActionResult {
  ok: boolean;
  action: InventoryActionKind;
  error?: string;
  result?: unknown;
}

export async function postInventoryAction(
  req: InventoryActionRequest,
): Promise<InventoryActionResult> {
  const body: Record<string, unknown> = {
    action: req.action,
    sessionId: req.sessionId,
    itemSlug: req.itemSlug,
  };
  if (req.action === 'give') {
    body.npc = req.npc ?? '';
    if (req.quantity != null) body.quantity = req.quantity;
  }
  if (req.action === 'use') {
    if (req.targetLocation) body.targetLocation = req.targetLocation;
    if (req.targetEntity) body.targetEntity = req.targetEntity;
  }
  const r = await fetch(
    `${req.baseUrl ?? ''}/api/player/${req.playerId}/inventory/action`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      credentials: 'include',
      body: JSON.stringify(body),
    },
  );
  let payload: Partial<InventoryActionResult> & {error?: string} = {};
  try {
    payload = (await r.json()) as typeof payload;
  } catch {
    // Server returned no JSON body. The status code below is what
    // the UI keys off, not the payload.
  }
  if (!r.ok || payload.ok === false) {
    return {
      ok: false,
      action: req.action,
      error: payload.error ?? `inventory_action_failed_${r.status}`,
    };
  }
  return {
    ok: true,
    action: req.action,
    result: payload.result ?? null,
  };
}
