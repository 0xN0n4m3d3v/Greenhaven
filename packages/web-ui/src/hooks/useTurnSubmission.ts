import {useCallback} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import type {DiceRoll} from '../DiceBubble';
import {IS_DESKTOP_TARGET, __emit} from '../bridge/platform';
import {toast} from '../components/ui/use-toast';
import {rollInlineDice} from '../inlineDiceParser';
import {pollTurnJob, startTurn} from '../lib/bridge';
import {
  logFrontend,
  normalizeState,
  withTimeout,
} from '../lib/state';
import type {GameState, TurnJobSnapshot} from '../types/app';
import {
  ContinueLastTurn,
  ContinueLastTurnAsync,
  engine,
} from '../bridge/platform';

type Translate = (key: string) => string;

type UseTurnSubmissionArgs = {
  busy: boolean;
  t: Translate;
  setState: Dispatch<SetStateAction<GameState | null>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setPendingJob: Dispatch<SetStateAction<TurnJobSnapshot | null>>;
  setOptimisticUser: Dispatch<SetStateAction<string>>;
  setLiveDice: Dispatch<SetStateAction<DiceRoll[]>>;
  setDiceRevealed: Dispatch<SetStateAction<boolean>>;
  setDiceCheckRequested: Dispatch<SetStateAction<boolean>>;
};

