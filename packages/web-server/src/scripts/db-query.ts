export {};

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

try {
  const args = parseArgs(process.argv.slice(2));
  const {runReadOnlyQuery} = await import('../devtools/dbQuery.js');
  const {closeDb} = await import('../db.js');
  const result = await runReadOnlyQuery(args);
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

function parseArgs(argv: string[]): {sql: string; params?: unknown[]; limit?: number} {
  const out: {sql?: string; params?: unknown[]; limit?: number} = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--params') out.params = JSON.parse(value) as unknown[];
    else if (arg === '--limit') out.limit = Number(value);
    else throw new Error(`unknown option ${arg}`);
  }
  out.sql = positional.join(' ').trim();
  if (!out.sql) throw new Error('usage: db-query "SELECT 1 AS ok" [--params "[...]"] [--limit 100]');
  return out as {sql: string; params?: unknown[]; limit?: number};
}
