/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  hasSuccessfulAuthoredSceneOpen,
  shouldApplyAbsentNpcDialogueFallback,
} from '../narrationSynthesis.js';
import type {ToolHistoryEntry} from '../sessionManager.js';

function tool(name: string, ok = true): ToolHistoryEntry {
  return {
    name,
    ok,
    args: {},
    source: 'ai_sdk',
  };
}

describe('narrationSynthesis voice repair guards', () => {
  it('keeps scene-opening dialogue turns from being replaced with absent-speaker fallback', () => {
    expect(hasSuccessfulAuthoredSceneOpen([tool('open_authored_scene')])).toBe(
      true,
    );
  });

  it('does not treat failed or unrelated tools as authored-scene evidence', () => {
    expect(
      hasSuccessfulAuthoredSceneOpen([
        tool('open_authored_scene', false),
        tool('narrate'),
      ]),
    ).toBe(false);
    expect(hasSuccessfulAuthoredSceneOpen([tool('start_quest')])).toBe(false);
    expect(hasSuccessfulAuthoredSceneOpen(undefined)).toBe(false);
  });

  it('does not replace ordinary location scene narration with absent-speaker fallback', () => {
    expect(
      shouldApplyAbsentNpcDialogueFallback({
        text:
          'You kneel beside the dead man. The floor is sticky, the fume hood hums, and a receipt peeks out from one shoe.',
        suggestedSpeakerName: null,
        candidateNames: [],
        toolHistory: [tool('record_location_memory')],
      }),
    ).toBe(false);
  });

  it('allows absent-speaker fallback only for direct speech-shaped location prose', () => {
    expect(
      shouldApplyAbsentNpcDialogueFallback({
        text:
          '"Wait here," says a voice from the locked office, but nobody visible can carry that line.',
        suggestedSpeakerName: null,
        candidateNames: [],
        toolHistory: [tool('query_entity')],
      }),
    ).toBe(true);
  });

  it('keeps successful authored scene openings from being treated as absent speakers', () => {
    expect(
      shouldApplyAbsentNpcDialogueFallback({
        text: '"You came quickly," says the figure at the hatch.',
        suggestedSpeakerName: null,
        candidateNames: [],
        toolHistory: [tool('open_authored_scene')],
      }),
    ).toBe(false);
  });
});
