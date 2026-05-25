/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-3 domain-pack barrel for the adventure materializer.
//
// External callers MUST import through this barrel rather than the
// individual leaf files; the architecture boundary test in
// `src/__tests__/architecture/adventureDomainPack.test.ts` enforces
// it. Internal leaves may import each other directly.

export {
  ADVENTURE_MATERIALIZER_SLOT_DEADLINE_MS,
  ADVENTURE_MATERIALIZER_SPECIALIST_TIMEOUT_MS,
  adventureMaterializerHook,
  materializeNextAdventureForSession,
} from './materializer.js';
export {buildMaterializerInput} from './input.js';
export {buildFallbackSituation, tryMaterializerFallback} from './fallback.js';
export {
  ADVENTURE_MATERIALIZER_CURRENT_TURN_POLL_MS,
  ADVENTURE_MATERIALIZER_CURRENT_TURN_WAIT_MS,
  claimQueuedAdventureForCurrentTurn,
} from './queue.js';
export {adventureMaterializerPrompt} from './prompt.js';
export {
  MaterializerOutput,
  type AdventureMaterializerInput,
} from './types.js';
