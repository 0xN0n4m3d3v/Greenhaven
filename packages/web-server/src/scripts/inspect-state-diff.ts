import {readFile} from 'node:fs/promises';

try {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    throw new Error('usage: inspect-state-diff <before.json> <after.json>');
  }
  const {diffStateSnapshots} = await import('../devtools/stateSnapshot.js');
  const before = JSON.parse(await readFile(beforePath, 'utf8'));
  const after = JSON.parse(await readFile(afterPath, 'utf8'));
  const diff = diffStateSnapshots(before, after);
  process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
} catch (err) {
  process.stdout.write(
    `${JSON.stringify({ok: false, error: err instanceof Error ? err.message : String(err)}, null, 2)}\n`,
  );
  process.exitCode = 1;
}
