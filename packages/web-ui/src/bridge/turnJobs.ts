import {engine, main} from './platform';
import {normalizeSupportedLanguageCode} from '../lib/languages';
import {
  isTerminalJob,
  jobs,
  jobWaiters,
  queueRowToJobSnapshot,
  settleJob,
  type TurnQueueSnapshot,
} from './turnJobState';

type FrontendEventSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

type RecordFrontendEvent = (
  severity: FrontendEventSeverity,
  eventName: string,
  message: string,
  properties?: Record<string, unknown>,
  opts?: {
    category?: string;
    turnId?: string | null;
    traceId?: string | null;
    redactionTier?:
      | 'tier0_safe'
      | 'tier1_local_debug'
      | 'tier2_sensitive_local';
  },
) => void;

interface TurnJobsPlayerSnapshot {
  public_id: string;
  entity_id: number;
  display_name: string;
  profile_created?: boolean;
  current_xp: number;
  current_level: number;
  current_hp: number;
  max_hp: number;
  current_location_id: number | null;
  current_scene_id: number | null;
  current_location_name: string | null;
  current_scene_name: string | null;
  dialogue_partner_id?: number | null;
  dialogue_partner_name?: string | null;
  companions?: Array<{id: number; name: string}>;
}

export interface TurnJobsBridgeRuntime {
  sessionId: string;
  player: TurnJobsPlayerSnapshot;
  state: engine.GameState;
  source: EventSource;
}

interface StartTurnResponse {
  turnId: string;
  queueId?: number;
  queued?: boolean;
  visible?: boolean;
  position?: number;
  blockedByTurnId?: string | null;
  error?: string;
}

export interface TurnJobBridgeDeps {
  getBridge(): Promise<TurnJobsBridgeRuntime>;
  getJSON<T>(path: string): Promise<T>;
  postJSON<T>(path: string, body?: unknown): Promise<T>;
  refreshPersistedMessages(
    runtime: TurnJobsBridgeRuntime,
    reason: string,
  ): Promise<boolean>;
  refreshPlayer(runtime: TurnJobsBridgeRuntime): Promise<void>;
  emptyPatchReport(): engine.PatchReport;
  readUiLanguage(): string | null;
  resetBootstrap(): void;
  recordFrontendEvent: RecordFrontendEvent;
}

export interface TurnJobBridgeApi {
  GetPendingTurnJobs(): Promise<main.TurnJobSnapshot[]>;
  SubmitPlayerMessage(text: string): Promise<engine.TurnResult>;
  SubmitPlayerAction(
    actionId: string,
    text: string,
  ): Promise<engine.TurnResult>;
  ContinueLastTurn(): Promise<engine.TurnResult>;
  SubmitPlayerMessageAsync(text: string): Promise<main.TurnJobSnapshot>;
  SubmitPlayerActionAsync(
    actionId: string,
    text: string,
  ): Promise<main.TurnJobSnapshot>;
  ContinueLastTurnAsync(): Promise<main.TurnJobSnapshot>;
  GetTurnJob(jobId: string): Promise<main.TurnJobSnapshot>;
  CancelTurnJob(jobId: string): Promise<main.TurnJobSnapshot>;
  WaitForTurnJob(jobId: string): Promise<main.TurnJobSnapshot>;
}

