/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// X-3 classifier-hint refactor — focused parser tests for
// `parseTurnRouteDecision`. The structured `MODE=…`, `PROFILE=…`,
// `DIALOGUE_ACT=…` output is what `resolveTurnRoute` reads to drive
// broker tool-profile selection and dialogue focus reconciliation, so
// the parser must be tolerant (the model occasionally emits stray
// labels or only the bare mode) and must default safely when fields
// are missing.

import {describe, expect, it} from 'vitest';
import {parseTurnRouteDecision} from '../../ai/classifier.js';
import {brokerToolProfileForTurn} from '../../ai/toolsets.js';

describe('parseTurnRouteDecision', () => {
  it('parses the canonical three-line structured output', () => {
    const decision = parseTurnRouteDecision(
      'MODE=DIALOGUE\nPROFILE=STATE_RECAP\nDIALOGUE_ACT=NONE',
    );
    expect(decision).toEqual({
      mode: 'dialogue',
      profile: 'state_recap',
      dialogueAct: 'none',
    });
  });

  it('accepts colon separators and stray whitespace around values', () => {
    const decision = parseTurnRouteDecision(
      '  MODE :  DIALOGUE  \n PROFILE :  COMMERCE_BARGAIN \nDIALOGUE_ACT :ACTION  ',
    );
    expect(decision).toEqual({
      mode: 'dialogue',
      profile: 'commerce_bargain',
      dialogueAct: 'action',
    });
  });

  it('is case-insensitive on both keys and values', () => {
    const decision = parseTurnRouteDecision(
      'mode=intimacy\nprofile=default\ndialogue_act=farewell',
    );
    expect(decision).toEqual({
      mode: 'intimacy',
      profile: 'default',
      dialogueAct: 'farewell',
    });
  });

  it('accepts the `DialogueAct` and bare `Dialogue` key aliases', () => {
    const aliasDecision = parseTurnRouteDecision(
      'MODE=DIALOGUE\nPROFILE=DEFAULT\nDialogueAct=FAREWELL',
    );
    expect(aliasDecision.dialogueAct).toBe('farewell');
    const bareDecision = parseTurnRouteDecision(
      'MODE=DIALOGUE\nPROFILE=DEFAULT\nDIALOGUE=FAREWELL',
    );
    expect(bareDecision.dialogueAct).toBe('farewell');
  });

  it('defaults missing fields to safe values (default profile, none act)', () => {
    const decision = parseTurnRouteDecision('MODE=COMBAT');
    expect(decision).toEqual({
      mode: 'combat',
      profile: 'default',
      dialogueAct: 'none',
    });
  });

  it('infers mode from a legacy bare label when no MODE= line exists', () => {
    const decision = parseTurnRouteDecision('DIALOGUE');
    expect(decision.mode).toBe('dialogue');
    expect(decision.profile).toBe('default');
    expect(decision.dialogueAct).toBe('none');
  });

  it('falls back to exploration when the classifier emits garbage', () => {
    const decision = parseTurnRouteDecision('???');
    expect(decision).toEqual({
      mode: 'exploration',
      profile: 'default',
      dialogueAct: 'none',
    });
  });

  it('falls back to safe enum when an out-of-range value appears', () => {
    const decision = parseTurnRouteDecision(
      'MODE=DIALOGUE\nPROFILE=UNKNOWN_FLAVOR\nDIALOGUE_ACT=MAYBE',
    );
    expect(decision).toEqual({
      mode: 'dialogue',
      profile: 'default',
      dialogueAct: 'none',
    });
  });

  it('honours the first occurrence of duplicated keys', () => {
    const decision = parseTurnRouteDecision(
      'MODE=DIALOGUE\nMODE=COMBAT\nPROFILE=STATE_RECAP\nPROFILE=DEFAULT\nDIALOGUE_ACT=FAREWELL\nDIALOGUE_ACT=NONE',
    );
    expect(decision).toEqual({
      mode: 'dialogue',
      profile: 'state_recap',
      dialogueAct: 'farewell',
    });
  });
});

describe('brokerToolProfileForTurn (pure selector)', () => {
  it('maps profile hints to focused profiles', () => {
    expect(brokerToolProfileForTurn('dialogue', 'state_recap')).toBe(
      'state_recap',
    );
    expect(brokerToolProfileForTurn('dialogue', 'scene_trade')).toBe(
      'scene_trade',
    );
    expect(brokerToolProfileForTurn('dialogue', 'commerce_bargain')).toBe(
      'commerce_bargain',
    );
  });

  it('returns the default profile when the hint is default', () => {
    expect(brokerToolProfileForTurn('exploration', 'default')).toBe('default');
    expect(brokerToolProfileForTurn('dialogue', 'default')).toBe('default');
  });

  it('forces intimacy_social when the mode is intimacy regardless of hint', () => {
    expect(brokerToolProfileForTurn('intimacy', 'state_recap')).toBe(
      'intimacy_social',
    );
    expect(brokerToolProfileForTurn('intimacy', 'default')).toBe(
      'intimacy_social',
    );
  });

  it('defaults the profile hint argument to "default"', () => {
    expect(brokerToolProfileForTurn('travel')).toBe('default');
  });
});
