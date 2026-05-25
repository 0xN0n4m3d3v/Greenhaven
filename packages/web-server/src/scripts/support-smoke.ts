import {
  runSupportSmoke,
  type SupportSmokeOptions,
} from '../devtools/supportSmoke.js';

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

try {
  const result = await runSupportSmoke(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
} catch (err) {
  process.stdout.write(
    `${JSON.stringify(
      {ok: false, checks: [{name: 'support_smoke_cli', status: 'fail', details: {message: err instanceof Error ? err.message : String(err)}}]},
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

function parseArgs(argv: string[]): SupportSmokeOptions {
  const out: SupportSmokeOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--existing-db') {
      out.useExistingDb = true;
    } else if (arg === '--keep-temp') {
      out.keepTemp = true;
    } else if (arg === '--fixture') {
      const value = argv[i + 1];
      if (value !== 'normal' && value !== 'broken') {
        throw new Error('--fixture must be normal or broken');
      }
      out.fixture = value;
      i += 1;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return out;
}
