/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-5 — focused tests for the SpecialistRegistry pre-broker
// slice. Two surfaces under test:
//   1. The raw `registry.ts` module — `registerSpecialist`,
//      `listPreBrokerHooks`, duplicate detection, hook-name
//      consistency, reset.
//   2. The side-effect `specialists/index.ts` module — the three
//      production specialists register in the exact broker-stage
//      order (combat → intimacy → reward) with the right
//      `appliesTo` metadata, and the consumer-facing
//      `listPreBrokerHooks()` returns hook objects whose `name`
//      matches the registered spec id.

import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {PostTurnHook, PreBrokerHook} from '../../agents/base.js';
import type {PreToolValidator} from '../../tools/base.js';

import {
  listDebugSmokeSpecialists,
  listPostTurnHooks,
  listPostTurnSpecialists,
  listPreBrokerHooks,
  listPreBrokerSpecialists,
  listPreToolValidatorSpecialists,
  registerDebugSmokeSpecialist,
  registerPreToolValidatorSpecialist,
  registerSpecialist,
  resetSpecialistRegistry,
} from '../../specialists/registry.js';

const noopValidator: PreToolValidator = async () => ({ok: true});

function makeHook(name: string): PreBrokerHook {
  return {
    name,
    async run() {
      return null;
    },
  };
}

function makePostTurnHook(
  name: string,
  presentation: PostTurnHook['presentation'] = {
    slotKey: `${name}.slot`,
    lane: 'post_response',
    ordinal: 0,
    visible: true,
    barrierMode: 'chat_visible',
    deadlineMs: 5_000,
  },
): PostTurnHook {
  return {
    name,
    presentation,
    async run() {
      // no-op test hook
    },
  };
}

describe('SpecialistRegistry — pre-broker contract', () => {
  beforeEach(() => {
    resetSpecialistRegistry();
  });

  it('preserves registration order in listPreBrokerHooks / listPreBrokerSpecialists', () => {
    registerSpecialist({
      spec: 'first_spec',
      phase: 'preBroker',
      appliesTo: 'combat',
      hook: makeHook('first_spec'),
    });
    registerSpecialist({
      spec: 'second_spec',
      phase: 'preBroker',
      appliesTo: 'intimacy',
      hook: makeHook('second_spec'),
    });
    registerSpecialist({
      spec: 'third_spec',
      phase: 'preBroker',
      appliesTo: 'any',
      hook: makeHook('third_spec'),
    });

    expect(listPreBrokerSpecialists().map((d) => d.spec)).toEqual([
      'first_spec',
      'second_spec',
      'third_spec',
    ]);
    expect(listPreBrokerHooks().map((h) => h.name)).toEqual([
      'first_spec',
      'second_spec',
      'third_spec',
    ]);
  });

  it('throws when the same spec id is registered twice', () => {
    registerSpecialist({
      spec: 'dup_spec',
      phase: 'preBroker',
      appliesTo: 'any',
      hook: makeHook('dup_spec'),
    });
    expect(() =>
      registerSpecialist({
        spec: 'dup_spec',
        phase: 'preBroker',
        appliesTo: 'combat',
        hook: makeHook('dup_spec'),
      }),
    ).toThrow(/duplicate preBroker spec 'dup_spec'/);
  });

  it('throws when descriptor.spec mismatches hook.name', () => {
    expect(() =>
      registerSpecialist({
        spec: 'mismatch_spec',
        phase: 'preBroker',
        appliesTo: 'any',
        hook: makeHook('different_hook_name'),
      }),
    ).toThrow(/does not match hook.name/);
  });

  it('returns defensive copies — mutating the listing does not affect the registry', () => {
    registerSpecialist({
      spec: 'stable_spec',
      phase: 'preBroker',
      appliesTo: 'any',
      hook: makeHook('stable_spec'),
    });
    const specs = listPreBrokerSpecialists();
    specs.length = 0;
    expect(listPreBrokerSpecialists()).toHaveLength(1);
    const hooks = listPreBrokerHooks();
    hooks.length = 0;
    expect(listPreBrokerHooks()).toHaveLength(1);
  });

  it('resetSpecialistRegistry clears every previously registered descriptor', () => {
    registerSpecialist({
      spec: 'temp_spec',
      phase: 'preBroker',
      appliesTo: 'any',
      hook: makeHook('temp_spec'),
    });
    expect(listPreBrokerHooks()).toHaveLength(1);
    resetSpecialistRegistry();
    expect(listPreBrokerHooks()).toHaveLength(0);
  });
});

