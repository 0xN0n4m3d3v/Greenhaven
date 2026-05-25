/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query, type TxClient} from '../db.js';
import {getPlayerCurrencyCopper} from '../services/CurrencyBridgeService.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';
import {sessionManager} from '../sessionManager.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface InventoryDb {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface InventoryItemRef {
  id: number;
  slug: string;
  category: string;
  legacy_entity_id: number | null;
}

export interface EntityInventoryMaterializationInput {
  entityId: number;
  kind: string;
  displayName: string;
  tags?: readonly string[] | null;
  profile?: unknown;
}

export interface EntityInventoryMaterializationResult {
  item_id: number;
  slug: string;
  category: string;
  legacy_entity_id: number | null;
  holder_entity_id: number | null;
  holder_is_player: boolean;
  placed_count: number | null;
  skipped?: string;
}

const ITEM_CATEGORIES = new Set([
  'weapon',
  'armor',
  'consumable',
  'tool',
  'quest',
  'material',
  'currency',
]);

const NON_INVENTORY_ITEM_TAGS = new Set([
  'fixture',
  'obstacle',
  'container',
  'scene_fixture',
  'scenery',
  'decorative',
]);

export async function isPlayerHolder(
  entityId: number,
  db: InventoryDb = {query},
): Promise<boolean> {
  const r = await db.query<{count: number | string}>(
    `SELECT COUNT(*)::int AS count FROM players WHERE entity_id = $1`,
    [entityId],
  );
  return Number(r.rows[0]?.count ?? 0) > 0;
}

