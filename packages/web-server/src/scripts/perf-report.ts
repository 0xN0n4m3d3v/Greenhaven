export {};

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

try {
  const args = parseArgs(process.argv.slice(2));
  const {
    buildPerformanceDiagnostics,
    getPerformanceTurn,
    listPerformanceFailures,
    listPerformanceHotspots,
    sinceIso,
  } = await import('../devtools/performanceDiagnostics.js');
  const {closeDb} = await import('../db.js');
  const since = args.since ?? sinceIso(args.minutes);
  const result =
    args.command === 'turn'
      ? await getPerformanceTurn(args.turnId!)
      : args.command === 'hotspots'
        ? {since, hotspots: await listPerformanceHotspots({since, limit: args.limit})}
        : args.command === 'failures'
          ? {since, failures: await listPerformanceFailures({since, limit: args.limit})}
          : await buildPerformanceDiagnostics({since, limit: args.limit});
  await closeDb();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err) {
  process.stdout.write(
    `${JSON.stringify({ok: false, error: err instanceof Error ? err.message : String(err)}, null, 2)}\n`,
  );
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

function parseArgs(argv: string[]): {
  command: 'summary' | 'hotspots' | 'failures' | 'turn';
  minutes: number;
  since?: string;
  limit: number;
  turnId?: string;
} {
  const out: {
    command?: 'summary' | 'hotspots' | 'failures' | 'turn';
    minutes?: number;
    since?: string;
    limit?: number;
    turnId?: string;
  } = {
    command: 'summary',
    minutes: 60,
    limit: 20,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for ${arg}`);
    }
    i += 1;
    if (arg === '--minutes') out.minutes = Number(value);
    else if (arg === '--since') out.since = value;
    else if (arg === '--limit') out.limit = Number(value);
    else if (arg === '--turn') {
      out.command = 'turn';
      out.turnId = value;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  const command = positional[0];
  if (command === 'hotspots' || command === 'failures' || command === 'summary') {
    out.command = command;
  } else if (command === 'turn') {
    out.command = 'turn';
    out.turnId = positional[1] ?? out.turnId;
  } else if (command != null) {
    throw new Error(
      'usage: perf-report [summary|hotspots|failures|turn <turnId>] [--minutes 60] [--limit 20]',
    );
  }
  if (out.command === 'turn' && !out.turnId) {
    throw new Error('turn id required: perf-report turn <turnId>');
  }
  return {
    command: out.command ?? 'summary',
    minutes:
      Number.isFinite(out.minutes ?? NaN) && Number(out.minutes) > 0
        ? Number(out.minutes)
        : 60,
    since: out.since,
    limit:
      Number.isFinite(out.limit ?? NaN) && Number(out.limit) > 0
        ? Number(out.limit)
        : 20,
    turnId: out.turnId,
  };
}
