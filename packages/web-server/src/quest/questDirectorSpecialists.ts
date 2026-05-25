/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {QuestDirectorPhase} from './questDirectorPacket.js';

export const QUEST_DIRECTOR_SPECIALISTS: Record<
  QuestDirectorPhase,
  readonly string[]
> = {
  mobilizing: ['quest_pacer', 'catalogue_scout'],
  planning: ['quest_watcher', 'adventure_oracle'],
  executing: ['quest_watcher', 'npc_voice', 'movement_warden'],
  reviewing: ['quest_watcher', 'dialogue_anchor'],
  blocked: ['quest_pacer', 'movement_warden', 'catalogue_scout'],
  recovering: ['quest_pacer', 'dialogue_anchor', 'npc_voice'],
  settled: ['npc_voice'],
};

export function recommendedSpecialistsForPhase(
  phase: QuestDirectorPhase,
): string[] {
  return [...(QUEST_DIRECTOR_SPECIALISTS[phase] ?? [])];
}

