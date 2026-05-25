/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-5 — SpecialistRegistry foundation (pre-broker slice).
//
// The pre-broker specialist stack (Combat Director / Intimacy
// Coordinator / Reward Calibrator) used to live as a hardcoded
// `preBrokerPhase` array inside `turn/phases/TurnDispatchPhase.ts`.
// That array forced every new specialist to touch a turn-dispatch
// internal and made the orchestration discoverable only by reading
// the dispatch file. ARCH-5 introduces a synchronous singleton
// registry that owns the specialist metadata (spec id, phase,
// appliesTo, hook) and exposes ordered listings to the turn
// runtime.
//
// Phases owned today: `preBroker` + `postTurn` + `debugSmoke` +
// `preToolValidator`. Every ARCH-5 specialist surface is now
// registry-backed.
//
// Contract:
//   - Registration is synchronous (module import side effect).
//   - The registry is process-global. Order of registration is the
//     order in which `listPreBrokerHooks()` returns the hooks —
//     which is the order the broker stage runs them.
//   - Duplicate `spec` ids throw at registration time so accidental
//     double-registration is caught immediately.
//   - `resetSpecialistRegistry()` is a test-only helper. Production
//     callers must not invoke it.

import type {PostTurnHook, PreBrokerHook} from '../agents/base.js';
import type {PreToolValidator} from '../tools/base.js';

export type SpecialistPhase =
  | 'preBroker'
  | 'postTurn'
  | 'debugSmoke'
  | 'preToolValidator';

/** Narrative label for which turn flavors a pre-broker specialist
 *  normally applies to. The registry records this as metadata only —
 *  the hook itself still owns the runtime "does this turn match?"
 *  check via the `mode` / `turnInput` arguments. */
export type PreBrokerAppliesTo = 'combat' | 'intimacy' | 'any';

/** Post-turn hooks run after every successful turn (subject to the
 *  fail-open / `suppressPostTurn` / `shouldSkipPostTurnHookForSnapshot`
 *  gates that `postTurnPipeline` applies). They are not mode-gated at
 *  registry level, so the narrative tag is uniformly `'always'`. */
export type PostTurnAppliesTo = 'always';

export interface PreBrokerSpecialistDescriptor {
  spec: string;
  phase: 'preBroker';
  appliesTo: PreBrokerAppliesTo;
  hook: PreBrokerHook;
}

export interface PostTurnSpecialistDescriptor {
  spec: string;
  phase: 'postTurn';
  appliesTo: PostTurnAppliesTo;
  hook: PostTurnHook;
}

/** Debug-smoke verdict shape. Mirrors the local `VerifyTest.check`
 *  signature `DebugService` used to declare inline; lifted here so
 *  the verify roster can be registered by data instead of by a
 *  hardcoded switch. */
export interface DebugSmokeVerifyCheck {
  (parsed: Record<string, unknown>): {
    status: 'pass' | 'fail' | 'skipped';
    notes: string;
  };
}

/** Descriptor for the `/api/debug/verify-specialists` smoke matrix.
 *  Numeric `spec` matches the Greenhaven specification document
 *  (Spec 39 = quest_watcher, Spec 40 = combat_director, …). The
 *  registry enforces uniqueness on both `spec` and `name` because
 *  duplicating either would silently shadow a probe. `buildBody`
 *  is invoked per `/api/debug/verify-specialists` call with the
 *  current `playerId`, matching the previous inline behavior. */
export interface DebugSmokeSpecialistDescriptor {
  spec: number;
  phase: 'debugSmoke';
  name: string;
  endpoint: string;
  buildBody(playerId: number): Record<string, unknown>;
  check: DebugSmokeVerifyCheck;
}

/** Descriptor for a single pre-tool validator registration. The
 *  `name` is the unique identity across the registry (e.g.
 *  `cartridge_steward.create_entity`) — multiple validators may
 *  legitimately share a `toolName` (the `narrate` tool runs three
 *  validators today: Movement Warden, Environment State, Voice
 *  Warden), so duplicate detection keys on `name` only. The
 *  registry is metadata-only: `tools/index.ts` reads
 *  `listPreToolValidatorSpecialists()` at module load and calls
 *  `registerPreToolValidator(toolName, validator)` from
 *  `tools/base.js` to wire each entry into the per-tool dispatch
 *  map. Pre-tool dispatch order is the order returned here. */
export interface PreToolValidatorDescriptor {
  name: string;
  phase: 'preToolValidator';
  toolName: string;
  validator: PreToolValidator;
}

export type SpecialistDescriptor =
  | PreBrokerSpecialistDescriptor
  | PostTurnSpecialistDescriptor;

interface RegistryState {
  preBroker: PreBrokerSpecialistDescriptor[];
  postTurn: PostTurnSpecialistDescriptor[];
  debugSmoke: DebugSmokeSpecialistDescriptor[];
  preToolValidator: PreToolValidatorDescriptor[];
}

const registry: RegistryState = {
  preBroker: [],
  postTurn: [],
  debugSmoke: [],
  preToolValidator: [],
};

