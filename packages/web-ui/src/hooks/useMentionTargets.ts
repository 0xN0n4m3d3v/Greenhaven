import {useCallback, useEffect, useMemo, useState} from 'react';
import {EventsOn} from '../bridge/platform';
import {
  localizedItemLookMessage,
  localizedTravelMessage,
} from '../lib/actionText';
import {
  buildMentionTargets,
  buildMentionTargetsFromAffordances,
} from '../lib/mentions';
import type {AffordanceAction} from '../types/affordance';
import type {GameState, MentionTarget} from '../types/app';

export function useMentionTargets(
  state: GameState | null,
  affordances: AffordanceAction[],
  uiLanguage: string | null | undefined,
): {
  mentionTargets: MentionTarget[];
  clearDiscoveredMentions: () => void;
} {
  const [discoveredMentions, setDiscoveredMentions] = useState<MentionTarget[]>(
    [],
  );
  const language = uiLanguage ?? 'en';

  const clearDiscoveredMentions = useCallback(() => {
    setDiscoveredMentions([]);
  }, []);

  useEffect(() => {
    const off = EventsOn('mentions:discovered', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as
        | Array<{id: number; name: string; kind: string}>
        | undefined;
      if (!Array.isArray(payload) || payload.length === 0) return;
      setDiscoveredMentions(prev => {
        const seen = new Set(prev.map(target => `${target.type}:${target.id}`));
        const next = [...prev];
        for (const mention of payload) {
          const type = (mention.kind || 'entity').toLowerCase();
          const key = `${type}:${mention.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const entry: MentionTarget = {
            id: mention.id,
            name: mention.name,
            type,
          };
          if (type === 'location' || type === 'scene') {
            entry.actionId = `${type}:${mention.id}`;
            entry.actionMessage = localizedTravelMessage(
              {name: mention.name, type},
              language,
            );
          } else if (type === 'item') {
            entry.actionId = `item:${mention.id}`;
            entry.actionMessage = localizedItemLookMessage(
              {name: mention.name},
              language,
            );
          }
          next.push(entry);
        }
        return next;
      });
    });
    return () => off();
  }, [language]);

  const mentionTargets = useMemo(() => {
    const fromState = state ? buildMentionTargets(state, language) : [];
    const fromAfford = buildMentionTargetsFromAffordances(
      affordances,
      language,
    );
    const seen = new Set<string>();
    const merged: MentionTarget[] = [];
    for (const target of [...fromState, ...fromAfford, ...discoveredMentions]) {
      const key = `${target.type || 'entity'}:${target.id}:${target.name}`;
      if (!target.name?.trim() || seen.has(key)) continue;
      seen.add(key);
      merged.push(target);
    }
    return merged;
  }, [state, affordances, discoveredMentions, language]);

  return {mentionTargets, clearDiscoveredMentions};
}