export function createTurnJobBridge(deps: TurnJobBridgeDeps): TurnJobBridgeApi {
  async function getPendingTurnJobs(): Promise<main.TurnJobSnapshot[]> {
    const b = await deps.getBridge();
    const data = await deps
      .getJSON<TurnQueueSnapshot>(
        `/session/${encodeURIComponent(b.sessionId)}/turn-queue?playerId=${b.player.entity_id}`,
      )
      .catch(err => {
        console.warn('[bridge] turn queue rehydrate failed', err);
        return {rows: []};
      });
    const rows = Array.isArray(data.rows) ? data.rows : [];
    return rows
      .filter(row =>
        row.status === 'queued' ||
        row.status === 'starting' ||
        row.status === 'running',
      )
      .map(row => {
        const snap = queueRowToJobSnapshot(row, jobs.get(row.turnId));
        jobs.set(row.turnId, snap);
        return snap;
      });
  }

  async function attachRecoveredTurnResult(
    job: main.TurnJobSnapshot,
  ): Promise<main.TurnJobSnapshot> {
    if (job.status !== 'done' || job.result) return job;
    const b = await deps.getBridge();
    await deps.refreshPersistedMessages(b, 'turn queue reconcile');
    await deps.refreshPlayer(b);
    const result = engine.TurnResult.createFrom({
      state: b.state,
      usedProvider: b.state.provider?.model ?? 'gemini',
      visible: '',
      patchReport: deps.emptyPatchReport(),
    });
    return main.TurnJobSnapshot.createFrom({...job, result});
  }

  async function reconcileTurnJobFromQueue(
    jobId: string,
  ): Promise<main.TurnJobSnapshot | null> {
    const b = await deps.getBridge();
    const data = await deps
      .getJSON<TurnQueueSnapshot>(
        `/session/${encodeURIComponent(b.sessionId)}/turn-queue?playerId=${b.player.entity_id}&history=1&turnId=${encodeURIComponent(jobId)}`,
      )
      .catch(err => {
        console.warn('[bridge] turn queue reconcile failed', err);
        return null;
      });
    if (!data) return null;
    const existing = jobs.get(jobId);
    const row = Array.isArray(data.rows)
      ? data.rows.find(r => r.turnId === jobId)
      : undefined;
    if (!row) {
      if (data.activeTurnId === jobId) return null;
      const lost = main.TurnJobSnapshot.createFrom({
        ...(existing ?? {
          id: jobId,
          actionId: '',
          text: '',
          createdAt: Date.now(),
        }),
        status: 'error',
        error: 'turn job lost after server recovery; please retry',
        finishedAt: Date.now(),
      });
      jobs.set(jobId, lost);
      settleJob(jobId, lost);
      return lost;
    }

    let snap = queueRowToJobSnapshot(row, existing);
    snap = await attachRecoveredTurnResult(snap);
    jobs.set(jobId, snap);
    if (isTerminalJob(snap)) {
      settleJob(jobId, snap);
    }
    return snap;
  }

  async function startTurnOnServer(
    text: string,
    actionId?: string,
  ): Promise<main.TurnJobSnapshot> {
    let b = await deps.getBridge();
    const language =
      normalizeSupportedLanguageCode(deps.readUiLanguage()) ??
      (typeof navigator !== 'undefined'
        ? normalizeSupportedLanguageCode(navigator.language)
        : null) ??
      undefined;
    const clientRequestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const buildBody = (
      player: TurnJobsPlayerSnapshot,
    ): Record<string, unknown> => {
      const turnBody: Record<string, unknown> = {
        text,
        playerId: player.entity_id,
        clientRequestId,
      };
      if (actionId) turnBody['actionId'] = actionId;
      if (language) turnBody['language'] = language;
      return turnBody;
    };

    let body: StartTurnResponse;
    try {
      body = await deps.postJSON<StartTurnResponse>(
        `/session/${encodeURIComponent(b.sessionId)}/turn`,
        buildBody(b.player),
      );
      deps.recordFrontendEvent(
        'info',
        'turn_submitted',
        'Player turn submitted',
        {
          turnId: body.turnId,
          queued: body.queued === true,
          visible: body.visible !== false,
          position: body.position ?? null,
          actionId: actionId ?? null,
          textLength: text.length,
        },
        {turnId: body.turnId, traceId: body.turnId},
      );
    } catch (err) {
      const isStale = err instanceof Error && /\b404\b/.test(err.message);
      if (!isStale) throw err;
      try {
        b.source.close();
      } catch {
        // ignore stale EventSource close errors
      }
      deps.resetBootstrap();
      b = await deps.getBridge();
      body = await deps.postJSON<StartTurnResponse>(
        `/session/${encodeURIComponent(b.sessionId)}/turn`,
        buildBody(b.player),
      );
      deps.recordFrontendEvent(
        'warn',
        'turn_submit_retried_after_stale_session',
        'Turn submit retried after stale session',
        {
          turnId: body.turnId,
          actionId: actionId ?? null,
        },
        {turnId: body.turnId, traceId: body.turnId},
      );
    }

    const completedEarly = jobs.get(body.turnId);
    if (isTerminalJob(completedEarly)) {
      const snap = main.TurnJobSnapshot.createFrom({
        ...completedEarly,
        actionId: completedEarly.actionId || actionId || '',
        text: completedEarly.text ?? '',
      });
      jobs.set(body.turnId, snap);
      return snap;
    }

    const snap = main.TurnJobSnapshot.createFrom({
      id: body.turnId,
      actionId: actionId ?? '',
      text: '',
      createdAt: Date.now(),
      status: body.visible === false ? 'queued' : 'running',
      kind: body.visible === false ? 'queued' : undefined,
    });
    jobs.set(body.turnId, snap);
    return snap;
  }

  function waitForTurnJob(jobId: string): Promise<main.TurnJobSnapshot> {
    return new Promise(resolve => {
      const existing = jobs.get(jobId);
      if (isTerminalJob(existing)) {
        resolve(existing);
        return;
      }
      let settled = false;
      let timer: number | undefined;
      const finish = (snap: main.TurnJobSnapshot) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) window.clearTimeout(timer);
        resolve(snap);
      };
      let bucket = jobWaiters.get(jobId);
      if (!bucket) {
        bucket = [];
        jobWaiters.set(jobId, bucket);
      }
      bucket.push(finish);

      // Re-check: the job may have settled between the isTerminalJob
      // check above and waiter registration. If so, resolve immediately
      // rather than waiting up to 15s for the reconcile poll.
      const recheck = jobs.get(jobId);
      if (isTerminalJob(recheck)) {
        // Remove our waiter since the job is already done.
        const b = jobWaiters.get(jobId);
        if (b) {
          const idx = b.indexOf(finish);
          if (idx >= 0) b.splice(idx, 1);
        }
        finish(recheck);
        return;
      }

      const scheduleReconcile = () => {
        timer = window.setTimeout(async () => {
          const current = jobs.get(jobId);
          if (isTerminalJob(current)) {
            finish(current);
            return;
          }
          const ageMs =
            Date.now() -
            (current?.startedAt ?? current?.createdAt ?? Date.now());
          if (ageMs < 15000) {
            scheduleReconcile();
            return;
          }
          const reconciled = await reconcileTurnJobFromQueue(jobId);
          if (isTerminalJob(reconciled)) {
            finish(reconciled);
            return;
          }
          if (!settled) scheduleReconcile();
        }, 5000);
      };
      scheduleReconcile();
    });
  }

  async function waitForJob(jobId: string): Promise<engine.TurnResult> {
    const job = await waitForTurnJob(jobId);
    const b = await deps.getBridge();
    return (
      job.result ??
      engine.TurnResult.createFrom({
        state: b.state,
        usedProvider: b.state.provider?.model ?? 'gemini',
        visible: '',
      })
    );
  }

  return {
    GetPendingTurnJobs: getPendingTurnJobs,
    async SubmitPlayerMessage(text: string): Promise<engine.TurnResult> {
      const job = await startTurnOnServer(text);
      return waitForJob(job.id);
    },
    async SubmitPlayerAction(
      actionId: string,
      text: string,
    ): Promise<engine.TurnResult> {
      const job = await startTurnOnServer(text, actionId);
      return waitForJob(job.id);
    },
    async ContinueLastTurn(): Promise<engine.TurnResult> {
      const b = await deps.getBridge();
      return engine.TurnResult.createFrom({
        state: b.state,
        usedProvider: b.state.provider?.model ?? 'gemini',
      });
    },
    SubmitPlayerMessageAsync(text: string): Promise<main.TurnJobSnapshot> {
      return startTurnOnServer(text);
    },
    SubmitPlayerActionAsync(
      actionId: string,
      text: string,
    ): Promise<main.TurnJobSnapshot> {
      return startTurnOnServer(text, actionId);
    },
    async ContinueLastTurnAsync(): Promise<main.TurnJobSnapshot> {
      return main.TurnJobSnapshot.createFrom({
        id: `noop-${Date.now()}`,
        actionId: 'continue',
        text: '',
        createdAt: Date.now(),
        status: 'done',
      });
    },
    async GetTurnJob(jobId: string): Promise<main.TurnJobSnapshot> {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`unknown job: ${jobId}`);
      return main.TurnJobSnapshot.createFrom(job);
    },
    async CancelTurnJob(jobId: string): Promise<main.TurnJobSnapshot> {
      const b = await deps.getBridge();
      await deps.postJSON(`/session/${encodeURIComponent(b.sessionId)}/cancel`, {
        playerId: b.player.entity_id,
        turnId: jobId,
      });
      const existing = jobs.get(jobId);
      const next = main.TurnJobSnapshot.createFrom({
        ...(existing ?? {
          id: jobId,
          actionId: '',
          text: '',
          createdAt: Date.now(),
        }),
        status: 'canceled',
        finishedAt: Date.now(),
      });
      jobs.set(jobId, next);
      settleJob(jobId, next);
      return next;
    },
    WaitForTurnJob: waitForTurnJob,
  };
}
