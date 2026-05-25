import type {ReactNode} from 'react';
import type {SystemEvent, Translator} from './EventCardTypes';

function numberPayload(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = Number(payload[key]);
  return Number.isFinite(value) ? value : null;
}

function renderQuestPacerMetrics(
  event: SystemEvent,
  payload: Record<string, unknown>,
): ReactNode | null {
  if (event.type === 'quest_pacer:overload') {
    const activeCount = numberPayload(payload, 'activeCount');
    const threshold = numberPayload(payload, 'threshold');
    if (activeCount == null || threshold == null) return null;
    return (
      <p className="event-card-meta event-card-meta--stacked">
        <span className="event-card-delta neg">{activeCount}</span>
        {' / '}
        {threshold}
      </p>
    );
  }

  if (event.type === 'quest_pacer:stale') {
    const elapsedHours = numberPayload(payload, 'elapsedHours');
    if (elapsedHours == null) return null;
    return (
      <p className="event-card-meta event-card-meta--stacked">
        {elapsedHours}h
      </p>
    );
  }

  if (event.type === 'quest_pacer:dead_npc_arc') {
    const deadArcDays = numberPayload(payload, 'deadArcDays');
    const elapsedHours = numberPayload(payload, 'elapsedHours');
    if (deadArcDays == null && elapsedHours == null) return null;
    return (
      <p className="event-card-meta event-card-meta--stacked">
        {deadArcDays != null ? `${deadArcDays}+d` : ''}
        {deadArcDays != null && elapsedHours != null ? ' / ' : ''}
        {elapsedHours != null ? `${elapsedHours}h` : ''}
      </p>
    );
  }

  return null;
}

export function renderQuestBody(
  event: SystemEvent,
  t: Translator,
): ReactNode | undefined {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'quest:created':
    case 'quest:started': {
      const title = (p['title'] as string) ?? '?';
      const giver = (p['giverName'] as string) ?? null;
      const goal = (p['goal'] as string) ?? null;
      const rewards = p['rewards'] as
        | {xp?: number; strings?: Array<{npc: string; delta: number}>}
        | null;
      return (
        <>
          <span className="event-card-title">«{title}»</span>
          {giver && (
            <span className="event-card-meta">
              {t('ui.event_card.body.quest.from')}{' '}
              <span className="event-card-actor">{giver}</span>
            </span>
          )}
          {goal && <p className="event-card-goal">{goal}</p>}
          {rewards && (
            <div className="event-card-rewards">
              {typeof rewards.xp === 'number' && rewards.xp > 0 && (
                <span className="reward-xp">+{rewards.xp} XP</span>
              )}
              {Array.isArray(rewards.strings) &&
                rewards.strings.map((s, i) => (
                  <span key={i} className="reward-string">
                    {s.delta > 0 ? '+' : ''}
                    {s.delta} {t('ui.event_card.body.quest.bond_shift')} ({s.npc})
                  </span>
                ))}
            </div>
          )}
        </>
      );
    }
    case 'quest:advanced': {
      const title = (p['title'] as string) ?? '?';
      const stage = (p['stageId'] as string) ?? null;
      return (
        <>
          <span className="event-card-title">«{title}»</span>
          {stage && (
            <span className="event-card-meta">
              {t('ui.event_card.body.quest.stage')}: {stage}
            </span>
          )}
        </>
      );
    }
    case 'quest:auto_advanced': {
      const title =
        (p['title'] as string) ??
        (p['questTitle'] as string) ??
        String(p['quest_id'] ?? '?');
      const stage = (p['to_stage'] as string) ?? null;
      const reason = (p['reason'] as string) ?? null;
      const completed = p['completed'] === true;
      return (
        <>
          <span className="event-card-title">«{title}»</span>
          <span className="event-card-meta">
            {' '}
            {completed
              ? t('ui.event_card.body.quest.auto_completed')
              : t('ui.event_card.body.quest.auto_advanced')}
          </span>
          {stage && (
            <span className="event-card-meta">
              {' '}({t('ui.event_card.body.quest.stage')}: {stage})
            </span>
          )}
          {reason && <p className="event-card-quote">{reason}</p>}
        </>
      );
    }
    case 'quest:completed': {
      const title = (p['title'] as string) ?? '?';
      const outcome = (p['outcome'] as string) ?? 'completed';
      const rewardsApplied = p['rewardsApplied'] as
        | {xp?: number; strings?: Array<{npc: string; delta: number}>}
        | null;
      const failed = outcome === 'failed';
      return (
        <>
          <span className="event-card-title">«{title}»</span>
          <span className={`event-card-outcome ${failed ? 'failed' : 'success'}`}>
            {failed
              ? t('ui.event_card.body.quest.failed')
              : t('ui.event_card.body.quest.success')}
          </span>
          {rewardsApplied && (
            <div className="event-card-rewards">
              {typeof rewardsApplied.xp === 'number' && rewardsApplied.xp > 0 && (
                <span className="reward-xp">+{rewardsApplied.xp} XP</span>
              )}
              {Array.isArray(rewardsApplied.strings) &&
                rewardsApplied.strings.map((s, i) => (
                  <span key={i} className="reward-string">
                    {s.delta > 0 ? '+' : ''}
                    {s.delta} {s.npc}
                  </span>
                ))}
            </div>
          )}
        </>
      );
    }
    case 'quest:choice_required': {
      const title =
        (p['questTitle'] as string) ?? (p['title'] as string) ?? '?';
      const options = p['options'] as
        | Array<{label?: string; id?: string}>
        | undefined;
      return (
        <>
          <span className="event-card-title">«{title}»</span>
          <span className="event-card-meta">
            {' - '}
            {t('ui.event_card.body.quest.choice_required')}
          </span>
          {Array.isArray(options) && options.length > 0 && (
            <ul className="event-card-list">
              {options.map((o, i) => (
                <li key={i}>
                  {o.label ??
                    o.id ??
                    t('ui.event_card.body.quest.option', {n: i + 1})}
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'quest_pacer:overload':
    case 'quest_pacer:stale':
    case 'quest_pacer:dead_npc_arc': {
      const title = (p['questTitle'] as string | null) ?? null;
      const giver = (p['giverName'] as string | null) ?? null;
      const details = (p['details'] as string) ?? '';
      const suggestion = (p['suggestion'] as string) ?? '';
      const metrics = renderQuestPacerMetrics(event, p);
      return (
        <>
          {title && <span className="event-card-title">«{title}»</span>}
          {giver && (
            <span className="event-card-meta">
              {' '}
              {t('ui.event_card.body.quest.from')}{' '}
              <span className="event-card-actor">@{giver}</span>
            </span>
          )}
          {metrics}
          {!metrics && details && <p className="event-card-quote">{details}</p>}
          {!metrics && suggestion && (
            <p className="event-card-meta event-card-meta--compact-stacked">
              ↳ {suggestion}
            </p>
          )}
        </>
      );
    }
    default:
      return undefined;
  }
}
