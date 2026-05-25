/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-12 — verifies the data-driven broker-profile → turn-context
// scope mapping. Three branches:
//   1. `scripted` route scope always wins (every profile preserves it).
//   2. Profiles in the focused-dialogue allow-list promote any non-
//      scripted route scope to `focused_dialogue`.
//   3. Profiles outside the allow-list keep the route-decided scope.

import {describe, expect, it} from 'vitest';
import {
  contextScopeForBrokerProfile,
  PROFILE_SCOPE_ACTIONS,
} from '../../ai/profileScopes.js';
import type {BrokerToolProfile} from '../../ai/toolsets.js';
import type {TurnContextScope} from '../../turnContext/index.js';

const ALL_PROFILES = Object.keys(
  PROFILE_SCOPE_ACTIONS,
) as BrokerToolProfile[];

const PROMOTED_PROFILES: BrokerToolProfile[] = [
  'adventure_accept',
  'adventure_ignore',
  'commerce_bargain',
  'intimacy_social',
  'movement_social',
  'quest_detail',
  'quest_seed',
  'scene_trade',
  'state_recap',
];

const ROUTE_PRESERVING_PROFILES: BrokerToolProfile[] = [
  'commerce_social',
  'default',
  'environment_probe',
];

const NON_SCRIPTED_SCOPES: TurnContextScope[] = [
  'full',
  'narration',
  'focused_dialogue',
  'exploration',
  'travel',
  'dialogue',
  'combat',
  'intimacy',
  'rest',
];

describe('contextScopeForBrokerProfile', () => {
  it('preserves scripted route scope for every broker profile', () => {
    for (const profile of ALL_PROFILES) {
      expect(contextScopeForBrokerProfile('scripted', profile), profile).toBe(
        'scripted',
      );
    }
  });

  it('promotes the focused-dialogue allow-list to focused_dialogue when the route scope is non-scripted', () => {
    for (const profile of PROMOTED_PROFILES) {
      for (const scope of NON_SCRIPTED_SCOPES) {
        expect(
          contextScopeForBrokerProfile(scope, profile),
          `${profile}/${scope}`,
        ).toBe('focused_dialogue');
      }
    }
  });

  it('preserves the route scope for profiles outside the allow-list', () => {
    for (const profile of ROUTE_PRESERVING_PROFILES) {
      for (const scope of NON_SCRIPTED_SCOPES) {
        expect(
          contextScopeForBrokerProfile(scope, profile),
          `${profile}/${scope}`,
        ).toBe(scope);
      }
    }
  });

  it('covers every BrokerToolProfile in the map (exhaustiveness sentry)', () => {
    const expected: BrokerToolProfile[] = [
      'adventure_accept',
      'adventure_ignore',
      'commerce_bargain',
      'commerce_social',
      'default',
      'environment_probe',
      'intimacy_social',
      'movement_social',
      'quest_detail',
      'quest_seed',
      'scene_trade',
      'state_recap',
    ];
    expect(ALL_PROFILES.sort()).toEqual(expected.sort());
  });
});
