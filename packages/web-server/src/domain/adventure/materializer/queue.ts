import {
  claimNextQueuedAdventure,
  recoverAbandonedMaterializingAdventures,
  type AdventureQueueRow,
} from '../runtime/adventureQueue.js';

export const ADVENTURE_MATERIALIZER_CURRENT_TURN_WAIT_MS = 750;
export const ADVENTURE_MATERIALIZER_CURRENT_TURN_POLL_MS = 50;

export async function claimQueuedAdventureForCurrentTurn(args: {
  sessionId: string;
  playerId: number;
  turnId: string;
  signal: AbortSignal;
}): Promise<AdventureQueueRow | null> {
  await recoverAbandonedMaterializingAdventures({
    sessionId: args.sessionId,
    playerId: args.playerId,
    olderThanMs: 180_000,
    reason: 'adventure materializer stale before claim',
  });
  const deadline = Date.now() + ADVENTURE_MATERIALIZER_CURRENT_TURN_WAIT_MS;
  while (!args.signal.aborted) {
    const queue = await claimNextQueuedAdventure({
      sessionId: args.sessionId,
      playerId: args.playerId,
      turnId: args.turnId,
    });
    if (queue) return queue;
    if (Date.now() >= deadline) return null;
    await sleep(ADVENTURE_MATERIALIZER_CURRENT_TURN_POLL_MS, args.signal);
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      {once: true},
    );
  });
}
