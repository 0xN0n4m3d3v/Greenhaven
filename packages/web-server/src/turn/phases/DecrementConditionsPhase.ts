/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — Spec 17 condition decay. Drops expired conditions
// from every NPC's `conditions` runtime_value before we render the
// preamble. Safe no-op when no conditions field has ever been written.

import {decrementConditions} from '../../transitionEngine.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export const decrementConditionsPhase: Phase = {
  name: 'decrement_conditions',
  async run(context: TurnContext): Promise<void> {
    await decrementConditions(context.session.id);
  },
};
