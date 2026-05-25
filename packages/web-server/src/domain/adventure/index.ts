/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-3 — adventure domain-pack facade.
//
// External callers (routes, turn phases, specialists, devtools, tests)
// MUST import adventure symbols through this barrel rather than the
// individual leaves under `runtime/` or `materializer/`. The boundary
// is enforced by
// `src/__tests__/architecture/adventureDomainPack.test.ts`. Production
// code outside `src/domain/adventure/**` may not import `runtime/*`
// directly; internal domain modules and `__tests__/` are exempt.
//
// The materializer cluster has its own dedicated barrel
// (`./materializer/index.js`) for callers that need only the
// materializer surface (post-turn specialist registration in
// `specialists/index.ts` and the support smoke devtool). It is also
// re-exported here under `materializer.*` for callers that want the
// full adventure-pack surface in one place.

export * from './runtime/adventureQueue.js';
export * from './runtime/adventureBlueprint.js';
export * from './runtime/adventureTables.js';
export * from './runtime/adventureArbiter.js';
export * from './runtime/scenarioIntegrityArbiter.js';
export * from './runtime/situationBlueprint.js';
export * from './runtime/adventureFallbackTextSelector.js';
export * from './runtime/adventureFallbackText.js';
export * from './runtime/adventureAcceptFollowup.js';
export * from './runtime/adventureRng.js';
export * from './runtime/adventureIntent.js';
export {
  AdventureService,
  acceptPlayerAdventure,
  ignorePlayerAdventure,
  listPlayerAdventures,
  type AdventureIgnoreConsequence,
  type PlayerAdventurePayload,
} from './AdventureService.js';
