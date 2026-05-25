import { rm } from 'node:fs/promises';
import { clearConfigEnv, setConfigEnv } from '../../config.js';
import type { Session } from '../../sessionManager.js';
import type { TurnInput } from '../../turnRunnerV2.js';
import { createPristineDataDir } from '../migrations/framework.js';

interface RuntimeModules {
  closeDb: () => Promise<void>;
  createAnonymousPlayer: (
    displayName?: string,
  ) => Promise<{ entity_id: number }>;
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number }>;
  sessionManager: {
    destroy(id: string): Promise<boolean>;
    getOrCreate(
      sessionId: string | undefined,
      playerId: number,
    ): Promise<Session>;
  };
  startTurnV2: (
    session: Session,
    input: TurnInput,
  ) => { turnId: string; done: Promise<void> };
}

export interface TestSession {
  session: Session;
  sessionId: string;
  playerId: number;
  cleanup: () => Promise<void>;
}

export interface CollectedSse {
  events: Array<{ event: string; data: unknown; id?: string }>;
  stop: () => Promise<void>;
}

let dataDir: string | null = null;
let modules: RuntimeModules | null = null;

export async function setupTurnTestEnvironment(): Promise<void> {
  if (modules) return;

  dataDir = await createPristineDataDir();
  clearConfigEnv('DATABASE_URL');
  setConfigEnv('PGLITE_DATA_DIR', dataDir);
  setConfigEnv('AUTH_SECRET', 'turn-test-auth-secret-32-bytes-minimum');
  setConfigEnv('FEATHERLESS_API_KEY', 'turn-test-provider-key');
  setConfigEnv('GREENHAVEN_TURN_WATCHDOG_MS', '5000');
  setConfigEnv('GREENHAVEN_GAMEPLAY_LOG_DIR', `${dataDir}/gameplay-logs`);

  await import('../../tools/index.js');
  const [
    { closeDb, query },
    { createAnonymousPlayer },
    { sessionManager },
    turn,
    { runMigrations },
  ] = await Promise.all([
    import('../../db.js'),
    import('../../playerService.js'),
    import('../../sessionManager.js'),
    import('../../turnRunnerV2.js'),
    import('../../migrate.js'),
  ]);

  // FEAT-HERO-CONTINUITY-2 — the pristine data dir copied above replays
  // the prebaseline archive (0001-0128). Post-baseline deltas under
  // `migrations/*.sql` (0129+ and beyond) only ever apply through
  // `runMigrations()`; the dev/prod path runs it on boot, and the test
  // framework must do the same so service suites see the same schema
  // shape as production. The runner detects legacy-chain mode here
  // (historical rows present, no baseline row) and applies only the
  // unrecorded post-baseline deltas — the prebaseline template stays
  // untouched.
  await runMigrations();

  modules = {
    closeDb,
    createAnonymousPlayer,
    query,
    sessionManager,
    startTurnV2: turn.startTurnV2,
  };
}

export async function cleanupTurnTestEnvironment(): Promise<void> {
  if (modules) {
    // FEAT-HERO-CONTINUITY-2 — drain the gameplay-log writer before
    // closing the DB so the `gameplay-logs/` directory under `dataDir`
    // has no live file handles when we rm it below. On Windows, rmdir
    // on a dir with an open file fails with ENOTEMPTY.
    try {
      const {telemetry} = await import('../../telemetry/index.js');
      await telemetry.flush();
    } catch {
      // CATCH-IGNORE-OK: tests already failing here would have surfaced
      // via the test assertion path; cleanup must not throw and mask
      // them.
    }
    await modules.closeDb();
    modules = null;
  }
  if (dataDir) {
    // FEAT-HERO-CONTINUITY-2 — Windows ENOTEMPTY retry. PGlite/wasm
    // releases its file handles asynchronously after `closeDb()`
    // resolves; without a short retry loop the immediate rm can race
    // with the wasm runtime's lingering writes.
    await rmDirWithRetry(dataDir);
    dataDir = null;
  }
}

async function rmDirWithRetry(target: string): Promise<void> {
  const attempts = 5;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rm(target, {recursive: true, force: true});
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function setupTestSession(): Promise<TestSession> {
  await setupTurnTestEnvironment();
  const runtime = requireRuntime();
  const created = await runtime.createAnonymousPlayer(
    `Turn Test Player ${Date.now()}`,
  );
  const session = await runtime.sessionManager.getOrCreate(
    `turn-test-${created.entity_id}-${Date.now()}`,
    created.entity_id,
  );
  return {
    session,
    sessionId: session.id,
    playerId: created.entity_id,
    cleanup: async () => {
      await runtime.sessionManager.destroy(session.id);
    },
  };
}

export function startTurn(
  session: Session,
  input: TurnInput,
): {
  turnId: string;
  done: Promise<void>;
} {
  const handle = requireRuntime().startTurnV2(session, input);
  if (session.activeTurn) {
    session.activeTurn.suppressPostTurn = true;
  }
  return handle;
}

export async function queryRows<T>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  return (await requireRuntime().query<T>(sql, params)).rows;
}

export function collectSse(session: Session): CollectedSse {
  const events: CollectedSse['events'] = [];
  const stream = {
    write: async () => undefined,
    writeSSE: async (event: { event?: string; data?: string; id?: string }) => {
      events.push({
        event: event.event ?? '',
        data: event.data ? JSON.parse(event.data) : null,
        id: event.id,
      });
    },
    onAbort: () => undefined,
  };
  const pump = session.sse.runFor(stream as never);
  return {
    events,
    stop: async () => {
      session.sse.closeAll();
      await pump;
    },
  };
}

function requireRuntime(): RuntimeModules {
  if (!modules) throw new Error('turn test environment is not initialized');
  return modules;
}
