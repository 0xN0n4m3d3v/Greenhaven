/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — merchant runtime read layer.
//
// Bridges the generated `forge_merchant_contracts` cartridge_meta
// document (produced by `exportGrinhavenSql`) with the currency
// catalog so callers can:
//
//   * list authored offers for a merchant slug;
//   * resolve one offer by `merchant` + `offer_id` into a fully
//     prepared payment plan with coin item ids;
//   * recover gracefully when the bridge meta is missing — the
//     catalog stays empty and lookups return `null` instead of
//     fabricating offers.
//
// This module is read-only. The actual debit/credit + memory write
// lives in `tools/merchant.ts` so payment flow stays one
// `withTransaction` block under the broker tool registry.

import {query} from '../db.js';
import {getCurrencyCatalog, type CurrencyCoin} from './CurrencyBridgeService.js';
import {bridgeCacheKey, readScopedBridgeMeta} from './scopedBridgeMeta.js';

const BRIDGE_META_KEY = 'forge_merchant_contracts';
const BRIDGE_SCHEMA_VERSION = 'greenhaven.merchant_contracts.v1';

export interface MerchantBridgeOptions {
  /** Active cartridge id. Threaded by callers that resolve player
   *  scope so the catalog comes from `cartridge_meta_scoped` for
   *  that cartridge. Omit for legacy / scriptless callers — the
   *  service falls back to the global `cartridge_meta` row. */
  cartridgeId?: string | null;
}

export interface MerchantOfferRequirement {
  /** Authored coin mention (e.g. `@Silver coin`). */
  coin: string;
  /** Coin item id from the runtime `items` catalog. `null` when the
   *  coin mention does not resolve through the currency bridge —
   *  callers reject the offer in that case. */
  itemId: number | null;
  /** `items.legacy_entity_id` for the coin. `null` when the
   *  currency item has never been linked. */
  legacyEntityId: number | null;
  /** Copper-unit value of one coin (from the currency catalog).
   *  Falls back to `1` for non-bridge cartridges. */
  copperValue: number;
  /** Required quantity of this denomination. */
  amount: number;
}

export interface MerchantOffer {
  offerId: string;
  merchantSlug: string;
  merchantMention: string;
  /** Entity id of the merchant, resolved by `source_slug` lookup
   *  on `entities.profile->>'source_slug'`. `null` when no entity
   *  carries that slug yet — callers reject the offer in that
   *  case. */
  merchantEntityId: number | null;
  sourcePath: string;
  line: string;
  copperTotal: number;
  requirements: MerchantOfferRequirement[];
}

interface RawBridgeMeta {
  schema_version?: unknown;
  source_project?: unknown;
  offers?: unknown;
}

interface RawBridgeOffer {
  offer_id?: unknown;
  source_slug?: unknown;
  source_mention?: unknown;
  source_path?: unknown;
  line?: unknown;
  coins?: unknown;
  copper_value?: unknown;
}

interface RawBridgeCoin {
  coin?: unknown;
  amount?: unknown;
}

interface BuiltCatalog {
  bySlug: Map<string, MerchantOffer[]>;
  byOfferId: Map<string, MerchantOffer>;
  bridgeAvailable: boolean;
}

const cachedCatalogByScope = new Map<string, Promise<BuiltCatalog>>();

export function clearMerchantContractsCache(): void {
  cachedCatalogByScope.clear();
}

export async function listMerchantOffers(
  merchantSlug: string,
  opts?: MerchantBridgeOptions,
): Promise<MerchantOffer[]> {
  const catalog = await getMerchantCatalog(opts);
  return catalog.bySlug.get(merchantSlug.trim().toLowerCase()) ?? [];
}

export async function findMerchantOffer(
  merchantSlug: string,
  offerId: string,
  opts?: MerchantBridgeOptions,
): Promise<MerchantOffer | null> {
  const catalog = await getMerchantCatalog(opts);
  const slug = merchantSlug.trim().toLowerCase();
  const id = offerId.trim();
  if (!slug || !id) return null;
  const offer = catalog.byOfferId.get(`${slug}|${id}`);
  return offer ?? null;
}

export async function isMerchantBridgeAvailable(
  opts?: MerchantBridgeOptions,
): Promise<boolean> {
  return (await getMerchantCatalog(opts)).bridgeAvailable;
}

async function getMerchantCatalog(
  opts?: MerchantBridgeOptions,
): Promise<BuiltCatalog> {
  const cacheKey = bridgeCacheKey(opts?.cartridgeId);
  const existing = cachedCatalogByScope.get(cacheKey);
  if (existing) return existing;
  const promise = buildCatalog(opts?.cartridgeId ?? null).catch(err => {
    cachedCatalogByScope.delete(cacheKey);
    throw err;
  });
  cachedCatalogByScope.set(cacheKey, promise);
  return promise;
}

