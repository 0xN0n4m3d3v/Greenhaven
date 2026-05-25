import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(file, 'utf8');
    const out: T[] = [];
    for (const [idx, raw] of text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch (error) {
        throw new Error(`${file}:${idx + 1}: invalid JSONL: ${message(error)}`);
      }
    }
    return out;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeJsonl<T>(file: string, rows: T[]): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true});
  const text = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  await writeFile(file, text, 'utf8');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

