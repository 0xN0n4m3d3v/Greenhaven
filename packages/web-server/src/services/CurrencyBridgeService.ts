/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — currency runtime read layer.
//
// Bridges the generated `forge_currency_bridge` cartridge_meta document
// (produced by `exportGrinhavenSql` in `packages/cartridge-forge`) with
// the runtime `items` catalog so callers can:
//
//   * see authored coin denominations + their copper values without
//     hardcoding gold/silver/copper ids;
//   * compute a player or holder balance broken down per coin plus a
//     canonical `total_copper`;
//   * survive cartridges that predate the bridge — projects with no
//     `forge_currency_bridge` row still get a one-coin catalog (every
//     `items.category = 'currency'` row, `copper_value` defaulting to
//     1) so old single-currency behaviour is preserved exactly.
//
// This module is intentionally read-only. Merchant debits, currency
// grants, change-making, and inventory mutation continue to live in
// `tools/inventory*.ts`. The next OWV-17 slice that needs to touch
// balances will route through this service for its catalog/lookups.

import {query} from '../db.js';
import {bridgeCacheKey, readScopedBridgeMeta} from './scopedBridgeMeta.js';

const BRIDGE_META_KEY = 'forge_currency_bridge';
const BRIDGE_SCHEMA_VERSION = 'greenhaven.currency_rates.v1';

export interface CurrencyBridgeOptions {
  /** Active cartridge id. Threaded by callers that resolve player
   *  scope (`resolveActivePlayerCartridgeId`) so the catalog comes
   *  from `cartridge_meta_scoped` for that cartridge. Omit for
   *  legacy / scriptless callers — the service falls back to the
   *  global `cartridge_meta` row in that case. */
  cartridgeId?: string | null;
}

/** One denomination in the authored currency catalog. */
export interface CurrencyCoin {
  /** Numeric `items.id`. Stable across re-exports because
   *  `legacy_entity_id` keeps the entities row, which keeps the
   *  items row anchored. */
  itemId: number;
  /** `items.slug` (e.g. `copper-coin`). */
  slug: string;
  /** `items.legacy_entity_id` — joins onto the legacy
   *  `inventory_entries.item_entity_id` ledger. `null` when the
   *  item has never been linked to a cartridge entity. */
  legacyEntityId: number | null;
  /** Canonical `@Mention` from the authored vault note (e.g.
   *  `@Copper coin`). `null` when neither the bridge meta nor the
   *  items.behaviour blob records a mention. */
  mention: string | null;
  /** Value of one coin in copper units. Always a positive integer;
   *  falls back to `1` when the bridge is missing/malformed and the
   *  items.behaviour blob does not carry a `copper_value`. */
  copperValue: number;
  /** Authored note path (vault-relative). `null` when no bridge
   *  is wired. */
  sourcePath: string | null;
  /** `true` when this coin was supplied by the
   *  `forge_currency_bridge` meta document; `false` when the
   *  service synthesised a fallback row from a stray
   *  `items.category = 'currency'` entry (legacy cartridges,
   *  ad-hoc seeds). Canonical decomposition for merchant credit
   *  and player change uses only bridge-backed coins. */
  bridgeBacked: boolean;
}

/** Per-coin breakdown for one player/holder. */
export interface CurrencyBalanceCoin extends CurrencyCoin {
  /** Quantity of this coin currently held. `0` when the catalog
   *  knows the coin but the holder has none — surfacing zero rows
   *  keeps UI/tool clients from having to merge catalog + balance
   *  themselves. */
  quantity: number;
  /** `quantity * copperValue`. Always a non-negative integer. */
  subtotalCopper: number;
}

/** Holder-agnostic balance shape. */
export interface CurrencyBalance {
  totalCopper: number;
  coins: CurrencyBalanceCoin[];
  /** `true` when `cartridge_meta.forge_currency_bridge` exists and
   *  parsed; `false` when the service is operating in the
   *  single-currency fallback path. */
  bridgeAvailable: boolean;
}

/** The full denomination catalog. Cached at module scope so the
 *  every-tool/every-snapshot call path doesn't re-hit `getMeta` or
 *  the items SELECT. Call `clearCurrencyCatalogCache()` on cartridge
 *  swap or in tests that intentionally rewrite the bridge meta. */