export function registerSpecialist(descriptor: SpecialistDescriptor): void {
  if (descriptor.hook.name !== descriptor.spec) {
    throw new Error(
      `SpecialistRegistry: descriptor.spec='${descriptor.spec}' does not match hook.name='${descriptor.hook.name}'`,
    );
  }
  if (descriptor.phase === 'preBroker') {
    if (registry.preBroker.some((entry) => entry.spec === descriptor.spec)) {
      throw new Error(
        `SpecialistRegistry: duplicate preBroker spec '${descriptor.spec}'`,
      );
    }
    registry.preBroker.push(descriptor);
    return;
  }
  if (descriptor.phase === 'postTurn') {
    if (registry.postTurn.some((entry) => entry.spec === descriptor.spec)) {
      throw new Error(
        `SpecialistRegistry: duplicate postTurn spec '${descriptor.spec}'`,
      );
    }
    registry.postTurn.push(descriptor);
    return;
  }
  // Discriminated-union exhaustiveness guard.
  throw new Error(
    `SpecialistRegistry: unsupported phase '${(descriptor as {phase: string}).phase}'`,
  );
}

/** Returns a defensive copy of the registered pre-broker descriptors
 *  in registration order. Callers must not mutate the returned array. */
export function listPreBrokerSpecialists(): PreBrokerSpecialistDescriptor[] {
  return registry.preBroker.slice();
}

/** Returns the registered pre-broker hooks in registration order.
 *  This is the array `TurnDispatchPhase` hands to `runBrokerStage`
 *  as `preBrokerHooks`. */
export function listPreBrokerHooks(): PreBrokerHook[] {
  return registry.preBroker.map((entry) => entry.hook);
}

/** Returns a defensive copy of the registered post-turn descriptors
 *  in registration order. Callers must not mutate the returned array. */
export function listPostTurnSpecialists(): PostTurnSpecialistDescriptor[] {
  return registry.postTurn.slice();
}

/** Returns the registered post-turn hooks in registration order.
 *  `postTurnPipeline` reads this in place of its previous hardcoded
 *  `postTurnPhase` array. */
export function listPostTurnHooks(): PostTurnHook[] {
  return registry.postTurn.map((entry) => entry.hook);
}

/** ARCH-5 debug-smoke registration. Uses its own register entry
 *  point because the descriptor shape (numeric `spec`, no `hook`,
 *  `buildBody` / `check` instead) is meaningfully different from
 *  the hook-bearing pre-broker / post-turn descriptors. Duplicate
 *  spec NUMBERS and duplicate `name` ids both throw — the verify
 *  matrix has historically used each (spec, name) pair to label
 *  verdicts. */
export function registerDebugSmokeSpecialist(
  descriptor: DebugSmokeSpecialistDescriptor,
): void {
  if (descriptor.phase !== 'debugSmoke') {
    throw new Error(
      `SpecialistRegistry: unsupported debug-smoke phase '${descriptor.phase}'`,
    );
  }
  if (!Number.isInteger(descriptor.spec) || descriptor.spec <= 0) {
    throw new Error(
      `SpecialistRegistry: debug-smoke descriptor.spec must be a positive integer, got ${descriptor.spec}`,
    );
  }
  if (registry.debugSmoke.some((entry) => entry.spec === descriptor.spec)) {
    throw new Error(
      `SpecialistRegistry: duplicate debugSmoke spec '${descriptor.spec}'`,
    );
  }
  if (registry.debugSmoke.some((entry) => entry.name === descriptor.name)) {
    throw new Error(
      `SpecialistRegistry: duplicate debugSmoke name '${descriptor.name}'`,
    );
  }
  registry.debugSmoke.push(descriptor);
}

/** Returns a defensive copy of the registered debug-smoke
 *  descriptors in registration order. `DebugService.buildVerifyTests`
 *  iterates this in place of its previous local hardcoded matrix. */
export function listDebugSmokeSpecialists(): DebugSmokeSpecialistDescriptor[] {
  return registry.debugSmoke.slice();
}

/** ARCH-5 pre-tool validator registration. Same identity rule as
 *  the other phases — duplicate `name` throws — but the same
 *  `toolName` is intentionally allowed multiple times so the three
 *  `narrate` validators (Movement Warden / Environment State /
 *  Voice Warden) can coexist. */
export function registerPreToolValidatorSpecialist(
  descriptor: PreToolValidatorDescriptor,
): void {
  if (descriptor.phase !== 'preToolValidator') {
    throw new Error(
      `SpecialistRegistry: unsupported preToolValidator phase '${descriptor.phase}'`,
    );
  }
  if (
    typeof descriptor.name !== 'string' ||
    descriptor.name.trim().length === 0
  ) {
    throw new Error(
      `SpecialistRegistry: preToolValidator descriptor.name must be a non-empty string`,
    );
  }
  if (
    typeof descriptor.toolName !== 'string' ||
    descriptor.toolName.trim().length === 0
  ) {
    throw new Error(
      `SpecialistRegistry: preToolValidator descriptor.toolName must be a non-empty string`,
    );
  }
  if (
    registry.preToolValidator.some((entry) => entry.name === descriptor.name)
  ) {
    throw new Error(
      `SpecialistRegistry: duplicate preToolValidator name '${descriptor.name}'`,
    );
  }
  registry.preToolValidator.push(descriptor);
}

/** Returns a defensive copy of the registered pre-tool validator
 *  descriptors in registration order. `tools/index.ts` iterates
 *  this to wire each validator into `tools/base.js`. */
export function listPreToolValidatorSpecialists(): PreToolValidatorDescriptor[] {
  return registry.preToolValidator.slice();
}

/** Test-only — clears every phase so each vitest file can register
 *  fresh fixtures. Production code must not call this. */
export function resetSpecialistRegistry(): void {
  registry.preBroker = [];
  registry.postTurn = [];
  registry.debugSmoke = [];
  registry.preToolValidator = [];
}