describe('SpecialistRegistry — post-turn contract', () => {
  beforeEach(() => {
    resetSpecialistRegistry();
  });

  it('preserves registration order across listPostTurnHooks / listPostTurnSpecialists', () => {
    registerSpecialist({
      spec: 'alpha_hook',
      phase: 'postTurn',
      appliesTo: 'always',
      hook: makePostTurnHook('alpha_hook'),
    });
    registerSpecialist({
      spec: 'beta_hook',
      phase: 'postTurn',
      appliesTo: 'always',
      hook: makePostTurnHook('beta_hook'),
    });
    registerSpecialist({
      spec: 'gamma_hook',
      phase: 'postTurn',
      appliesTo: 'always',
      hook: makePostTurnHook('gamma_hook'),
    });

    expect(listPostTurnSpecialists().map((d) => d.spec)).toEqual([
      'alpha_hook',
      'beta_hook',
      'gamma_hook',
    ]);
    expect(listPostTurnHooks().map((h) => h.name)).toEqual([
      'alpha_hook',
      'beta_hook',
      'gamma_hook',
    ]);
  });

  it('throws on duplicate post-turn specs and on spec/hook-name drift', () => {
    registerSpecialist({
      spec: 'duped_post',
      phase: 'postTurn',
      appliesTo: 'always',
      hook: makePostTurnHook('duped_post'),
    });
    expect(() =>
      registerSpecialist({
        spec: 'duped_post',
        phase: 'postTurn',
        appliesTo: 'always',
        hook: makePostTurnHook('duped_post'),
      }),
    ).toThrow(/duplicate postTurn spec 'duped_post'/);
    expect(() =>
      registerSpecialist({
        spec: 'drifted_post',
        phase: 'postTurn',
        appliesTo: 'always',
        hook: makePostTurnHook('different_hook_name'),
      }),
    ).toThrow(/does not match hook.name/);
  });

  it('round-trips PostTurnPresentationMeta on the registered descriptor', () => {
    const meta = {
      slotKey: 'sentinel.slot',
      lane: 'status' as const,
      ordinal: 3,
      visible: false,
      barrierMode: 'non_blocking' as const,
      deadlineMs: 12_345,
    };
    registerSpecialist({
      spec: 'sentinel_hook',
      phase: 'postTurn',
      appliesTo: 'always',
      hook: makePostTurnHook('sentinel_hook', meta),
    });
    const [descriptor] = listPostTurnSpecialists();
    expect(descriptor?.hook.presentation).toEqual(meta);
  });

  it('isolates preBroker and postTurn phases — same spec id allowed in each', () => {
    registerSpecialist({
      spec: 'shared_name',
      phase: 'preBroker',
      appliesTo: 'any',
      hook: makeHook('shared_name'),
    });
    registerSpecialist({
      spec: 'shared_name',
      phase: 'postTurn',
      appliesTo: 'always',
      hook: makePostTurnHook('shared_name'),
    });
    expect(listPreBrokerHooks()).toHaveLength(1);
    expect(listPostTurnHooks()).toHaveLength(1);
  });

  it('resetSpecialistRegistry clears every registered phase', () => {
    registerSpecialist({
      spec: 'pre_x',
      phase: 'preBroker',
      appliesTo: 'any',
      hook: makeHook('pre_x'),
    });
    registerSpecialist({
      spec: 'post_x',
      phase: 'postTurn',
      appliesTo: 'always',
      hook: makePostTurnHook('post_x'),
    });
    registerDebugSmokeSpecialist({
      spec: 999,
      phase: 'debugSmoke',
      name: 'debug_x',
      endpoint: '/api/debug/run-debug-x',
      buildBody: () => ({}),
      check: () => ({status: 'pass', notes: 'ok'}),
    });
    registerPreToolValidatorSpecialist({
      name: 'pretool_x',
      phase: 'preToolValidator',
      toolName: 'narrate',
      validator: noopValidator,
    });
    expect(listPreBrokerHooks()).toHaveLength(1);
    expect(listPostTurnHooks()).toHaveLength(1);
    expect(listDebugSmokeSpecialists()).toHaveLength(1);
    expect(listPreToolValidatorSpecialists()).toHaveLength(1);
    resetSpecialistRegistry();
    expect(listPreBrokerHooks()).toHaveLength(0);
    expect(listPostTurnHooks()).toHaveLength(0);
    expect(listDebugSmokeSpecialists()).toHaveLength(0);
    expect(listPreToolValidatorSpecialists()).toHaveLength(0);
  });
});