async function buildCatalog(
  cartridgeId: string | null,
): Promise<BuiltCatalog> {
  const [meta, currency] = await Promise.all([
    readScopedBridgeMeta<RawBridgeMeta>(BRIDGE_META_KEY, {cartridgeId}),
    getCurrencyCatalog({cartridgeId}),
  ]);
  const offers = parseOffers(meta);
  if (offers.length === 0) {
    return {bySlug: new Map(), byOfferId: new Map(), bridgeAvailable: false};
  }
  const coinByMention = buildCoinByMention(currency.coins);
  const merchantEntityIds = await resolveMerchantEntities(
    Array.from(new Set(offers.map(o => o.source_slug))),
    cartridgeId,
  );
  const bySlug = new Map<string, MerchantOffer[]>();
  const byOfferId = new Map<string, MerchantOffer>();
  for (const raw of offers) {
    const merchantSlug = raw.source_slug;
    const requirements = raw.coins.map(c => coinToRequirement(c, coinByMention));
    const offer: MerchantOffer = {
      offerId: raw.offer_id,
      merchantSlug,
      merchantMention: raw.source_mention,
      merchantEntityId: merchantEntityIds.get(merchantSlug) ?? null,
      sourcePath: raw.source_path,
      line: raw.line,
      copperTotal: raw.copper_value,
      requirements,
    };
    if (!bySlug.has(merchantSlug)) bySlug.set(merchantSlug, []);
    bySlug.get(merchantSlug)!.push(offer);
    byOfferId.set(`${merchantSlug}|${offer.offerId}`, offer);
  }
  return {bySlug, byOfferId, bridgeAvailable: true};
}

interface CleanOffer {
  offer_id: string;
  source_slug: string;
  source_mention: string;
  source_path: string;
  line: string;
  coins: Array<{coin: string; amount: number}>;
  copper_value: number;
}

function parseOffers(meta: RawBridgeMeta | undefined): CleanOffer[] {
  if (!meta || typeof meta !== 'object') return [];
  if (meta.schema_version !== BRIDGE_SCHEMA_VERSION) return [];
  if (!Array.isArray(meta.offers)) return [];
  const out: CleanOffer[] = [];
  for (const raw of meta.offers) {
    const parsed = parseOffer(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseOffer(value: unknown): CleanOffer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as RawBridgeOffer;
  const offer_id = typeof raw.offer_id === 'string' ? raw.offer_id.trim() : '';
  const source_slug =
    typeof raw.source_slug === 'string' ? raw.source_slug.trim().toLowerCase() : '';
  const line = typeof raw.line === 'string' ? raw.line.trim() : '';
  if (!offer_id || !source_slug || !line) return null;
  const coins = Array.isArray(raw.coins)
    ? raw.coins
        .map(parseCoin)
        .filter((c): c is {coin: string; amount: number} => c !== null)
    : [];
  if (coins.length === 0) return null;
  const copper_value =
    typeof raw.copper_value === 'number' && Number.isFinite(raw.copper_value)
      ? Math.max(0, Math.trunc(raw.copper_value))
      : 0;
  return {
    offer_id,
    source_slug,
    source_mention:
      typeof raw.source_mention === 'string' ? raw.source_mention : `@${source_slug}`,
    source_path: typeof raw.source_path === 'string' ? raw.source_path : '',
    line,
    coins,
    copper_value,
  };
}

function parseCoin(value: unknown): {coin: string; amount: number} | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as RawBridgeCoin;
  const coin = typeof raw.coin === 'string' ? raw.coin.trim() : '';
  const amountRaw =
    typeof raw.amount === 'number'
      ? raw.amount
      : typeof raw.amount === 'string'
        ? Number(raw.amount)
        : NaN;
  if (!coin || !Number.isFinite(amountRaw) || amountRaw <= 0) return null;
  return {coin, amount: Math.trunc(amountRaw)};
}

function buildCoinByMention(coins: CurrencyCoin[]): Map<string, CurrencyCoin> {
  const map = new Map<string, CurrencyCoin>();
  for (const coin of coins) {
    if (coin.mention) map.set(coin.mention.toLowerCase(), coin);
    map.set(`@${coin.slug.toLowerCase()}`, coin);
  }
  return map;
}

function coinToRequirement(
  raw: {coin: string; amount: number},
  coinByMention: Map<string, CurrencyCoin>,
): MerchantOfferRequirement {
  const match = coinByMention.get(raw.coin.toLowerCase());
  if (!match) {
    return {
      coin: raw.coin,
      itemId: null,
      legacyEntityId: null,
      copperValue: 1,
      amount: raw.amount,
    };
  }
  return {
    coin: raw.coin,
    itemId: match.itemId,
    legacyEntityId: match.legacyEntityId,
    copperValue: match.copperValue,
    amount: raw.amount,
  };
}

async function resolveMerchantEntities(
  slugs: string[],
  cartridgeId: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (slugs.length === 0) return out;
  const sql = cartridgeId
    ? `SELECT id, profile->>'source_slug' AS source_slug
         FROM entities
        WHERE kind = 'person'
          AND profile->>'source_slug' = ANY($1::text[])
          AND cartridge_id = $2`
    : `SELECT id, profile->>'source_slug' AS source_slug
         FROM entities
        WHERE kind = 'person'
          AND profile->>'source_slug' = ANY($1::text[])`;
  const params: unknown[] = cartridgeId ? [slugs, cartridgeId] : [slugs];
  const rows = await query<{id: number; source_slug: string}>(sql, params);
  for (const row of rows.rows) {
    const slug = String(row.source_slug ?? '').trim().toLowerCase();
    if (slug) out.set(slug, Number(row.id));
  }
  return out;
}
