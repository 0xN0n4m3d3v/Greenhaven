import {useEffect} from 'react';
import type {Dispatch, RefObject, SetStateAction} from 'react';
import {EventsOn} from '../bridge/platform';
import type {TurnJobSnapshot} from '../types/app';

export function usePlayerMessageCreated(
  pendingJobRef: RefObject<TurnJobSnapshot | null>,
  setOptimisticUser: Dispatch<SetStateAction<string>>,
  setPendingJob: Dispatch<SetStateAction<TurnJobSnapshot | null>>,
): void {
  useEffect(() => {
    const off = EventsOn('player:message_created', (...evArgs: unknown[]) => {
      const payload = evArgs[0] as {turnId?: string; text?: string} | undefined;
      const job = pendingJobRef.current;
      if (!job || job.id !== payload?.turnId || !payload.text) return;
      setOptimisticUser(payload.text);
      setPendingJob(current =>
        current && current.id === payload.turnId
          ? {
              ...current,
              status: 'running',
              startedAt: current.startedAt ?? Date.now(),
            }
          : current,
      );
    });
    return () => off();
  }, [pendingJobRef, setOptimisticUser, setPendingJob]);
}
