import type {ReactNode} from 'react';
import type {SystemEvent, Translator} from './EventCardTypes';

export function renderProgressBody(
  event: SystemEvent,
  t: Translator,
): ReactNode | undefined {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'string:changed': {
      const npc = (p['npcName'] as string) ?? '?';
      const delta = Number(p['delta'] ?? 0);
      const newValue = Number(p['newValue'] ?? 0);
      const band = (p['band'] as string) ?? null;
      const reason = (p['reason'] as string) ?? null;
      return (
        <>
          <span className="event-card-actor">{npc}</span>
          {' '}
          <span className={`event-card-delta ${delta > 0 ? 'pos' : 'neg'}`}>
            {delta > 0 ? '+' : ''}
            {delta}
          </span>
          {' '}
          <span className="event-card-meta">
            ({t('ui.event_card.body.string.now')} {newValue}
            {band && `, ${band}`})
          </span>
          {reason && <p className="event-card-quote">{reason}</p>}
        </>
      );
    }
    case 'xp:awarded': {
      const amount = Number(p['amount'] ?? 0);
      const reason = (p['reason'] as string) ?? null;
      return (
        <>
          <span className="event-card-delta pos">+{amount} XP</span>
          {reason && <span className="event-card-meta"> - {reason}</span>}
        </>
      );
    }
    case 'xp:levelup': {
      const level = Number(p['level'] ?? 0);
      return (
        <span className="event-card-title">
          {t('ui.event_card.body.xp.level')} {level}
        </span>
      );
    }
    case 'inspiration:gained':
    case 'inspiration:spent': {
      const reason = (p['reason'] as string) ?? null;
      return reason ? <span className="event-card-meta">{reason}</span> : null;
    }
    case 'sex_move:fired': {
      const partner = (p['partnerName'] as string) ?? '?';
      const hint = (p['narrate_hint'] as string) ?? null;
      return (
        <>
          <span className="event-card-actor">{partner}</span>
          {hint && <p className="event-card-quote">{hint}</p>}
        </>
      );
    }
    case 'intimacy:trigger': {
      const tag = (p['triggerTag'] as string) ?? (p['tag'] as string) ?? null;
      const partner = (p['partnerName'] as string) ?? null;
      return (
        <>
          {partner && <span className="event-card-actor">{partner}</span>}
          {tag && <span className="event-card-tag">{tag}</span>}
        </>
      );
    }
    default:
      return undefined;
  }
}
