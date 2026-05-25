/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — Spec 32 world-clock tick. Advances the session's
// time-of-day runtime field and emits the matching `runtime:field`
// event so the UI atmosphere layer can cross-fade dawn / day / dusk
// / night without a custom timer.

import {tickWorldClock} from '../../transitionEngine.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export const tickWorldClockPhase: Phase = {
  name: 'tick_world_clock',
  async run(context: TurnContext): Promise<void> {
    await tickWorldClock(context.session.id);
  },
};
