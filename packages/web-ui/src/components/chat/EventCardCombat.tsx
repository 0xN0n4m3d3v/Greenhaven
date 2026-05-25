import type {ReactNode} from 'react';
import type {SystemEvent, Translator} from './EventCardTypes';

export function renderCombatBody(
  event: SystemEvent,
  t: Translator,
): ReactNode | undefined {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'damage:dealt': {
      const target = (p['targetName'] as string) ?? '?';
      const amount = Number(p['amount'] ?? 0);
      const hpAfter = Number(p['hpAfter'] ?? 0);
      const hpMax = Number(p['hpMax'] ?? 0);
      const defeated = Boolean(p['defeated']);
      const cond = p['condition'] as {tag?: string} | null;
      return (
        <>
          <span className="event-card-actor">{target}</span>
          {' '}
          <span className="event-card-delta neg">-{amount} HP</span>
          {' '}
          <span className="event-card-meta">
            ({hpAfter}/{hpMax})
          </span>
          {defeated && (
            <span className="event-card-outcome failed">
              {'- '}{t('ui.event_card.body.damage.defeated')}
            </span>
          )}
          {cond?.tag && <span className="event-card-tag">{cond.tag}</span>}
        </>
      );
    }
    case 'dice:rolled': {
      const roll = Number(p['roll'] ?? 0);
      const dc = p['dc'] as number | null | undefined;
      const outcome = p['outcome'] as string | null | undefined;
      const label = (p['label'] as string) ?? null;
      const total = p['total'] as number | undefined;
      const modifier = p['modifier'] as number | undefined;
      const roller = (p['roller'] as string) ?? 'player';
      const success = outcome === 'success';
      return (
        <>
          <span className="event-card-title">d20 = {roll}</span>
          {typeof modifier === 'number' && modifier !== 0 && (
            <span className="event-card-meta">
              {' '}
              {modifier > 0 ? '+' : ''}{modifier}
            </span>
          )}
          {typeof total === 'number' && total !== roll && (
            <span className="event-card-meta">
              {' '}={total}
            </span>
          )}
          {dc != null && (
            <span className="event-card-meta">
              {' '}
              {t('ui.event_card.body.dice.vs')} DC {dc}
            </span>
          )}
          {outcome && (
            <span className={`event-card-outcome ${success ? 'success' : 'failed'}`}>
              {success
                ? t('ui.event_card.body.dice.success')
                : t('ui.event_card.body.dice.failure')}
            </span>
          )}
          <span className="event-card-meta">
            {' '}
            ({roller === 'npc'
              ? t('ui.event_card.body.dice.roller_npc')
              : t('ui.event_card.body.dice.roller_player')})
          </span>
          {label && <p className="event-card-goal">{label}</p>}
        </>
      );
    }
    case 'npc:initiative': {
      const name = (p['npcName'] as string) ?? '?';
      const reason = (p['reason'] as string) ?? null;
      const score = p['score'] as number | undefined;
      return (
        <>
          <span className="event-card-actor">{name}</span>{' '}
          <span className="event-card-verb">
            {t('ui.event_card.body.npc_initiative.action')}
          </span>
          {typeof score === 'number' && (
            <span className="event-card-meta">
              {' '}
              ({t('ui.event_card.body.npc_initiative.score')}: {score.toFixed(2)})
            </span>
          )}
          {reason && <p className="event-card-quote">{reason}</p>}
        </>
      );
    }
    default:
      return undefined;
  }
}
