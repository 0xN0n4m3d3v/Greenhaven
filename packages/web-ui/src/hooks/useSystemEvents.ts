import {useCallback, useState} from 'react';
import type {SystemEvent} from '../components/chat/EventCard';

export function useSystemEvents(): {
  systemEvents: SystemEvent[];
  updateSystemEvents: (update: (prev: SystemEvent[]) => SystemEvent[]) => void;
  clearSystemEvents: () => void;
} {
  const [systemEvents, setSystemEvents] = useState<SystemEvent[]>([]);

  const updateSystemEvents = useCallback(
    (update: (prev: SystemEvent[]) => SystemEvent[]) => {
      setSystemEvents(prev => {
        const previousByEventId = new Map<number, SystemEvent>();
        for (const event of prev) {
          if (event.eventId != null) previousByEventId.set(event.eventId, event);
        }
        return update(prev).map(event => {
          if (event.eventId != null && event.turnId != null) return event;
          const previous =
            event.eventId != null
              ? previousByEventId.get(event.eventId)
              : undefined;
          if (!previous) return event;
          return {
            ...event,
            turnId: event.turnId ?? previous.turnId,
            messageId: event.messageId ?? previous.messageId,
            releaseSeq: event.releaseSeq ?? previous.releaseSeq,
            releasedAt: event.releasedAt ?? previous.releasedAt,
          };
        });
      });
    },
    [],
  );

  const clearSystemEvents = useCallback(() => {
    setSystemEvents([]);
  }, []);

  return {systemEvents, updateSystemEvents, clearSystemEvents};
}
