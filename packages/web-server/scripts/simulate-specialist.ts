const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

type RawOptions = {
  specialist?: string;
  input?: unknown;
  fixtureId?: string;
  fixtureMode?: string;
  sessionId?: string;
  playerId?: number;
  turnId?: string;
};

try {
  const raw = parseArgs(process.argv.slice(2));
  const fixtures = await import('../src/devtools/specialistFixtures.js');
  if (!raw.specialist && raw.fixtureId) {
    raw.specialist = fixtures.fixtureById(raw.fixtureId)?.specialist;
  }
  if (!raw.specialist) {
    throw new Error(
        'missing specialist. Use --specialist voice_warden|movement_warden|cartridge_steward|quest_watcher|quest_pacer|protagonist_action_renderer|adventure_materializer or --fixture <id>.',
    );
  }
  const {simulateSpecialist} = await import('../src/devtools/simulateSpecialist.js');
  const {closeDb} = await import('../src/db.js');
  const result = await simulateSpecialist({
    specialist: raw.specialist as never,
    input: raw.input,
    fixtureId: raw.fixtureId,
    fixtureMode: (raw.fixtureMode ?? 'temp') as never,
    sessionId: raw.sessionId,
    playerId: raw.playerId,
    turnId: raw.turnId,
  });
  await closeDb();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'failed' ? 1 : 0;
} catch (err) {
  const payload = {
    ok: false,
    status: 'failed',
    error: err instanceof Error ? err.message : String(err),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

function parseArgs(argv: string[]): RawOptions {
  const out: RawOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    i += 1;
    if (key === 'specialist') out.specialist = value;
    else if (key === 'fixture' || key === 'fixture-id') out.fixtureId = value;
    else if (key === 'fixture-mode') out.fixtureMode = value;
    else if (key === 'session-id') out.sessionId = value;
    else if (key === 'player-id') out.playerId = Number(value);
    else if (key === 'turn-id') out.turnId = value;
    else if (key === 'input') out.input = JSON.parse(value);
    else throw new Error(`unknown option --${key}`);
  }
  if (!out.specialist && positional[0]) out.specialist = positional[0];
  return out;
}