export function useTurnSubmission({
  busy,
  t,
  setState,
  setDraft,
  setBusy,
  setError,
  setPendingJob,
  setOptimisticUser,
  setLiveDice,
  setDiceRevealed,
  setDiceCheckRequested,
}: UseTurnSubmissionArgs): {
  send: (message: string, actionId?: string, diceCheck?: boolean) => Promise<void>;
  continueScene: () => Promise<void>;
  applyTurnResult: (result: engine.TurnResult) => void;
} {
  const applyTurnResult = useCallback(
    (result: engine.TurnResult) => {
      // Preserve location/nearby fields the bridge runtime doesn't track.
      // They are owned by the `locations:updated` / `nearby:updated` SSE path
      // (useLocationUpdates). Without this preservation, applyTurnResult after
      // every turn.end clobbers them with the bridge's stale snapshot, which
      // causes the rail to revert to the location the player was in at
      // bootstrap regardless of how many moves happened mid-session.
      const incoming = result.state as GameState;
      setState(prev => {
        const merged = {
          ...incoming,
          currentLocation: prev?.currentLocation ?? incoming.currentLocation,
          locations:
            prev?.locations && prev.locations.length > 0
              ? prev.locations
              : incoming.locations,
          nearby:
            prev?.nearby && prev.nearby.length > 0 ? prev.nearby : incoming.nearby,
        } as GameState;
        return normalizeState(merged);
      });
      logFrontend('info', 'send_done', 'Player message processed', {
        provider: result.usedProvider,
        visible: (result as any).visible,
        patchReport: (result as any).patchReport,
      });
    },
    [setState],
  );

  const send = useCallback(
    async (message: string, actionId = '', diceCheck?: boolean) => {
      const rawTrimmed = message.trim();
      if (!rawTrimmed || busy) return;
      const diceResult = rollInlineDice(rawTrimmed);
      const trimmed = diceResult.rewritten;
      for (const roll of diceResult.rolls) {
        __emit('dice:rolled', {
          roll: roll.total,
          description: roll.match.notation,
          roller: 'player',
        });
      }
      if (diceResult.rolls.length > 0) {
        logFrontend('info', 'inline_dice_rolled', `${diceResult.rolls.length}`, {
          totals: diceResult.rolls.map(roll => roll.total),
        });
      }
      if (diceResult.rejected.length > 0) {
        logFrontend(
          'warn',
          'inline_dice_rejected',
          `${diceResult.rejected.length}`,
          {notations: diceResult.rejected.map(dice => dice.notation)},
        );
        toast({
          title: 'The dice refuse such asymmetry.',
          description: diceResult.rejected.map(dice => dice.notation).join(', '),
          variant: 'destructive',
        });
      }
      let keepFailedPending = false;
      setBusy(true);
      setError('');
      setPendingJob(null);
      setOptimisticUser('');
      setLiveDice([]);
      setDiceRevealed(false);
      setDiceCheckRequested(Boolean(diceCheck));
      logFrontend('info', 'send_start', 'Queueing player turn', {
        actionId,
        bytes: trimmed.length,
        text: trimmed,
      });
      try {
        const startedJob = await startTurn(trimmed, actionId);
        setDraft('');
        setPendingJob(startedJob);
        // USER-6 / UI-9 — never seed a player bubble from client text.
        // `optimisticUser` is now driven only by the server-confirmed
        // `message:created` SSE (see `usePlayerMessageCreated`).
        logFrontend('info', 'turn_job_queued', 'Turn job queued', {
          jobId: startedJob.id,
          status: startedJob.status,
          actionId,
        });

        const finalJob =
          startedJob.status === 'done' ||
          startedJob.status === 'error' ||
          startedJob.status === 'canceled'
            ? startedJob
            : await pollTurnJob(startedJob.id);
        setPendingJob(finalJob);

        if (finalJob.status === 'canceled') {
          logFrontend('info', 'send_canceled', 'Turn job canceled', {
            jobId: finalJob.id,
          });
          return;
        }
        if (finalJob.status === 'error') {
          keepFailedPending = true;
          setPendingJob({
            ...finalJob,
            text: finalJob.text ?? '',
            error: finalJob.error || `Turn job ${finalJob.id} failed`,
          });
          throw new Error(finalJob.error || `Turn job ${finalJob.id} failed`);
        }
        if (!finalJob.result) {
          throw new Error(`Turn job ${finalJob.id} finished without result`);
        }
        applyTurnResult(finalJob.result as engine.TurnResult);
      } catch (err) {
        keepFailedPending = true;
        const rawErrorMessage = err instanceof Error ? err.message : String(err);
        const errorMessage = rawErrorMessage.includes('queue_full')
          ? t('ui.error.queue_full')
          : rawErrorMessage;
        console.error('Greenhaven send failed', err);
        logFrontend('error', 'send_failed', errorMessage, {
          raw: rawErrorMessage,
          stack: err instanceof Error ? err.stack : undefined,
        });
        setPendingJob(
          current =>
            current ?? {
              id: `failed-${Date.now()}`,
              status: 'error',
              actionId,
              text: '',
              error: errorMessage,
              createdAt: Date.now(),
              finishedAt: Date.now(),
            },
        );
        setError(errorMessage);
      } finally {
        if (!keepFailedPending) {
          setPendingJob(null);
        }
        setLiveDice([]);
        setDiceRevealed(false);
        setDiceCheckRequested(false);
        setBusy(false);
        setOptimisticUser('');
      }
    },
    [
      applyTurnResult,
      busy,
      setBusy,
      setDiceCheckRequested,
      setDiceRevealed,
      setDraft,
      setError,
      setLiveDice,
      setOptimisticUser,
      setPendingJob,
      t,
    ],
  );

  const continueScene = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setOptimisticUser('');
    setLiveDice([]);
    setDiceRevealed(false);
    setDiceCheckRequested(false);
    logFrontend('info', 'continue_start', 'Continue last turn', {});
    let keepFailedPending = false;
    try {
      // U-2 / UI-7 / UI-8 — the async-job path is only meaningful on
      // the desktop target (real Wails-backed jobs + GetTurnJob polling);
      // the web target's `ContinueLastTurnAsync` is a noop, so we drop
      // straight to the sync `ContinueLastTurn()` fallback below.
      const startedJob = IS_DESKTOP_TARGET
        ? await withTimeout(
            ContinueLastTurnAsync() as Promise<TurnJobSnapshot>,
            8000,
            'ContinueLastTurnAsync',
          )
        : null;
      if (startedJob) {
        setPendingJob(startedJob);
        logFrontend('info', 'continue_queued', 'Continue job queued', {
          jobId: startedJob.id,
          status: startedJob.status,
        });
        const finalJob =
          startedJob.status === 'done' ||
          startedJob.status === 'error' ||
          startedJob.status === 'canceled'
            ? startedJob
            : await pollTurnJob(startedJob.id);
        setPendingJob(finalJob);
        if (finalJob.status === 'canceled') {
          logFrontend('info', 'continue_canceled', 'Continue job canceled', {
            jobId: finalJob.id,
          });
          return;
        }
        if (finalJob.status === 'error') {
          keepFailedPending = true;
          throw new Error(
            finalJob.error || `Continue job ${finalJob.id} failed`,
          );
        }
        if (finalJob.result) {
          applyTurnResult(finalJob.result as engine.TurnResult);
        }
      } else {
        const result = (await withTimeout(
          ContinueLastTurn() as Promise<engine.TurnResult>,
          70000,
          'ContinueLastTurn',
        )) as engine.TurnResult;
        applyTurnResult(result);
      }
      logFrontend('info', 'continue_done', 'Continue completed', {});
    } catch (err) {
      keepFailedPending = true;
      const message = err instanceof Error ? err.message : String(err);
      logFrontend('error', 'continue_failed', message, {});
      setError(message);
    } finally {
      if (!keepFailedPending) {
        setPendingJob(null);
      }
      setBusy(false);
    }
  }, [
    applyTurnResult,
    busy,
    setBusy,
    setDiceCheckRequested,
    setDiceRevealed,
    setError,
    setLiveDice,
    setOptimisticUser,
    setPendingJob,
  ]);

  return {send, continueScene, applyTurnResult};
}
