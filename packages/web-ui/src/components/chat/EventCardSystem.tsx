import type {ReactNode} from 'react';
import type {SystemEvent, Translator} from './EventCardTypes';

export function renderSystemBody(
  event: SystemEvent,
  t: Translator,
): ReactNode | undefined {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'narrate:quarantined': {
      const reason = (p['reason'] as string) ?? 'unknown';
      const author = (p['author'] as string | null) ?? null;
      const turnId = (p['turnId'] as string | null) ?? null;
      const reasonLabel = t('ui.event_card.body.narrate.reason');
      const authorLabel = t('ui.event_card.body.narrate.author');
      return (
        <>
          <span className="event-card-meta">
            {t('ui.event_card.body.narrate.hidden')}
          </span>
          <p className="event-card-meta event-card-meta--compact-stacked">
            {reasonLabel}: {reason}
            {author ? `; ${authorLabel}: ${author}` : ''}
            {turnId ? `; turn: ${turnId}` : ''}
          </p>
        </>
      );
    }
    case 'post_turn:slot_failed': {
      const hookName = (p['hookName'] as string) ?? 'post-turn';
      const status = (p['status'] as string) ?? 'failed';
      const reason = (p['reason'] as string) ?? 'unknown';
      return (
        <>
          <span className="event-card-meta">
            {t('ui.event_card.body.post_turn.delayed')}
          </span>
          <p className="event-card-meta event-card-meta--compact-stacked">
            {hookName}; {status}; {reason}
          </p>
        </>
      );
    }
    default:
      return undefined;
  }
}
