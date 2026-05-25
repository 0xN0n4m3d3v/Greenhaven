import {
  patchCharacterProfile,
  postCharacterSkills,
  postCharacterStats,
} from '../../../bridge/character';
import type {CharacterDraft} from './types';
import {DEFAULT_CHARACTER_STATS} from './types';
import {
  completeBackground,
  completeIdentity,
  completePhysical,
  cleanSkills,
  cleanStartingClassId,
  cleanStats,
} from './characterSanitizers';

export async function commitCharacterDraft(
  draft: CharacterDraft,
  baseUrl = '',
): Promise<void> {
  const playerId = draft.playerId;
  const card = draft.card;
  const displayName = (card.identity.name ?? draft.sheet.name).trim();
  const description = draft.sheet.description.trim();
  const history = draft.sheet.history.trim();

  if (!displayName) throw new Error('Character name is required.');
  if (!description) throw new Error('Character description is required.');
  if (!history) throw new Error('Character history is required.');
  const startingClassId = cleanStartingClassId(card.starting_class_id);
  if (startingClassId == null) throw new Error('Choose a class before starting.');

  const stats = cleanStats(card.stats) ?? DEFAULT_CHARACTER_STATS;
  const hints = {name: displayName, description, history};
  const identity = completeIdentity(card.identity, hints);
  const physical = completePhysical(card.physical, hints);
  const background = completeBackground(card.background, hints);
  const skills = cleanSkills(card.skills);

  await patchCharacterProfile({
    playerId,
    baseUrl,
    body: {
      identity,
      physical,
      background,
      starting_class_id: startingClassId,
      creator_sheet: {
        name: displayName,
        description,
        history,
        rawDescription: draft.sheet.rawDescription,
        rawHistory: draft.sheet.rawHistory,
      },
      synthesized_class_overridden: draft.classOverridden,
    },
  });

  await postCharacterStats({
    playerId,
    baseUrl,
    scores: stats,
    method: 'point_buy',
  });

  await postCharacterSkills({playerId, baseUrl, picks: skills});

  await patchCharacterProfile({
    playerId,
    baseUrl,
    body: {created: true},
  });
}