export async function resolveInventoryItem(
  item: string | number,
  db: InventoryDb = {query},
  opts: {preferredHolderEntityId?: number | null} = {},
): Promise<InventoryItemRef | null> {
  if (typeof item === 'number') {
    const byId = await db.query<InventoryItemRef>(
      `SELECT id, slug, category, legacy_entity_id
         FROM items
        WHERE id = $1
           OR legacy_entity_id = $1
        LIMIT 1`,
      [item],
    );
    return byId.rows[0] ?? null;
  }

  if (opts.preferredHolderEntityId != null) {
    const held = await db.query<InventoryItemRef>(
      `SELECT i.id,
              i.slug,
              i.category,
              held.item_entity_id AS legacy_entity_id
         FROM items i
         JOIN inventory_entries held
           ON held.holder_entity_id = $2
          AND held.count > 0
         JOIN entities held_item
           ON held_item.id = held.item_entity_id
          AND (
            LOWER(held_item.display_name) = LOWER($1)
            OR i.slug = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(held_item.display_name, '''', '', 'g'), '\\s+', '_', 'g'))
          )
        WHERE i.slug = $1
           OR i.slug = LOWER(REGEXP_REPLACE(REGEXP_REPLACE($1, '''', '', 'g'), '\\s+', '_', 'g'))
        ORDER BY CASE WHEN i.slug = $1 THEN 0 ELSE 1 END,
                 held.item_entity_id DESC
        LIMIT 1`,
      [item, opts.preferredHolderEntityId],
    );
    if (held.rows[0]) return held.rows[0];
  }

  const r = await db.query<InventoryItemRef>(
    `SELECT i.id, i.slug, i.category, i.legacy_entity_id
       FROM items i
       LEFT JOIN entities e ON e.id = i.legacy_entity_id
      WHERE i.slug = $1
         OR i.slug = LOWER(REGEXP_REPLACE(REGEXP_REPLACE($1, '''', '', 'g'), '\\s+', '_', 'g'))
         OR LOWER(e.display_name) = LOWER($1)
      ORDER BY CASE WHEN i.slug = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [item],
  );
  return r.rows[0] ?? null;
}

export function inventorySlugForDisplayName(displayName: string): string {
  return displayName
    .trim()
    .replace(/'/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

export function shouldMaterializeEntityInventoryItem(
  input: EntityInventoryMaterializationInput,
): boolean {
  if (input.kind !== 'item') return false;
  const profile = asRecord(input.profile);
  if (profile['inventory_item'] === false || profile['inventory'] === false) {
    return false;
  }
  const tags = normalizedTagSet(input.tags);
  for (const tag of NON_INVENTORY_ITEM_TAGS) {
    if (tags.has(tag)) return false;
  }
  return true;
}

export async function materializeEntityInventoryItem(
  db: InventoryDb,
  input: EntityInventoryMaterializationInput,
): Promise<EntityInventoryMaterializationResult | null> {
  if (!shouldMaterializeEntityInventoryItem(input)) return null;

  const profile = asRecord(input.profile);
  const tags = normalizedTagSet(input.tags);
  const slug = inventorySlugForDisplayName(input.displayName);
  if (!slug) return null;

  const existing = await db.query<InventoryItemRef>(
    `SELECT id, slug, category, legacy_entity_id
       FROM items
      WHERE legacy_entity_id = $1
      LIMIT 1`,
    [input.entityId],
  );
  const item = existing.rows[0] ?? (await insertInventoryItemForEntity(
    db,
    input,
    profile,
    tags,
    slug,
  ));
  const ledgerEntityId = item.legacy_entity_id ?? input.entityId;

  const holderEntityId =
    readPositiveId(profile['holder_entity_id']) ??
    readPositiveId(profile['home_id']);
  if (holderEntityId == null) {
    return {
      item_id: item.id,
      slug: item.slug,
      category: item.category,
      legacy_entity_id: ledgerEntityId,
      holder_entity_id: null,
      holder_is_player: false,
      placed_count: null,
    };
  }

  const holderIsPlayer = await isPlayerHolder(holderEntityId, db);
  if (holderIsPlayer) {
    return {
      item_id: item.id,
      slug: item.slug,
      category: item.category,
      legacy_entity_id: ledgerEntityId,
      holder_entity_id: holderEntityId,
      holder_is_player: true,
      placed_count: null,
      skipped: 'player_holder_requires_inventory_transfer',
    };
  }

  const count =
    readPositiveInt(profile['count']) ??
    readPositiveInt(profile['quantity']) ??
    1;

  // Defensive: items.legacy_entity_id is the FK target for
  // inventory_entries.item_entity_id. If the items row was authored
  // long ago and the legacy entity has since been deleted/regenerated
  // (cartridge re-import, manual cleanup, etc.), inserting here would
  // raise inventory_entries_item_entity_id_fkey and crash the whole
  // adventure-accept pipeline. Verify the FK targets exist before
  // touching the ledger; skip the insert and return a placeholder
  // result if either side is gone. The item itself is still
  // materialized (items row exists), so the player has the lookup;
  // they just don't have the legacy inventory ledger entry. This
  // keeps quest acceptance moving and surfaces a clear warning.
  const fkCheck = await db.query<{
    holder_exists: boolean;
    item_exists: boolean;
  }>(
    `SELECT
       EXISTS(SELECT 1 FROM entities WHERE id = $1) AS holder_exists,
       EXISTS(SELECT 1 FROM entities WHERE id = $2) AS item_exists`,
    [holderEntityId, ledgerEntityId],
  );
  const row = fkCheck.rows[0];
  if (!row?.holder_exists || !row?.item_exists) {
    console.warn(
      `[inventoryCommon] skipping inventory_entries insert: ` +
        `holder=${holderEntityId}(exists=${row?.holder_exists ?? false}) ` +
        `item=${ledgerEntityId}(exists=${row?.item_exists ?? false}). ` +
        `Likely a stale items.legacy_entity_id reference; the items row is ` +
        `preserved but no ledger entry was added.`,
    );
    return {
      item_id: item.id,
      slug: item.slug,
      category: item.category,
      legacy_entity_id: ledgerEntityId,
      holder_entity_id: holderEntityId,
      holder_is_player: false,
      placed_count: null,
      skipped: 'fk_target_missing',
    };
  }

  await db.query(
    `INSERT INTO inventory_entries
       (holder_entity_id, item_entity_id, count, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (holder_entity_id, item_entity_id)
     DO UPDATE SET
       count = GREATEST(inventory_entries.count, EXCLUDED.count),
       metadata = COALESCE(inventory_entries.metadata, '{}'::jsonb) ||
                  COALESCE(EXCLUDED.metadata, '{}'::jsonb)`,
    [
      holderEntityId,
      ledgerEntityId,
      count,
      JSON.stringify({source: 'create_entity_materialization'}),
    ],
  );

  return {
    item_id: item.id,
    slug: item.slug,
    category: item.category,
    legacy_entity_id: ledgerEntityId,
    holder_entity_id: holderEntityId,
    holder_is_player: false,
    placed_count: count,
  };
}

async function insertInventoryItemForEntity(
  db: InventoryDb,
  input: EntityInventoryMaterializationInput,
  profile: Record<string, unknown>,
  tags: Set<string>,
  slug: string,
): Promise<InventoryItemRef> {
  const category = inventoryCategory(profile, tags);
  const stackable =
    readBoolean(profile['stackable']) ??
    (category === 'currency' ||
      category === 'consumable' ||
      category === 'material');
  const maxStack =
    readPositiveInt(profile['max_stack']) ??
    (category === 'currency' ? 9999 : stackable ? 99 : 1);
  const behaviour = asRecord(profile['behaviour']);
  const behaviourJson =
    Object.keys(behaviour).length > 0 ? behaviour : sanitizeItemBehaviour(profile);

  const inserted = await db.query<InventoryItemRef>(
    `INSERT INTO items
       (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (slug)
     DO UPDATE SET
       legacy_entity_id =
         CASE
           WHEN items.legacy_entity_id IS NULL THEN EXCLUDED.legacy_entity_id
           ELSE items.legacy_entity_id
         END
     RETURNING id, slug, category, legacy_entity_id`,
    [
      slug,
      category,
      readNumber(profile['weight_kg']) ?? 0,
      stackable,
      maxStack,
      JSON.stringify(behaviourJson),
      input.entityId,
    ],
  );
  return inserted.rows[0]!;
}

function inventoryCategory(
  profile: Record<string, unknown>,
  tags: Set<string>,
): string {
  const requested = readText(profile['category']);
  if (requested && ITEM_CATEGORIES.has(requested)) return requested;
  if (tags.has('currency')) return 'currency';
  if (tags.has('consumable')) return 'consumable';
  if (tags.has('weapon')) return 'weapon';
  if (tags.has('armor')) return 'armor';
  if (
    tags.has('quest') ||
    tags.has('quest_hook') ||
    tags.has('quest-item') ||
    tags.has('quest_item') ||
    tags.has('quest-reward') ||
    tags.has('quest_reward')
  ) {
    return 'quest';
  }
  if (tags.has('material')) return 'material';
  return 'tool';
}

function sanitizeItemBehaviour(
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'applies_surface',
    'radius',
    'duration_turns',
    'effect',
    'amount',
    'damage_die',
    'damage_type',
    'degrades_on_use',
  ]) {
    if (profile[key] !== undefined) out[key] = profile[key];
  }
  return out;
}

function normalizedTagSet(tags: readonly string[] | null | undefined): Set<string> {
  return new Set(
    (tags ?? [])
      .map(tag => tag.trim().toLowerCase())
      .filter(Boolean),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPositiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readPositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function ensureLegacyEntityForItem(
  client: TxClient,
  item: InventoryItemRef,
): Promise<number> {
  if (item.legacy_entity_id != null) return item.legacy_entity_id;
  const displayName = item.slug
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  // ARCH-19 Phase 4 (migration 0124) — the legacy mirror is a
  // runtime artifact created on demand for inventory_item rows that
  // predate the entity table. Mark `dynamic_origin = true` so the
  // row-level CHECK admits it without a cartridge_id (the inventory
  // catalogue, not a cartridge, owns these mirrors).
  const inserted = await client.query<{id: number}>(
    `INSERT INTO entities (kind, display_name, summary, profile, tags, dynamic_origin)
     VALUES (
       'item',
       $1,
       'Inventory mirror for item slug ' || $2,
       $3::jsonb,
       $4,
       TRUE
     )
     RETURNING id`,
    [
      displayName || item.slug,
      item.slug,
      JSON.stringify({inventory_item_slug: item.slug}),
      ['item', 'inventory', item.category],
    ],
  );
  const legacyId = inserted.rows[0]!.id;
  await client.query(
    `UPDATE items
        SET legacy_entity_id = $2
      WHERE id = $1 AND legacy_entity_id IS NULL`,
    [item.id, legacyId],
  );
  return legacyId;
}

export async function decrementPlayerItem(
  client: TxClient,
  playerId: number,
  itemId: number,
  count: number,
): Promise<number> {
  const selected = await client.query<{id: number; quantity: number}>(
    `SELECT id, quantity
       FROM player_inventory
      WHERE player_id = $1
        AND item_id = $2
        AND equipped = false
        AND quantity >= $3
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE`,
    [playerId, itemId, count],
  );
  const row = selected.rows[0];
  if (!row) throw new Error('insufficient player inventory');
  const remaining = row.quantity - count;
  if (remaining === 0) {
    await client.query(`DELETE FROM player_inventory WHERE id = $1`, [row.id]);
  } else {
    await client.query(
      `UPDATE player_inventory
          SET quantity = $2
        WHERE id = $1`,
      [row.id, remaining],
    );
  }
  return remaining;
}

export async function incrementPlayerItem(
  client: TxClient,
  playerId: number,
  itemId: number,
  count: number,
): Promise<void> {
  await client.query(
    `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (player_id, item_id) WHERE equipped = false
     DO UPDATE SET quantity = player_inventory.quantity + EXCLUDED.quantity`,
    [playerId, itemId, count],
  );
}

export async function decrementLegacyItem(
  client: TxClient,
  holderId: number,
  legacyItemId: number,
  count: number,
  opts: {strict: boolean},
): Promise<void> {
  const r = await client.query<{count: number}>(
    `UPDATE inventory_entries
        SET count = count - $3
      WHERE holder_entity_id = $1
        AND item_entity_id = $2
        AND count >= $3
      RETURNING count`,
    [holderId, legacyItemId, count],
  );
  if (r.rows.length === 0) {
    if (opts.strict) throw new Error('insufficient legacy inventory');
    return;
  }
  if (r.rows[0]!.count === 0) {
    await client.query(
      `DELETE FROM inventory_entries
        WHERE holder_entity_id = $1 AND item_entity_id = $2`,
      [holderId, legacyItemId],
    );
  }
}

export async function incrementLegacyItem(
  client: TxClient,
  holderId: number,
  legacyItemId: number,
  count: number,
): Promise<void> {
  await client.query(
    `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count)
     VALUES ($1, $2, $3)
     ON CONFLICT (holder_entity_id, item_entity_id)
     DO UPDATE SET count = inventory_entries.count + EXCLUDED.count`,
    [holderId, legacyItemId, count],
  );
}

export async function getPlayerItemQuantity(
  playerId: number,
  itemId: number,
  db: InventoryDb = {query},
): Promise<number> {
  const r = await db.query<{quantity: number | string}>(
    `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
       FROM player_inventory
      WHERE player_id = $1 AND item_id = $2`,
    [playerId, itemId],
  );
  return Number(r.rows[0]?.quantity ?? 0);
}

/**
 * Canonical copper-unit total for a player's currency.
 *
 * OWV-17: routes through `CurrencyBridgeService` so multi-denomination
 * cartridges (gold/silver/copper) report `quantity * copper_value`
 * summed per coin. Single-currency seeds keep their old semantics
 * because the fallback `copperValue` is `1`, so the answer collapses
 * to `SUM(quantity)` for those projects.
 *
 * `_db` is accepted for backward compatibility — the bridge service
 * uses the AsyncLocalStorage-bound `query()` directly so it always
 * routes through the active transaction.
 */
export async function getPlayerCurrencyCount(
  playerId: number,
  _db: InventoryDb = {query},
): Promise<number> {
  const cartridgeId = await resolveActivePlayerCartridgeId(playerId);
  return getPlayerCurrencyCopper(playerId, {cartridgeId});
}

export async function emitPlayerInventoryEvents(
  sessionId: string,
  players: number | number[],
  item: InventoryItemRef,
): Promise<void> {
  const session = sessionManager.get(sessionId);
  if (!session) return;
  const playerIds = Array.isArray(players) ? players : [players];
  const uniquePlayers = [...new Set(playerIds)];
  for (const playerId of uniquePlayers) {
    // SSE-OK: emit outside tx (reason: the inventory write that
    // motivated this notification was already committed by the
    // caller; SseBridge.emit auto-defers via onTransactionCommit
    // when nested in withTransaction).
    session.sse.emit('inventory:changed', {
      playerId,
      item: item.slug,
      itemId: item.id,
      category: item.category,
      quantity: await getPlayerItemQuantity(playerId, item.id),
    });
    if (item.category === 'currency') {
      // SSE-OK: emit outside tx (reason: the inventory write
      // for the currency item already committed; SseBridge.emit
      // auto-defers via onTransactionCommit when nested in
      // withTransaction).
      session.sse.emit('currency:changed', {
        playerId,
        count: await getPlayerCurrencyCount(playerId),
      });
    }
  }
}
