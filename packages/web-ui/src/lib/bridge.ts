// Spec 29 §A.3 — bridge wrappers extracted from App.tsx so the App
// component is JSX-only. Pure functions; same browser-fallback +
// Wails-backed semantics.

import {
  GetGameState,
  GetPendingTurnJobs,
  ResetGame,
  SubmitPlayerActionAsync,
  SubmitPlayerMessageAsync,
  WaitForTurnJob,
  engine,
} from '../bridge/platform';
import {browserFallbackState} from './fallbackState';
import {delay, hasWailsBackend, withTimeout} from './state';
import type {GameState, TurnJobSnapshot} from '../types/app';

async function waitForWailsBackend(timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (hasWailsBackend()) return true;
    await delay(100);
  }
  return hasWailsBackend();
}

export async function loadState(): Promise<GameState> {
  if (!hasWailsBackend()) {
    const ready = await waitForWailsBackend(5000);
    if (!ready) return browserFallbackState;
  }
  return withTimeout(GetGameState(), 12000, 'GetGameState');
}

export async function loadPendingTurnJobs(): Promise<TurnJobSnapshot[]> {
  if (!hasWailsBackend()) return [];
  return withTimeout(
    GetPendingTurnJobs() as Promise<TurnJobSnapshot[]>,
    8000,
    'GetPendingTurnJobs',
  );
}

export async function startTurn(
  message: string,
  actionId = '',
): Promise<TurnJobSnapshot> {
  if (!hasWailsBackend()) {
    return {
      id: 'browser-preview',
      status: 'done',
      actionId,
      text: message,
      createdAt: Date.now(),
      result: {
        state: browserFallbackState,
        usedProvider: 'browser-preview',
      } as engine.TurnResult,
    };
  }
  const promise = actionId
    ? SubmitPlayerActionAsync(actionId, message)
    : SubmitPlayerMessageAsync(message);
  return withTimeout(
    promise as Promise<TurnJobSnapshot>,
    8000,
    actionId ? 'SubmitPlayerActionAsync' : 'SubmitPlayerMessageAsync',
  );
}

export async function pollTurnJob(jobId: string): Promise<TurnJobSnapshot> {
  return (await WaitForTurnJob(jobId)) as unknown as TurnJobSnapshot;
}

export async function resetState() {
  if (!hasWailsBackend()) return browserFallbackState;
  return withTimeout(ResetGame(), 12000, 'ResetGame');
}
