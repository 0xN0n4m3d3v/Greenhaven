import {readFile} from 'node:fs/promises';

try {
  const input = await readInput(process.argv.slice(2));
  const {generateMigrationSnippet} = await import('../devtools/generateMigrationSnippet.js');
  const result = generateMigrationSnippet(input as never);
  if (result.warnings.length > 0) {
    process.stderr.write(`${JSON.stringify({warnings: result.warnings})}\n`);
  }
  process.stdout.write(`${result.sql}\n`);
} catch (err) {
  process.stdout.write(
    `${JSON.stringify({ok: false, error: err instanceof Error ? err.message : String(err)}, null, 2)}\n`,
  );
  process.exitCode = 1;
}

async function readInput(argv: string[]): Promise<unknown> {
  if (argv.length === 0) {
    throw new Error('usage: generate-migration-snippet --input <json> OR --file <path>');
  }
  if (argv[0] === '--input') {
    if (!argv[1]) throw new Error('missing value for --input');
    return JSON.parse(argv[1]);
  }
  if (argv[0] === '--file') {
    if (!argv[1]) throw new Error('missing value for --file');
    return JSON.parse(await readFile(argv[1], 'utf8'));
  }
  throw new Error(`unknown option ${argv[0]}`);
}
