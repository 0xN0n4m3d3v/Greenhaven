/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// USER-4 phase — Spec 33 environmental surface decay. Drops expired
// `active_surfaces` entries so the broker doesn't see stale physics
// state for the new turn.

import {decrementSurfaces} from '../../transitionEngine.js';
import type {Phase} from '../Phase.js';
import type {TurnContext} from '../TurnContext.js';

export const decrementSurfacesPhase: Phase = {
  name: 'decrement_surfaces',
  async run(context: TurnContext): Promise<void> {
    await decrementSurfaces(context.session.id);
  },
};
