import type {SystemEvent} from './EventCard';

export function compareSystemEvents(a: SystemEvent, b: SystemEvent): number {
  if (a.releaseSeq != null && b.releaseSeq != null) return a.releaseSeq - b.releaseSeq;
  if (a.releaseSeq != null) return -1;
  if (b.releaseSeq != null) return 1;
  if (a.eventId != null && b.eventId != null) return a.eventId - b.eventId;
  if (a.eventId != null) return -1;
  if (b.eventId != null) return 1;
  return a.ts - b.ts;
}

export function orderedSystemEvents(events: SystemEvent[]): SystemEvent[] {
  return [...events].sort(compareSystemEvents);
}
