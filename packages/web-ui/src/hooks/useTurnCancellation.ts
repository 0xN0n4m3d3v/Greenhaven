import {useEffect} from 'react';
import type {RefObject} from 'react';
import {CancelTurnJob} from '../bridge/platform';
import {logFrontend} from '../lib/state';
import type {TurnJobSnapshot} from '../types/app';

export function useTurnCancellation(
  pendingJobRef: RefObject<TurnJobSnapshot | null>,
): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      const job = pendingJobRef.current;
      if (!job || (job.status !== 'queued' && job.status !== 'running')) {
        return;
      }
      event.preventDefault();
      logFrontend('info', 'cancel_requested', 'ESC pressed; cancelling turn job', {
        jobId: job.id,
        status: job.status,
      });
      CancelTurnJob(job.id).catch(err => {
        logFrontend(
          'error',
          'cancel_failed',
          err instanceof Error ? err.message : String(err),
          {jobId: job.id},
        );
      });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingJobRef]);
}
