/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OBSIDIAN-VAULT-IMPORT-2 (2026-05-18) — shared scoped-or-legacy
// bridge metadata reader used by the four OWV runtime bridge
// services (currency, merchant, materializer, scene-instructions).
//
// Apply now writes the per-cartridge bridge v1 documents into
// `cartridge_meta_scoped`. Runtime readers consult the scoped row
// for the active cartridge first and only fall back to the legacy
// global `cartridge_meta` row when no scoped row exists at all.
//
// A reimport replaces a previously-written scoped row with the
// tombstone v1 document (empty `coins` / `offers` / `rows`),
// which is still a value, so reading still resolves through the
// scoped table — that is what stops fallback from re-surfacing
// stale legacy content after the writer drops an artifact.

import {getCartridgeMeta, getMeta} from '../cartridge.js';

export interface ScopedBridgeReadOptions {
  /** Active cartridge id. When omitted (or empty), the reader
   *  uses the legacy global `cartridge_meta` path only — preserved
   *  for old tests, seeded cartridges, and scripts that have no
   *  cartridge context. */
  cartridgeId?: string | null;
}

export async function readScopedBridgeMeta<T>(
  key: string,
  opts?: ScopedBridgeReadOptions,
): Promise<T | undefined> {
  const cartridgeId = normaliseCartridgeId(opts?.cartridgeId);
  if (cartridgeId) {
    const scoped = await getCartridgeMeta<T>(cartridgeId, key);
    if (scoped !== undefined && scoped !== null) return scoped;
  }
  return await getMeta<T>(key);
}

/** Map cache key for per-cartridge bridge catalog promises. Empty
 *  string means "legacy / no cartridge context". */
export function bridgeCacheKey(cartridgeId?: string | null): string {
  return normaliseCartridgeId(cartridgeId) ?? '';
}

function normaliseCartridgeId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