export interface CurrencyCatalog {
  coins: CurrencyCoin[];
  byItemId: Map<number, CurrencyCoin>;
  bridgeAvailable: boolean;
}

interface RawBridgeMeta {
  schema_version?: unknown;
  source_project?: unknown;
  coins?: unknown;
}

interface RawBridgeCoin {
  slug?: unknown;
  mention?: unknown;
  copper_value?: unknown;
  source_path?: unknown;
}

interface ItemRow {
  id: number | string;
  slug: string;
  legacy_entity_id: number | string | null;
  behaviour: Record<string, unknown> | null;
}

interface BalanceRow {
  item_id: number | string;
  quantity: number | string;
}

const cachedCatalogByScope = new Map<string, Promise<CurrencyCatalog>>();

export async function getCurrencyCatalog(
  opts?: CurrencyBridgeOptions,
): Promise<CurrencyCatalog> {
  const cacheKey = bridgeCacheKey(opts?.cartridgeId);
  const existing = cachedCatalogByScope.get(cacheKey);
  if (existing) return existing;
  const promise = loadCatalog(opts?.cartridgeId ?? null).catch(err => {
    cachedCatalogByScope.delete(cacheKey);
    throw err;
  });
  cachedCatalogByScope.set(cacheKey, promise);
  return promise;
}

export function clearCurrencyCatalogCache(): void {
  cachedCatalogByScope.clear();
}

async function loadCatalog(
  cartridgeId: string | null,
): Promise<CurrencyCatalog> {
  const [meta, itemsResult] = await Promise.all([
    readScopedBridgeMeta<RawBridgeMeta>(BRIDGE_META_KEY, {cartridgeId}),
    query<ItemRow>(
      `SELECT id, slug, legacy_entity_id, behaviour
         FROM items
        WHERE category = 'currency'`,
    ),
  ]);
  const bySlug = new Map<string, ItemRow>();
  for (const row of itemsResult.rows) bySlug.set(row.slug, row);

  const bridgeCoins = parseBridgeCoins(meta);
  const bridgeAvailable = bridgeCoins.length > 0;

  const seen = new Set<number>();
  const coins: CurrencyCoin[] = [];

  if (bridgeAvailable) {
    for (const raw of bridgeCoins) {
      const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
      if (!slug) continue;
      const item = bySlug.get(slug);
      if (!item) continue;
      const itemId = Number(item.id);
      seen.add(itemId);
      coins.push({
        itemId,
        slug: item.slug,
        legacyEntityId:
          item.legacy_entity_id == null ? null : Number(item.legacy_entity_id),
        mention: pickMention(raw.mention, item.behaviour),
        copperValue: pickCopperValue(raw.copper_value, item.behaviour),
        sourcePath: typeof raw.source_path === 'string' ? raw.source_path : null,
        bridgeBacked: true,
      });
    }
  }

  // Fallback / completion: every currency item not yet covered by
  // the bridge gets a row so cartridges that predate the bridge or
  // mix authored + ad-hoc currency rows still see every coin. Old
  // single-currency seeds (no behaviour.copper_value, no bridge)
  // therefore keep their `copperValue = 1` semantics — the previous
  // `currency.count = SUM(quantity)` behaviour collapses exactly to
  // `totalCopper` for those projects.
  for (const item of itemsResult.rows) {
    const itemId = Number(item.id);
    if (seen.has(itemId)) continue;
    coins.push({
      itemId,
      slug: item.slug,
      legacyEntityId:
        item.legacy_entity_id == null ? null : Number(item.legacy_entity_id),
      mention: pickMention(undefined, item.behaviour),
      copperValue: pickCopperValue(undefined, item.behaviour),
      sourcePath: null,
      bridgeBacked: false,
    });
  }

  coins.sort(
    (a, b) =>
      a.copperValue - b.copperValue || a.slug.localeCompare(b.slug),
  );

  const byItemId = new Map<number, CurrencyCoin>();
  for (const coin of coins) byItemId.set(coin.itemId, coin);
  return {coins, byItemId, bridgeAvailable};
}

