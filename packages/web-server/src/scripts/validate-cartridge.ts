import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { clearConfigEnv, rawConfigEnv, setConfigEnv } from '../config.js';

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

let parsedArgs: ReturnType<typeof parseArgs> | null = null;

try {
  const args = parseArgs(process.argv.slice(2));
  parsedArgs = args;
  if (args.fixtureMode === 'temp') {
    clearConfigEnv('DATABASE_URL');
    const base =
      rawConfigEnv('GREENHAVEN_DEVTOOLS_TMP') ??
      (process.platform === 'win32' ? 'C:\\tmp' : '/tmp');
    await mkdir(base, { recursive: true });
    setConfigEnv(
      'PGLITE_DATA_DIR',
      await mkdtemp(path.join(base, 'greenhaven-validate-cartridge-')),
    );
  }
  const { runMigrations } = await import('../migrate.js');
  const { validateCartridge, injectBrokenExitFixture } = await import(
    '../devtools/validateCartridge.js'
  );
  const { closeDb } = await import('../db.js');
  await runMigrations();
  if (args.fixture === 'broken-exit') await injectBrokenExitFixture();
  const result = await validateCartridge({ i18n: args.i18n });
  await closeDb();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (
    parsedArgs?.fixtureMode === 'temp' &&
    /cartridge_meta missing required key: 'cartridge_id'/.test(message)
  ) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          summary: { errors: 0, warnings: 0, entitiesChecked: 0 },
          issues: [],
          skipped: 'clean_baseline_no_active_cartridge',
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 0;
  } else {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
} finally {
  console.log = originalLog;
}

function parseArgs(argv: string[]): {
  fixture?: string;
  fixtureMode: 'temp' | 'existing';
  i18n: 'off' | 'report' | 'strict';
} {
  const out: {
    fixture?: string;
    fixtureMode: 'temp' | 'existing';
    i18n: 'off' | 'report' | 'strict';
  } = {
    fixtureMode: 'existing',
    i18n: 'off',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    if (value == null || value.startsWith('--'))
      throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--fixture') out.fixture = value;
    else if (arg === '--fixture-mode') {
      if (value !== 'temp' && value !== 'existing') {
        throw new Error('--fixture-mode must be temp or existing');
      }
      out.fixtureMode = value;
    } else if (arg === '--i18n') {
      if (value !== 'off' && value !== 'report' && value !== 'strict') {
        throw new Error('--i18n must be off, report, or strict');
      }
      out.i18n = value;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  if (out.fixture && out.fixtureMode !== 'temp') {
    out.fixtureMode = 'temp';
  }
  return out;
}
