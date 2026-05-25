/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — Spec 36 § 6 prompt-injection guard.
//
// Layer-1 regex over the raw player text. Flagged inputs are wrapped
// as `[USER_INPUT]"..."[/USER_INPUT]` so the model sees them as quoted
// literal user content. Never blocks; just logs the matched pattern
// for post-hoc review and rewrites `context.input.text` in place so
// later phases / the broker / message persistence all see the
// neutralised text.

import {guardPlayerInput} from '../../security/promptInjectionGuard.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export const promptGuardPhase: Phase = {
  name: 'prompt_guard',
  async run(context: TurnContext): Promise<void> {
    const guarded = guardPlayerInput(context.input.text);
    if (guarded.flagged) {
      console.warn(
        `[turnV2 ${context.turnId}] prompt-injection pattern matched: ` +
          `"${guarded.matchedPattern}" - neutralised, not blocked.`,
      );
      context.input.text = guarded.text;
    }
  },
};