describe('SpecialistRegistry — pre-tool validator contract', () => {
  beforeEach(() => {
    resetSpecialistRegistry();
  });

  it('preserves registration order in listPreToolValidatorSpecialists', () => {
    registerPreToolValidatorSpecialist({
      name: 'alpha.narrate',
      phase: 'preToolValidator',
      toolName: 'narrate',
      validator: noopValidator,
    });
    registerPreToolValidatorSpecialist({
      name: 'beta.create_entity',
      phase: 'preToolValidator',
      toolName: 'create_entity',
      validator: noopValidator,
    });
    registerPreToolValidatorSpecialist({
      name: 'gamma.narrate',
      phase: 'preToolValidator',
      toolName: 'narrate',
      validator: noopValidator,
    });

    expect(listPreToolValidatorSpecialists().map((d) => d.name)).toEqual([
      'alpha.narrate',
      'beta.create_entity',
      'gamma.narrate',
    ]);
    expect(listPreToolValidatorSpecialists().map((d) => d.toolName)).toEqual([
      'narrate',
      'create_entity',
      'narrate',
    ]);
  });

  it('allows multiple validators to share a toolName so long as the names differ', () => {
    registerPreToolValidatorSpecialist({
      name: 'movement_warden.narrate',
      phase: 'preToolValidator',
      toolName: 'narrate',
      validator: noopValidator,
    });
    registerPreToolValidatorSpecialist({
      name: 'voice_warden.narrate',
      phase: 'preToolValidator',
      toolName: 'narrate',
      validator: noopValidator,
    });
    expect(listPreToolValidatorSpecialists()).toHaveLength(2);
  });

  it('throws when the same name is registered twice', () => {
    registerPreToolValidatorSpecialist({
      name: 'dup.narrate',
      phase: 'preToolValidator',
      toolName: 'narrate',
      validator: noopValidator,
    });
    expect(() =>
      registerPreToolValidatorSpecialist({
        name: 'dup.narrate',
        phase: 'preToolValidator',
        toolName: 'create_entity',
        validator: noopValidator,
      }),
    ).toThrow(/duplicate preToolValidator name 'dup.narrate'/);
  });

  it('rejects empty name or empty toolName', () => {
    expect(() =>
      registerPreToolValidatorSpecialist({
        name: '',
        phase: 'preToolValidator',
        toolName: 'narrate',
        validator: noopValidator,
      }),
    ).toThrow(/name must be a non-empty string/);
    expect(() =>
      registerPreToolValidatorSpecialist({
        name: 'has_name',
        phase: 'preToolValidator',
        toolName: '   ',
        validator: noopValidator,
      }),
    ).toThrow(/toolName must be a non-empty string/);
  });

  it('returns a defensive copy', () => {
    registerPreToolValidatorSpecialist({
      name: 'stable.narrate',
      phase: 'preToolValidator',
      toolName: 'narrate',
      validator: noopValidator,
    });
    const snapshot = listPreToolValidatorSpecialists();
    snapshot.length = 0;
    expect(listPreToolValidatorSpecialists()).toHaveLength(1);
  });
});

