/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Tool registry — importing this file is what wires all tools into
// the central registry (see base.ts). Order doesn't matter; every
// module calls registerTool() at load time.
//
// Add a new file here when you add a new tools/<area>.ts.

import './entity.js';
import './runtime.js';
import './inventory.js';
import './currency.js';
import './merchant.js';
import './materializer.js';
import './memory.js';
import './progression.js';
import './quest.js';
import './dice.js';
import './combat.js';
import './narrate.js';
import './strings.js';
import './relationshipTrigger.js';
import './authoredScene.js';
import './surfaces.js';
import './inspiration.js';
import './combatDeath.js';
import './inventoryExt.js';
import './dialogue.js';
import './intimacy.js';
import './movement.js';
import './companion.js';
import './companionRule.js';
import './worldMemory.js';
import './worldSensing.js';
import './batchMutate.js';

// ARCH-5 — pre-tool validator registration metadata lives in the
// SpecialistRegistry. Importing `../specialists/index.js` is what
// wires each agent module's `registerPreToolValidatorSpecialist`
// side effect; the loop below mirrors the descriptors into this
// package's per-tool dispatch map via `registerPreToolValidator`.
//
// Registration order (preserved by the registry):
//   1. cartridge_steward.create_entity        (spec 48)
//   2. cartridge_steward.create_quest         (spec 48)
//   3. movement_warden.narrate                (spec 51)
//   4. environment_state.narrate              (Velvet Booths guard)
//   5. environment_state.apply_runtime_field_patch
//   6. voice_warden.narrate                   (spec 54)
//   7. finalization_guards.<MUTATION_TOOLS>   (spec 92, MUTATION_TOOLS insertion order)
//
// `narrate` therefore runs Movement → Environment → Voice (finalization
// guards do NOT register `narrate`; they apply to mutation tools only,
// see `agents/finalizationGuards.ts:MUTATION_TOOLS`). This matches the
// previous explicit register-call order in this file. The hard
// rejection / fail-open / order semantics on the dispatch layer are
// unchanged — only the registration surface moved.
import '../specialists/index.js';
import {listPreToolValidatorSpecialists} from '../specialists/registry.js';
import {registerPreToolValidator} from './base.js';

for (const descriptor of listPreToolValidatorSpecialists()) {
  registerPreToolValidator(descriptor.toolName, descriptor.validator);
}

export {dispatch, getRegisteredTools, registerTool} from './base.js';
export type {ToolContext, ToolDefinition, ToolResult} from './base.js';
export {registerPreToolValidator} from './base.js';
export type {PreToolValidator} from './base.js';