function parseBridgeCoins(meta: RawBridgeMeta | undefined): RawBridgeCoin[] {
  if (!meta || typeof meta !== 'object') return [];
  if (meta.schema_version !== BRIDGE_SCHEMA_VERSION) return [];
  if (!Array.isArray(meta.coins)) return [];
  const out: RawBridgeCoin[] = [];
  for (const coin of meta.coins) {
    if (coin && typeof coin === 'object') out.push(coin as RawBridgeCoin);
  }
  return out;
}

function pickCopperValue(
  raw: unknown,
  behaviour: Record<string, unknown> | null,
): number {
  const fromMeta = coerceCopper(raw);
  if (fromMeta != null) return fromMeta;
  const fromBehaviour = coerceCopper(behaviour?.['copper_value']);
  if (fromBehaviour != null) return fromBehaviour;
  return 1;
}

function coerceCopper(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const truncated = Math.trunc(n);
  return truncated > 0 ? truncated : null;
}

function pickMention(
  raw: unknown,
  behaviour: Record<string, unknown> | null,
): string | null {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  const fromBehaviour = behaviour?.['canonical_mention'];
  if (typeof fromBehaviour === 'string' && fromBehaviour.trim()) {
    return fromBehaviour.trim();
  }
  return null;
}

export async function getPlayerCurrencyBalance(
  playerId: number,
  opts?: CurrencyBridgeOptions,
): Promise<CurrencyBalance> {
  const catalog = await getCurrencyCatalog(opts);
  if (catalog.coins.length === 0) {
    return emptyBalance(catalog);
  }
  const rows = await query<BalanceRow>(
    `SELECT pi.item_id, COALESCE(SUM(pi.quantity), 0)::int AS quantity
       FROM player_inventory pi
       JOIN items i ON i.id = pi.item_id
      WHERE pi.player_id = $1
        AND i.category = 'currency'
      GROUP BY pi.item_id`,
    [playerId],
  );
  return mergeQuantities(catalog, rows.rows);
}

export async function getHolderCurrencyBalance(
  holderEntityId: number,
  opts?: CurrencyBridgeOptions,
): Promise<CurrencyBalance> {
  const catalog = await getCurrencyCatalog(opts);
  if (catalog.coins.length === 0) {
    return emptyBalance(catalog);
  }
  const rows = await query<BalanceRow>(
    `SELECT i.id AS item_id, COALESCE(SUM(ie.count), 0)::int AS quantity
       FROM inventory_entries ie
       JOIN items i ON i.legacy_entity_id = ie.item_entity_id
      WHERE ie.holder_entity_id = $1
        AND i.category = 'currency'
        AND ie.count > 0
      GROUP BY i.id`,
    [holderEntityId],
  );
  return mergeQuantities(catalog, rows.rows);
}

function mergeQuantities(
  catalog: CurrencyCatalog,
  rows: BalanceRow[],
): CurrencyBalance {
  const byItemId = new Map<number, number>();
  for (const row of rows) {
    byItemId.set(Number(row.item_id), Number(row.quantity));
  }
  const coins: CurrencyBalanceCoin[] = [];
  let totalCopper = 0;
  for (const coin of catalog.coins) {
    const quantity = byItemId.get(coin.itemId) ?? 0;
    const subtotal = quantity * coin.copperValue;
    coins.push({...coin, quantity, subtotalCopper: subtotal});
    totalCopper += subtotal;
  }
  return {totalCopper, coins, bridgeAvailable: catalog.bridgeAvailable};
}

function emptyBalance(catalog: CurrencyCatalog): CurrencyBalance {
  return {
    totalCopper: 0,
    coins: [],
    bridgeAvailable: catalog.bridgeAvailable,
  };
}

/** Convenience: copper-unit total only, for callers that don't need
 *  the per-coin breakdown (e.g. the SSE `currency:changed` payload).
 */
export async function getPlayerCurrencyCopper(
  playerId: number,
  opts?: CurrencyBridgeOptions,
): Promise<number> {
  const balance = await getPlayerCurrencyBalance(playerId, opts);
  return balance.totalCopper;
}