describe('SpecialistRegistry — debug-smoke contract', () => {
  beforeEach(() => {
    resetSpecialistRegistry();
  });

  it('preserves registration order in listDebugSmokeSpecialists', () => {
    registerDebugSmokeSpecialist({
      spec: 100,
      phase: 'debugSmoke',
      name: 'alpha_probe',
      endpoint: '/api/debug/run-alpha',
      buildBody: (playerId) => ({playerId}),
      check: () => ({status: 'pass', notes: 'a'}),
    });
    registerDebugSmokeSpecialist({
      spec: 101,
      phase: 'debugSmoke',
      name: 'beta_probe',
      endpoint: '/api/debug/run-beta',
      buildBody: () => ({}),
      check: () => ({status: 'pass', notes: 'b'}),
    });
    expect(listDebugSmokeSpecialists().map((d) => d.spec)).toEqual([
      100, 101,
    ]);
    expect(listDebugSmokeSpecialists().map((d) => d.name)).toEqual([
      'alpha_probe',
      'beta_probe',
    ]);
  });

  it('throws on duplicate spec numbers and duplicate names', () => {
    registerDebugSmokeSpecialist({
      spec: 200,
      phase: 'debugSmoke',
      name: 'first_probe',
      endpoint: '/api/debug/run-first',
      buildBody: () => ({}),
      check: () => ({status: 'pass', notes: ''}),
    });
    expect(() =>
      registerDebugSmokeSpecialist({
        spec: 200,
        phase: 'debugSmoke',
        name: 'different_name',
        endpoint: '/api/debug/run-other',
        buildBody: () => ({}),
        check: () => ({status: 'pass', notes: ''}),
      }),
    ).toThrow(/duplicate debugSmoke spec '200'/);
    expect(() =>
      registerDebugSmokeSpecialist({
        spec: 201,
        phase: 'debugSmoke',
        name: 'first_probe',
        endpoint: '/api/debug/run-other',
        buildBody: () => ({}),
        check: () => ({status: 'pass', notes: ''}),
      }),
    ).toThrow(/duplicate debugSmoke name 'first_probe'/);
  });

  it('rejects non-positive-integer spec numbers', () => {
    expect(() =>
      registerDebugSmokeSpecialist({
        spec: 0,
        phase: 'debugSmoke',
        name: 'zero_probe',
        endpoint: '/api/debug/run-zero',
        buildBody: () => ({}),
        check: () => ({status: 'pass', notes: ''}),
      }),
    ).toThrow(/must be a positive integer/);
    expect(() =>
      registerDebugSmokeSpecialist({
        spec: 1.5,
        phase: 'debugSmoke',
        name: 'frac_probe',
        endpoint: '/api/debug/run-frac',
        buildBody: () => ({}),
        check: () => ({status: 'pass', notes: ''}),
      }),
    ).toThrow(/must be a positive integer/);
  });

  it('returns a defensive copy', () => {
    registerDebugSmokeSpecialist({
      spec: 300,
      phase: 'debugSmoke',
      name: 'stable_probe',
      endpoint: '/api/debug/run-stable',
      buildBody: () => ({}),
      check: () => ({status: 'pass', notes: ''}),
    });
    const snapshot = listDebugSmokeSpecialists();
    snapshot.length = 0;
    expect(listDebugSmokeSpecialists()).toHaveLength(1);
  });
});

