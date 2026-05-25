import {useCallback, useEffect, useState, type SetStateAction} from 'react';
import {fetchCharacterClasses} from '../../../bridge/character';
import type {ClassRow} from '../wizardTypes';
import type {
  CharacterCardState,
  CharacterDraft,
  CharacterSheet,
  SynthesisResult,
} from './types';
import {
  completeBackground,
  completeIdentity,
  completePhysical,
  cleanRationaleMap,
  cleanSkills,
  cleanStartingClassId,
  cleanStats,
} from './characterSanitizers';
import {createEmptyDraft} from './types';

type SheetField = keyof Pick<CharacterSheet, 'name' | 'description' | 'history'>;

export function useCharacterDraft(playerId: number, baseUrl = '', language?: string | null) {
  const [draft, setDraft] = useState<CharacterDraft>(() => createEmptyDraft(playerId));
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classLoadError, setClassLoadError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(createEmptyDraft(playerId));
  }, [playerId]);

  useEffect(() => {
    let alive = true;
    fetchCharacterClasses({language, baseUrl})
      .then(d => {
        if (alive) setClasses(d.classes);
      })
      .catch(err => {
        if (alive) setClassLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [baseUrl, language]);

  const patchSheet = useCallback((field: SheetField, value: string) => {
    setDraft(prev => ({
      ...prev,
      sheet: {...prev.sheet, [field]: value},
      synthesized: field === 'name' ? prev.synthesized : false,
    }));
  }, []);

  const replaceDescription = useCallback((text: string) => {
    setDraft(prev => ({
      ...prev,
      sheet: {
        ...prev.sheet,
        rawDescription: prev.sheet.rawDescription ?? prev.sheet.description,
        description: text,
      },
      synthesized: false,
    }));
  }, []);

  const replaceHistory = useCallback((text: string) => {
    setDraft(prev => ({
      ...prev,
      sheet: {
        ...prev.sheet,
        rawHistory: prev.sheet.rawHistory ?? prev.sheet.history,
        history: text,
      },
      synthesized: false,
    }));
  }, []);

  const setCard = useCallback(
    (updater: SetStateAction<CharacterCardState>) => {
      setDraft(prev => {
        const nextCard =
          typeof updater === 'function'
            ? (updater as (current: CharacterCardState) => CharacterCardState)(prev.card)
            : updater;
        return {...prev, card: nextCard};
      });
    },
    [],
  );

  const markClassOverridden = useCallback(() => {
    setDraft(prev => ({...prev, classOverridden: true}));
  }, []);

  const applySynthesis = useCallback((data: SynthesisResult) => {
    setDraft(prev => {
      const name = prev.sheet.name.trim();
      const hints = {
        name: name || data.identity?.name,
        description: prev.sheet.description,
        history: prev.sheet.history,
      };
      const identity = completeIdentity(data.identity, hints);
      const physical = completePhysical(data.physical, hints);
      const background = completeBackground(data.background, hints);
      const startingClassId = cleanStartingClassId(data.starting_class_id);
      const stats = cleanStats(data.stats);
      const skills = cleanSkills(data.skills);
      const skillRationale = cleanRationaleMap(data.skill_picks_rationale);
      return {
        ...prev,
        synthesized: true,
        card: {
          identity: {
            ...prev.card.identity,
            ...identity,
            name: identity.name,
          },
          physical: {...prev.card.physical, ...physical},
          background: {...prev.card.background, ...background},
          starting_class_id:
            startingClassId != null
              ? startingClassId
              : prev.card.starting_class_id,
          stats: stats ?? prev.card.stats,
          skills: skills.length > 0 ? skills : prev.card.skills,
          class_pick_rationale:
            data.class_pick_rationale ?? prev.card.class_pick_rationale,
          skill_picks_rationale:
            skillRationale ?? prev.card.skill_picks_rationale,
        },
      };
    });
  }, []);

  return {
    draft,
    setDraft,
    patchSheet,
    replaceDescription,
    replaceHistory,
    setCard,
    applySynthesis,
    markClassOverridden,
    classes,
    classLoadError,
  };
}
