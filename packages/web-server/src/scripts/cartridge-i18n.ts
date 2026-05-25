import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clearConfigEnv, rawConfigEnv, setConfigEnv } from '../config.js';

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

type Command = 'export' | 'diff' | 'migration';

interface Args {
  command: Command;
  fixtureMode: 'temp' | 'existing';
  format: 'json' | 'csv';
  file?: string;
  out?: string;
  missingOnly: boolean;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const needsDb = args.command === 'export' || args.command === 'diff';
  if (needsDb) await prepareDb(args.fixtureMode);

  const {
    diffCartridgeI18n,
    exportCartridgeI18n,
    generateCartridgeI18nMigration,
    packFromCsv,
    packFromJson,
    packToCsv,
  } = await import('../devtools/cartridgeI18nAuthoring.js');

  if (args.command === 'export') {
    const pack = await exportCartridgeI18n({ missingOnly: args.missingOnly });
    const text =
      args.format === 'csv'
        ? packToCsv(pack)
        : `${JSON.stringify(pack, null, 2)}\n`;
    await writeOrStdout(args.out, text);
  } else if (args.command === 'diff') {
    if (!args.file) throw new Error('diff requires --file <path>');
    const [current, incoming] = await Promise.all([
      exportCartridgeI18n(),
      readPack(args.file, packFromJson, packFromCsv),
    ]);
    await writeOrStdout(
      args.out,
      `${JSON.stringify(diffCartridgeI18n(current, incoming), null, 2)}\n`,
    );
  } else if (args.command === 'migration') {
    if (!args.file) throw new Error('migration requires --file <path>');
    const pack = await readPack(args.file, packFromJson, packFromCsv);
    const result = generateCartridgeI18nMigration(pack);
    if (result.warnings.length > 0) {
      process.stderr.write(
        `${JSON.stringify({ warnings: result.warnings })}\n`,
      );
    }
    await writeOrStdout(args.out, `${result.sql}\n`);
  }

  const { closeDb } = await import('../db.js');
  if (needsDb) await closeDb();
} catch (err) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2)}\n`,
  );
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

async function prepareDb(fixtureMode: Args['fixtureMode']): Promise<void> {
  if (fixtureMode === 'temp') {
    clearConfigEnv('DATABASE_URL');
    const base =
      rawConfigEnv('GREENHAVEN_DEVTOOLS_TMP') ??
      (process.platform === 'win32' ? 'C:\\tmp' : '/tmp');
    await mkdir(base, { recursive: true });
    setConfigEnv(
      'PGLITE_DATA_DIR',
      await mkdtemp(path.join(base, 'greenhaven-cartridge-i18n-')),
    );
  }
  const { runMigrations } = await import('../migrate.js');
  await runMigrations();
}

async function readPack<T>(
  file: string,
  fromJson: (text: string) => T,
  fromCsv: (text: string) => T,
): Promise<T> {
  const text = await readFile(file, 'utf8');
  return file.toLowerCase().endsWith('.csv') ? fromCsv(text) : fromJson(text);
}

async function writeOrStdout(
  file: string | undefined,
  text: string,
): Promise<void> {
  if (!file) {
    process.stdout.write(text);
    return;
  }
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, text, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, out: file })}\n`);
}

function parseArgs(argv: string[]): Args {
  const command = argv.shift();
  if (command !== 'export' && command !== 'diff' && command !== 'migration') {
    throw new Error(
      'usage: cartridge-i18n <export|diff|migration> [--fixture-mode temp|existing] [--format json|csv] [--file path] [--out path] [--missing-only]',
    );
  }
  const args: Args = {
    command,
    fixtureMode: command === 'migration' ? 'existing' : 'temp',
    format: 'json',
    missingOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--missing-only') {
      args.missingOnly = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for ${arg}`);
    }
    i += 1;
    if (arg === '--fixture-mode') {
      if (value !== 'temp' && value !== 'existing') {
        throw new Error('--fixture-mode must be temp or existing');
      }
      args.fixtureMode = value;
    } else if (arg === '--format') {
      if (value !== 'json' && value !== 'csv') {
        throw new Error('--format must be json or csv');
      }
      args.format = value;
    } else if (arg === '--file') {
      args.file = value;
    } else if (arg === '--out') {
      args.out = value;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return args;
}