describe('specialists/index.ts — production registration order', () => {
  it('registers pre-broker + post-turn specialists in the exact runtime order', async () => {
    // Vitest may have already imported `specialists/index.js` (and
    // the earlier `resetSpecialistRegistry` calls in this file may
    // have emptied the registry between then and now). Reset the
    // module cache + the singleton, then re-import the module so
    // its registration side-effect runs against a clean registry.
    vi.resetModules();
    resetSpecialistRegistry();
    const mod = await import('../../specialists/index.js');

    const preBroker = mod.listPreBrokerSpecialists();
    expect(preBroker.map((d) => d.spec)).toEqual([
      'combat_director',
      'intimacy_coordinator',
      'reward_calibrator',
    ]);
    expect(preBroker.map((d) => d.appliesTo)).toEqual([
      'combat',
      'intimacy',
      'any',
    ]);
    expect(preBroker.every((d) => d.phase === 'preBroker')).toBe(true);
    expect(mod.listPreBrokerHooks().map((h) => h.name)).toEqual([
      'combat_director',
      'intimacy_coordinator',
      'reward_calibrator',
    ]);

    const postTurn = mod.listPostTurnSpecialists();
    const expectedPostTurnOrder = [
      'quest_watcher',
      'memory_loop_watcher',
      'catalogue_scout',
      'npc_voice',
      'dialogue_anchor',
      'rolling_dialogue_summary',
      'narrative_claim_sweeper',
      'movement_warden',
      'quest_pacer',
      'adventure_oracle',
      'adventure_materializer',
      'companion_depart_engine',
    ];
    expect(postTurn.map((d) => d.spec)).toEqual(expectedPostTurnOrder);
    expect(postTurn.every((d) => d.phase === 'postTurn')).toBe(true);
    expect(postTurn.every((d) => d.appliesTo === 'always')).toBe(true);
    expect(mod.listPostTurnHooks().map((h) => h.name)).toEqual(
      expectedPostTurnOrder,
    );
    // Each registered hook keeps its production presentation
    // metadata visible through the descriptor.
    for (const descriptor of postTurn) {
      expect(descriptor.hook.presentation).toBeDefined();
      expect(descriptor.hook.presentation.barrierMode).toMatch(
        /^(chat_visible|non_blocking)$/,
      );
    }

    const debugSmoke = mod.listDebugSmokeSpecialists();
    expect(debugSmoke.map((d) => d.spec)).toEqual([
      39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
    ]);
    expect(debugSmoke.map((d) => d.name)).toEqual([
      'quest_watcher',
      'combat_director',
      'intimacy_coordinator',
      'catalogue_scout',
      'npc_voice',
      'scene_painter',
      'dialogue_anchor',
      'movement_warden',
      'reward_calibrator',
      'cartridge_steward',
      'quest_pacer',
    ]);
    expect(debugSmoke.every((d) => d.phase === 'debugSmoke')).toBe(true);
    for (const descriptor of debugSmoke) {
      expect(descriptor.endpoint).toMatch(/^\/api\/debug\/run-/);
      expect(typeof descriptor.buildBody).toBe('function');
      expect(typeof descriptor.check).toBe('function');
    }
  });

  it('DebugService.buildVerifyTests materialises the registry roster with the prior contract', async () => {
    // Ensure production registration is live, then drive the
    // existing `buildVerifyTests(playerId)` API the way the route
    // does and assert spec order + endpoint + per-test body shape +
    // verdict semantics that the live UI / verify route depend on.
    vi.resetModules();
    resetSpecialistRegistry();
    await import('../../specialists/index.js');
    const {DebugService} = await import('../../services/DebugService.js');

    const tests = DebugService.buildVerifyTests(4242);
    expect(tests.map((t) => t.spec)).toEqual([
      39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
    ]);
    const bySpec = new Map(tests.map((t) => [t.spec, t]));
    expect(bySpec.get(39)?.endpoint).toBe('/api/debug/run-quest-watcher');
    expect(bySpec.get(39)?.body).toEqual({playerId: 4242, forceLLM: true});
    // spec 42 / 43 / 44 have no playerId in the body — preserved.
    expect(bySpec.get(42)?.body).not.toHaveProperty('playerId');
    expect(bySpec.get(43)?.body).toEqual({memoryId: 0, force: true});
    expect(bySpec.get(44)?.body).toMatchObject({language: 'en'});
    // Spec 47 verdict: skipped when calibrator did not produce a
    // briefing.
    expect(bySpec.get(47)?.check({calibrator_ran: false})).toEqual({
      status: 'skipped',
      notes: expect.stringMatching(/fail-open|no player/),
    });
    // Spec 47 verdict: pass when calibrator produced a briefing.
    expect(
      bySpec.get(47)?.check({calibrator_ran: true, briefing: 'ok'}),
    ).toEqual({
      status: 'pass',
      notes: 'briefing returned',
    });
    // Spec 40 verdict on the well-formed brief shape.
    expect(
      bySpec.get(40)?.check({
        brief: {damage_plan: {}, position: 'risky', effect: 'standard'},
      }),
    ).toEqual({
      status: 'pass',
      notes: 'damage_plan + position + effect present',
    });
  });

  it('postTurnPipeline consumes the registry rather than a local hardcoded array', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        new URL('../../postTurnPipeline.ts', import.meta.url),
        'utf8',
      ),
    );
    // The previous slice declared `const postTurnPhase: PostTurnHook[]`
    // and imported the 12 hook modules directly. The ARCH-5 post-turn
    // migration should remove both.
    expect(source).not.toMatch(/const\s+postTurnPhase\s*:/);
    expect(source).toContain('listPostTurnHooks');
    expect(source).not.toMatch(/from\s+'\.\/agents\/questWatcher\.js'/);
    expect(source).not.toMatch(
      /from\s+'\.\/agents\/companionDepartEngine\.js'/,
    );
  });

  it('registers pre-tool validators in the exact dispatch order tools/index.ts depended on', async () => {
    vi.resetModules();
    resetSpecialistRegistry();
    const mod = await import('../../specialists/index.js');

    const preTool = mod.listPreToolValidatorSpecialists();

    // The first six entries are deterministic and named one-per-line.
    // Order corresponds to the previous explicit register-call order
    // in `tools/index.ts`: cartridge_steward × 2 → movement_warden →
    // environment_state × 2 → voice_warden → finalization_guards*.
    expect(preTool.slice(0, 6).map((d) => d.name)).toEqual([
      'cartridge_steward.create_entity',
      'cartridge_steward.create_quest',
      'movement_warden.narrate',
      'environment_state.narrate',
      'environment_state.apply_runtime_field_patch',
      'voice_warden.narrate',
    ]);
    expect(preTool.slice(0, 6).map((d) => d.toolName)).toEqual([
      'create_entity',
      'create_quest',
      'narrate',
      'narrate',
      'apply_runtime_field_patch',
      'narrate',
    ]);

    // The remaining entries are the finalization-guards block — one
    // per MUTATION_TOOLS member, in the Set's insertion order. The
    // exact insertion order is owned by `finalizationGuards.ts` and
    // must match the previous `registerFinalizationGuards()` output.
    const finalization = preTool.slice(6);
    const expectedMutationTools = [
      'add_memory',
      'bump_memory_salience',
      'start_quest',
      'advance_quest',
      'complete_quest',
      'set_runtime_field',
      'apply_runtime_field_patch',
      'award_xp',
      'change_stat',
      'unlock_skill',
      'award_progression_xp',
      'award_title',
      'equip_title',
      'spend_stat_point',
      'spend_skill_point',
      'award_inspiration',
      'spend_inspiration',
      'string_award',
      'string_spend',
      'batch_mutate_world',
      'inventory_transfer',
      'use_item',
      'equip_item',
      'give_to_npc',
      'create_entity',
      'update_entity',
      'create_quest',
      'move_player',
      'damage',
      'heal',
      'mark_downed',
      'death_save',
      'stabilize',
      'apply_surface',
      'apply_intimacy_trigger',
      'set_companion',
      'switch_dialogue_partner',
    ];
    expect(finalization.map((d) => d.name)).toEqual(
      expectedMutationTools.map((t) => `finalization_guards.${t}`),
    );
    expect(finalization.map((d) => d.toolName)).toEqual(expectedMutationTools);
    expect(preTool.every((d) => d.phase === 'preToolValidator')).toBe(true);
    expect(preTool.every((d) => typeof d.validator === 'function')).toBe(true);
  });

  it('tools/index.ts consumes listPreToolValidatorSpecialists rather than calling register*() helpers', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../tools/index.ts', import.meta.url), 'utf8'),
    );
    // The previous slice had five explicit `register*()` imports +
    // calls. The ARCH-5 pre-tool migration should remove every one
    // and instead iterate the registry listing.
    expect(source).toContain('listPreToolValidatorSpecialists');
    expect(source).not.toMatch(/registerCartridgeStewardValidators/);
    expect(source).not.toMatch(/registerMovementWardenPreToolValidator/);
    expect(source).not.toMatch(/registerEnvironmentStatePreToolValidator/);
    expect(source).not.toMatch(/registerVoiceWardenPreToolValidator/);
    expect(source).not.toMatch(/registerFinalizationGuards/);
  });
});
