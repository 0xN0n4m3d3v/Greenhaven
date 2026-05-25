// Spec 139 v2 — memory body is HIDDEN from the player UI.
//
//// player should never read what an NPC remembers, what they think to
// themselves, or what link reasons the broker computed. Surfacing those
// breaks the gameplay (player learns secrets they shouldn't know).
//
// The card stays as a content-less *notice* — "X noticed something" /
// "X recalled something" — with no body, no quote, no reflection.

import type {ReactNode} from 'react';
import type {SystemEvent, Translator} from './EventCardTypes';

function tx(t: Translator, key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function renderMemoryBody(
  event: SystemEvent,
  t: Translator,
): ReactNode | undefined {
  const p = event.payload as Record<string, unknown>;
  const owner = (p['ownerName'] as string) ?? '?';
  switch (event.type) {
    case 'memory:added': {
      const importance = Number(p['importance'] ?? 0);
      return (
        <>
          <span className="event-card-actor">{owner}</span>{' '}
          <span className="event-card-verb">
            {importance >= 0.8
              ? tx(t, 'ui.event_card.body.memory.noticed_strong', 'noticed something they will not forget')
              : tx(t, 'ui.event_card.body.memory.noticed', 'noticed something')}
            .
          </span>
        </>
      );
    }
    case 'memory:enriched': {
      return (
        <>
          <span className="event-card-actor">{owner}</span>{' '}
          <span className="event-card-verb">
            {tx(t, 'ui.event_card.body.memory.recalled', 'recalled something')}.
          </span>
        </>
      );
    }
    default:
      return undefined;
  }
}
