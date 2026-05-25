import type {SystemEvent} from './EventCard';
import {orderedSystemEvents} from './eventOrdering';

export interface EventOrderingFixtureReport {
  ok: true;
  arrivalOrder: number[];
  renderOrder: number[];
}

export function runEventOrderingFixture(): EventOrderingFixtureReport {
  const replayedOutOfArrivalOrder: SystemEvent[] = [
    systemEvent(102, 12, 'quest_pacer:stale'),
    systemEvent(101, 11, 'quest:auto_advanced'),
    systemEvent(103, 13, 'post_turn:slot_failed'),
  ];
  const renderOrder = orderedSystemEvents(replayedOutOfArrivalOrder).map(
    event => event.eventId ?? 0,
  );
  const expected = [101, 102, 103];
  if (renderOrder.join(',') !== expected.join(',')) {
    throw new Error(
      `system event release order drifted: ${renderOrder.join(',')}`,
    );
  }
  return {
    ok: true,
    arrivalOrder: replayedOutOfArrivalOrder.map(event => event.eventId ?? 0),
    renderOrder,
  };
}

function systemEvent(
  eventId: number,
  releaseSeq: number,
  type: SystemEvent['type'],
): SystemEvent {
  return {
    id: `fixture-${eventId}`,
    eventId,
    releaseSeq,
    releasedAt: `2026-05-03T00:00:${String(releaseSeq).padStart(2, '0')}Z`,
    turnId: 'fixture-turn',
    type,
    ts: releaseSeq,
    payload: {eventId, releaseSeq, turnId: 'fixture-turn'},
  };
}
