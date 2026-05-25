/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-INV-1 — server-owned Inventory read model.
//
// Returns a stable DTO consumed by `GET /api/player/:id/inventory`
// and the `useInventorySnapshot` web-UI hook. Reconciles two
// parallel inventory tables:
//
//   * `player_inventory` (migration 0038): the structured surface.
//     One row per (player, item, equipped-state); `quantity` for
//     stackable categories; `equipped` + `equipped_slot` for
//     weapons / armor.
//   * `inventory_entries` (migration 0001): the legacy
//     entity-based table. `(holder_entity_id, item_entity_id,
//     count, metadata)` — used by older world content + the
//     entity-card import path, and still authoritative for
//     entity-flavored items the cartridge author wired up.
//
// The read service unions both into one DTO without rewriting
// either side. Currency is summarized as a single bag-wide count
// (sum of every `items.category = 'currency'` row in
// `player_inventory`) so the existing `/api/player/currency`
// endpoint and the UI badge keep matching.
//
// This file is read-only. Mutation paths (`use`, `equip`,
// `give`, `drop`) stay in `tools/inventory*.ts` for the next
// FEAT-INV-1 slice.

import {query} from '../db.js';
import {
  getPlayerCurrencyBalance,
  type CurrencyBalanceCoin,
} from './CurrencyBridgeService.js';
import {resolveActivePlayerCartridgeId} from './CartridgePlaythroughService.js';

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
  /** Stable id the UI can key off — `pi:<player_inventory.id>`
   *  for structured rows, `ie:<holder>:<item_entity>` for legacy
   *  entity rows. Composite-source ids keep React keys stable
   *  even when the two tables disagree on a synthetic numeric
   *  surrogate. */
  id: string;
  /** Numeric id of the row inside its source table; null for
   *  legacy entity entries whose primary key is composite. */
  rowId: number | null;
  /** `'player_inventory'` or `'inventory_entries'` — debug-grade
   *  signal for client diagnostics. The UI does not branch on it
   *  beyond labelling the data origin in the item-detail panel. */
  source: 'player_inventory' | 'inventory_entries';
  /** Stable slug for the modern items table; `null` for legacy
   *  entity-only items (the entity's display_name is canonical
   *  there). */
  slug: string | null;
  /** Display name resolved via the structured `items.slug` →
   *  entities mapping when available, else the legacy entity's
   *  `display_name`, else a humanised slug. */
  name: string;
  /** Optional summary copied from the underlying entity (legacy
   *  rows) or item-meta (structured rows). */
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
  /** Free-form attributes the inventory broker can store under
   *  `player_inventory.meta` (structured) or
   *  `inventory_entries.metadata` (legacy). Surfaced as-is so
   *  the item-detail panel can render simple key/value rows. */
  attributes: Record<string, unknown>;
}

export interface InventoryCurrency {
  /**
   * Player wealth in canonical copper units. OWV-17: when the
   * cartridge ships a `forge_currency_bridge` meta document, this
   * is the sum of `quantity * copper_value` across every
   * `items.category = 'currency'` row. Single-currency cartridges
   * (no bridge, no `behaviour.copper_value`) keep their pre-bridge
   * semantics because the fallback `copperValue` is 1 — so the
   * total still equals the simple coin count.
   */
  count: number;
  /** Per-denomination breakdown. Empty when no currency rows are
   *  defined. Always sorted ascending by `copperValue` then slug. */
  coins: CurrencyBalanceCoin[];
  /** `true` when the read came from a parsed
   *  `forge_currency_bridge` meta document; `false` when the
   *  service is in the single-currency fallback path. */
  bridgeAvailable: boolean;
}

export interface InventoryTotals {
  itemCount: number;
  uniqueItems: number;
  weightKg: number;
  equippedCount: number;
}

export interface InventorySnapshot {
  playerId: number;
  currency: InventoryCurrency;
  equipment: InventoryItem[];
  items: InventoryItem[];
  totals: InventoryTotals;
}

interface StructuredRow {
  pi_id: number;
  player_id: number | string;
  item_id: number;
  quantity: number;
  equipped: boolean;
  equipped_slot: string | null;
  meta: Record<string, unknown> | null;
  slug: string;
  category: string;
  weight_kg: number | string;
  stackable: boolean;
  rarity: string | null;
  icon_key: string | null;
  entity_display_name: string | null;
  entity_summary: string | null;
  entity_profile: Record<string, unknown> | null;
}

interface LegacyRow {
  holder_entity_id: number | string;
  item_entity_id: number | string;
  count: number;
  metadata: Record<string, unknown> | null;
  display_name: string | null;
  summary: string | null;
  kind: string | null;
  profile: Record<string, unknown> | null;
}

function asCategory(raw: string | null | undefined): InventoryCategory {
  switch ((raw ?? '').toLowerCase()) {
    case 'weapon':
    case 'armor':
    case 'consumable':
    case 'tool':
    case 'quest':
    case 'material':
    case 'currency':
      return raw as InventoryCategory;
    default:
      return 'misc';
  }
}

