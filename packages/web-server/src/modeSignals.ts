/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Mode} from './ai/classifier.js';

export type ModeCue =
  | 'neutral'
  | 'triumphant'
  | 'grim'
  | 'tender'
  | 'abrupt'
  | 'contemplative';

export type ModeChangeReason =
  | 'boss_defeated'
  | 'enemy_routed'
  | 'escaped'
  | 'invitation_accepted'
  | 'intimate_initiated'
  | 'rest_started'
  | 'rest_ended'
  | 'travel_started'
  | 'travel_arrived'
  | 'dialogue_engaged'
  | 'dialogue_concluded'
  | 'scene_resolved'
  | 'scene_cut'
  | 'unknown';

export interface ModeSignalInput {
  from: Mode | null | undefined;
  to: Mode;
  text?: string;
  actionId?: string;
}

export interface ModeSignal {
  cue: ModeCue;
  reason: ModeChangeReason;
}

export function classifyModeSignal(input: ModeSignalInput): ModeSignal {
  const from = input.from ?? null;
  const to = input.to;
  const source = `${input.text ?? ''} ${input.actionId ?? ''}`.toLowerCase();

  if (!from) return {cue: 'neutral', reason: 'unknown'};

  if (from === 'combat' && to !== 'combat') {
    if (matches(source, ['escape', 'flee', 'retreat', 'run away', 'сбеж', 'беж', 'отступ'])) {
      return {cue: 'grim', reason: 'escaped'};
    }
    if (matches(source, ['rout', 'scatter', 'разбеж', 'рассеял'])) {
      return {cue: 'triumphant', reason: 'enemy_routed'};
    }
    if (matches(source, ['defeat', 'victor', 'kill', 'slay', 'dead', 'побед', 'убит', 'мертв'])) {
      return {cue: 'triumphant', reason: 'boss_defeated'};
    }
    return {cue: 'neutral', reason: 'scene_resolved'};
  }

  if (to === 'combat') return {cue: 'abrupt', reason: 'scene_cut'};
  if (to === 'intimacy') return {cue: 'tender', reason: 'intimate_initiated'};
  if (from === 'intimacy') {
    return {cue: 'tender', reason: 'scene_resolved'};
  }
  if (to === 'rest') return {cue: 'contemplative', reason: 'rest_started'};
  if (from === 'rest') {
    return {cue: 'contemplative', reason: 'rest_ended'};
  }
  if (to === 'travel') return {cue: 'contemplative', reason: 'travel_started'};
  if (from === 'travel') {
    return {cue: 'contemplative', reason: 'travel_arrived'};
  }
  if (to === 'dialogue') return {cue: 'contemplative', reason: 'dialogue_engaged'};
  if (from === 'dialogue') {
    return {cue: 'contemplative', reason: 'dialogue_concluded'};
  }

  return {cue: 'neutral', reason: 'unknown'};
}

function matches(source: string, needles: string[]): boolean {
  return needles.some(needle => source.includes(needle));
}
