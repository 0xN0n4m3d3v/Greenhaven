/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-12 — data-driven broker-profile → turn-context scope mapping.
//
// The previous home of this logic was a private `profile === X ||
// profile === Y || …` chain inside `RouteResolutionPhase.ts`. Moving
// the table into a typed `Record<BrokerToolProfile, …>` here means
// adding a new broker profile to the union in `toolsets.ts` now forces
// a compile-time addition here too — TypeScript will refuse to compile
// the map if any profile key is missing. The runtime behavior is
// unchanged: `scripted` route scope always wins; the previous
// focused-dialogue allow-list still promotes to `focused_dialogue`;
// the remaining profiles preserve the route-decided scope.

import type {BrokerToolProfile} from './toolsets.js';
import type {TurnContextScope} from '../turnContext/index.js';

/** What the helper should do with the broker profile when the route
 *  scope is not `'scripted'`. `'focused_dialogue'` promotes the scope
 *  to focused-dialogue; `'route'` keeps the route-decided scope. */
type ProfileScopeAction = 'focused_dialogue' | 'route';

export const PROFILE_SCOPE_ACTIONS: Readonly<
  Record<BrokerToolProfile, ProfileScopeAction>
> = {
  adventure_accept: 'focused_dialogue',
  adventure_ignore: 'focused_dialogue',
  commerce_bargain: 'focused_dialogue',
  commerce_social: 'route',
  default: 'route',
  environment_probe: 'route',
  intimacy_social: 'focused_dialogue',
  movement_social: 'focused_dialogue',
  quest_detail: 'focused_dialogue',
  quest_seed: 'focused_dialogue',
  scene_trade: 'focused_dialogue',
  state_recap: 'focused_dialogue',
};

/** Promote the broker scope from the route-decided `routeScope` to
 *  `focused_dialogue` for the dialogue-style broker profiles listed
 *  in `PROFILE_SCOPE_ACTIONS`; leave `scripted` scope alone. */
export function contextScopeForBrokerProfile(
  routeScope: TurnContextScope,
  profile: BrokerToolProfile,
): TurnContextScope {
  if (routeScope === 'scripted') return routeScope;
  return PROFILE_SCOPE_ACTIONS[profile] === 'focused_dialogue'
    ? 'focused_dialogue'
    : routeScope;
}
