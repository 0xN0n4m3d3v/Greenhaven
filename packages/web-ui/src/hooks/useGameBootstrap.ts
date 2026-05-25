import {useCallback, useEffect} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import {
  loadPendingTurnJobs,
  loadState,
  pollTurnJob,
} from '../lib/bridge';
import {logFrontend, normalizeState} from '../lib/state';
import type {GameState, TurnJobSnapshot} from '../types/app';
import {engine} from '../bridge/platform';

type UseGameBootstrapArgs = {
  setState: Dispatch<SetStateAction<GameState | null>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setLoadingDetail: Dispatch<SetStateAction<string>>;
  setPendingJob: Dispatch<SetStateAction<TurnJobSnapshot | null>>;
  applyTurnResult: (result: engine.TurnResult) => void;
};

export function useGameBootstrap({
  setState,
  setBusy,
  setError,
  setLoadingDetail,
  setPendingJob,
  applyTurnResult,
}: UseGameBootstrapArgs): {retryLoadState: () => void} {
  const retryLoadState = useCallback(() => {
    setError('');
    setLoadingDetail('Retrying Greenhaven backend...');
    logFrontend('info', 'load_state_retry', 'Retrying load state');
    loadState()
      .then(nextState => setState(normalizeState(nextState)))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingDetail(''));
  }, [setError, setLoadingDetail, setState]);

  useEffect(() => {
    let alive = true;
    const onError = (event: ErrorEvent) => {
      logFrontend('error', 'window_error', event.message, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      logFrontend('error', 'unhandled_rejection', String(event.reason), {
        reason: event.reason,
      });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    setLoadingDetail('Waiting for Greenhaven backend...');
    logFrontend('info', 'load_state_start', 'Loading initial game state');
    loadState()
      .then(nextState => {
        if (!alive) return;
        setState(normalizeState(nextState));
        setError('');
        logFrontend('info', 'load_state_done', 'Initial game state loaded', {
          messages: nextState.messages?.length,
          dbPath: nextState.dbPath,
        });
        void loadPendingTurnJobs()
          .then(async jobs => {
            if (!alive || jobs.length === 0) return;
            const job = jobs.find(j => j.status === 'running') ?? jobs[0];
            if (!job) return;
            setPendingJob(job);
            setBusy(true);
            logFrontend(
              'info',
              'turn_queue_rehydrated',
              'Pending turn queue restored',
              {jobId: job.id, status: job.status, count: jobs.length},
            );
            const finalJob =
              job.status === 'done' ||
              job.status === 'error' ||
              job.status === 'canceled'
                ? job
                : await pollTurnJob(job.id);
            if (!alive) return;
            if (!finalJob) return;
            if (finalJob.status === 'done' && finalJob.result) {
              applyTurnResult(finalJob.result as engine.TurnResult);
              setPendingJob(null);
              return;
            }
            if (finalJob.status === 'error') {
              setPendingJob({
                ...finalJob,
                text: finalJob.text ?? '',
                error: finalJob.error || `Turn job ${finalJob.id} failed`,
              });
              setError(finalJob.error || `Turn job ${finalJob.id} failed`);
              return;
            }
            if (finalJob.status === 'canceled') {
              setPendingJob(null);
            }
          })
          .catch(err => {
            if (!alive) return;
            logFrontend(
              'error',
              'turn_queue_rehydrate_failed',
              err instanceof Error ? err.message : String(err),
              {},
            );
          })
          .finally(() => {
            if (alive) setBusy(false);
          });
      })
      .catch(err => {
        if (!alive) return;
        console.error('Greenhaven runtime load failed', err);
        logFrontend(
          'error',
          'load_state_failed',
          err instanceof Error ? err.message : String(err),
          {stack: err instanceof Error ? err.stack : undefined},
        );
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) {
          setLoadingDetail('');
        }
      });
    return () => {
      alive = false;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [
    applyTurnResult,
    setBusy,
    setError,
    setLoadingDetail,
    setPendingJob,
    setState,
  ]);

  return {retryLoadState};
}
