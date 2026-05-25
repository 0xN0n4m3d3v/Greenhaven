const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

const VOICE_FIXTURES = [
  'voice_accept_npc',
  'voice_reject_dialogue_under_location',
  'voice_reject_scene_under_npc',
  'voice_multilingual_reject',
] as const;

try {
  const fixtureMode = parseFixtureMode(process.argv.slice(2));
  const {runSpecialistFixtures} = await import('../src/devtools/simulateSpecialist.js');
  const {closeDb} = await import('../src/db.js');
  const result = await runSpecialistFixtures([...VOICE_FIXTURES], fixtureMode);
  await closeDb();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.summary.failed > 0 ? 1 : 0;
} catch (err) {
  const payload = {
    ok: false,
    summary: {passed: 0, failed: 1, skipped: 0, total: 1},
    results: [
      {
        ok: false,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      },
    ],
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

function parseFixtureMode(argv: string[]): 'temp' | 'existing' | 'none' {
  let fixtureMode: 'temp' | 'existing' | 'none' = 'temp';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg !== '--fixture-mode') {
      throw new Error(`unknown option ${arg}`);
    }
    const value = argv[i + 1];
    if (value !== 'temp' && value !== 'existing' && value !== 'none') {
      throw new Error('--fixture-mode must be temp, existing, or none');
    }
    fixtureMode = value;
    i += 1;
  }
  return fixtureMode;
}
