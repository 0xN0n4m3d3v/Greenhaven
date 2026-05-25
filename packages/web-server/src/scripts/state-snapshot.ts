export {};

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

try {
  const args = parseArgs(process.argv.slice(2));
  const {captureStateSnapshot} = await import('../devtools/stateSnapshot.js');
  const {closeDb} = await import('../db.js');
  const snapshot = await captureStateSnapshot(args);
  await closeDb();
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} catch (err) {
  process.stdout.write(
    `${JSON.stringify({ok: false, error: err instanceof Error ? err.message : String(err)}, null, 2)}\n`,
  );
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

function parseArgs(argv: string[]): {playerId: number; sessionId?: string; limit?: number} {
  const out: {playerId?: number; sessionId?: string; limit?: number} = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--player-id') out.playerId = Number(value);
    else if (arg === '--session-id') out.sessionId = value;
    else if (arg === '--limit') out.limit = Number(value);
    else throw new Error(`unknown option ${arg}`);
  }
  if (!Number.isInteger(out.playerId)) {
    throw new Error('usage: state-snapshot --player-id <id> [--session-id <uuid>] [--limit 50]');
  }
  return out as {playerId: number; sessionId?: string; limit?: number};
}