function humaniseSlug(slug: string): string {
  return slug
    .split(/[_\-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function categorizeLegacy(
  kind: string | null,
  profile: Record<string, unknown> | null,
): InventoryCategory {
  if (kind === 'currency') return 'currency';
  if (kind === 'weapon' || kind === 'armor' || kind === 'consumable')
    return kind as InventoryCategory;
  const profileKind = profile?.['item_kind'];
  if (typeof profileKind === 'string') return asCategory(profileKind);
  if (kind === 'item') return 'misc';
  return 'misc';
}

function mergeAttributes(
  base: Record<string, unknown> | null,
  extra: Record<string, unknown> | null,
): Record<string, unknown> {
  return {...(base ?? {}), ...(extra ?? {})};
}

function readVisualAssetUrl(
  profile: Record<string, unknown> | null | undefined,
  role: string,
): string | null {
  const raw = profile?.['visual_asset_urls'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[role];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export class InventoryReadService {
  /**
   * Build the inventory snapshot for `playerId`. The optional
   * `language` argument is accepted so the bridge can pass the UI
   * locale through; it is not consumed by this slice (display
   * names today come straight from `entities.display_name`),
   * but it pins the route contract so a future cartridge-i18n
   * pass can plug a translation table in without changing the
   * fetch shape.
   */
  static async snapshot(
    playerId: number,
    _language?: string | null,
  ): Promise<InventorySnapshot> {
    const structured = await query<StructuredRow>(
      `SELECT pi.id AS pi_id,
              pi.player_id,
              pi.item_id,
              pi.quantity,
              pi.equipped,
              pi.equipped_slot,
              pi.meta,
              i.slug,
              i.category,
              i.weight_kg,
              i.stackable,
              i.rarity,
              i.icon_key,
              e.display_name AS entity_display_name,
              e.summary      AS entity_summary,
              e.profile      AS entity_profile
         FROM player_inventory pi
         JOIN items i ON i.id = pi.item_id
         LEFT JOIN entities e ON e.id = ((pi.meta ->> 'entity_id')::bigint)
        WHERE pi.player_id = $1
        ORDER BY pi.id ASC`,
      [playerId],
    );

    const legacy = await query<LegacyRow>(
      `SELECT ie.holder_entity_id,
              ie.item_entity_id,
              ie.count,
              ie.metadata,
              e.display_name,
              e.summary,
              e.kind,
              e.profile
         FROM inventory_entries ie
         JOIN entities e ON e.id = ie.item_entity_id
        WHERE ie.holder_entity_id = $1
          AND ie.count > 0
        ORDER BY ie.item_entity_id ASC`,
      [playerId],
    );

    const all: InventoryItem[] = [];

    for (const row of structured.rows) {
      const category = asCategory(row.category);
      const quantity = Number(row.quantity);
      if (category === 'currency') {
        // Currency does not surface as a bag row — the UI shows
        // its dedicated `currency.count` badge instead. The
        // copper-unit total is computed via `CurrencyBridgeService`
        // below so it honours multi-denomination cartridges.
        continue;
      }
      const name =
        row.entity_display_name?.trim() ||
        humaniseSlug(row.slug);
      all.push({
        id: `pi:${row.pi_id}`,
        rowId: Number(row.pi_id),
        source: 'player_inventory',
        slug: row.slug,
        name,
        summary: row.entity_summary,
        category,
        quantity,
        stackable: row.stackable,
        weightKg: Number(row.weight_kg),
        rarity: row.rarity,
        iconKey: row.icon_key,
        iconUrl: readVisualAssetUrl(row.entity_profile, 'item_icon'),
        equipped: row.equipped,
        equippedSlot: row.equipped_slot,
        attributes: row.meta ?? {},
      });
    }

    for (const row of legacy.rows) {
      const category = categorizeLegacy(row.kind, row.profile);
      const count = Number(row.count);
      if (category === 'currency') {
        // Legacy currency rows are folded into the canonical
        // copper-unit total via `CurrencyBridgeService` below; they
        // never surface as bag rows.
        continue;
      }
      const name =
        row.display_name?.trim() ||
        humaniseSlug(String(row.item_entity_id));
      all.push({
        id: `ie:${row.holder_entity_id}:${row.item_entity_id}`,
        rowId: null,
        source: 'inventory_entries',
        slug: null,
        name,
        summary: row.summary,
        category,
        quantity: count,
        stackable: count > 1,
        weightKg: 0,
        rarity: null,
        iconKey: null,
        iconUrl: readVisualAssetUrl(row.profile, 'item_icon'),
        equipped: false,
        equippedSlot: null,
        attributes: mergeAttributes(row.profile, row.metadata),
      });
    }

    const equipment = all
      .filter((item) => item.equipped)
      .sort((a, b) => a.name.localeCompare(b.name));
    const items = all.sort((a, b) => {
      // Equipped first (badge sorting), then by name. The UI
      // re-sorts as needed for filters; this is the canonical
      // stable order.
      if (a.equipped !== b.equipped) return a.equipped ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const weightKg = all.reduce(
      (sum, item) => sum + item.weightKg * item.quantity,
      0,
    );
    const totals: InventoryTotals = {
      itemCount: all.reduce((sum, item) => sum + item.quantity, 0),
      uniqueItems: all.length,
      weightKg: Number(weightKg.toFixed(2)),
      equippedCount: equipment.length,
    };

    const cartridgeId = await resolveActivePlayerCartridgeId(playerId);
    const balance = await getPlayerCurrencyBalance(playerId, {cartridgeId});
    return {
      playerId,
      currency: {
        count: balance.totalCopper,
        coins: balance.coins,
        bridgeAvailable: balance.bridgeAvailable,
      },
      equipment,
      items,
      totals,
    };
  }
}
