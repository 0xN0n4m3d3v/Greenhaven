/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 Phase 3 + ARCH-8 — cartridge-scope predicate reads from the
// normalized columns added in 0105 and cleaned up in 0106. The
// `quickgrin-lane` hardcoded fallback and the `support-smoke` tag
// carve-out are gone: cartridge_meta is the single source of truth
// for the active cartridge id, and `entities.cartridge_id` is the
// single source of truth for which rows belong to it.

import {getMetaRequired} from './cartridge.js';

export async function activeCartridgeId(): Promise<string> {
  return getMetaRequired<string>('cartridge_id');
}

export function activeCartridgeEntityPredicate(
  alias: string,
  cartridgeParam: string,
): string {
  return `(
    ${alias}.cartridge_id = ${cartridgeParam}
    OR ${alias}.dynamic_origin = true
    OR ${alias}.kind = 'player'
  )`;
}
