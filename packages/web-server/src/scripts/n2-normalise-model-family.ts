/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Tiny shim for the N-2 soak driver. Takes raw ids on argv (each
// `--id <rawId>` repeatable, OR a single `--ids-json '["a","b"]'`
// payload) and prints the deduplicated normalized list as JSON so
// PowerShell and TypeScript apply identical rules without duplicating
// the rule set.
//
// `--kind` selects which normalization rules apply:
//   `model-family` (default) → `normaliseModelFamilyLabels`. The
//      original N-2 model-family argv contract is unchanged: callers
//      that omit `--kind` get the same behavior they had before.
//   `cartridge`              → `normaliseCartridgeLabels`. Drops
//      empty / non-string entries entirely; never invents an
//      `'unknown'` fallback (the cartridge diversity gate must not
//      be paddable).
//
// Pure: no DB, no migrations.
//
// Exit codes: 0 on success (the shim never fails on empty input —
// `{raw: [], normalized: []}` is the legitimate "no evidence" answer).
// Errors throw to stderr and are surfaced as exit 1 from the runtime.

import {pathToFileURL} from 'node:url';
import {
  normaliseCartridgeLabels,
  normaliseModelFamilyLabels,
} from '../devtools/narrateSanitiserDeletionReadiness.js';

export type ShimKind = 'model-family' | 'cartridge';

export interface ShimArgs {
  ids: string[];
  kind: ShimKind;
}

function parseKind(raw: string): ShimKind {
  if (raw === 'model-family' || raw === 'cartridge') return raw;
  throw new Error(
    `unknown --kind value: ${raw} (expected 'model-family' or 'cartridge')`,
  );
}

export function parseShimArgs(argv: readonly string[]): ShimArgs {
  const ids: string[] = [];
  let kind: ShimKind = 'model-family';
  const arr = [...argv];
  for (let i = 0; i < arr.length; i += 1) {
    const arg = arr[i]!;
    if (arg === '--id') {
      const v = arr[i + 1];
      if (typeof v !== 'string') throw new Error('missing value for --id');
      ids.push(v);
      i += 1;
      continue;
    }
    if (arg === '--ids-json') {
      const v = arr[i + 1];
      if (typeof v !== 'string')
        throw new Error('missing value for --ids-json');
      const parsed = JSON.parse(v) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('--ids-json must be a JSON array of strings');
      }
      for (const item of parsed) {
        if (typeof item === 'string') ids.push(item);
      }
      i += 1;
      continue;
    }
    if (arg === '--kind') {
      const v = arr[i + 1];
      if (typeof v !== 'string') throw new Error('missing value for --kind');
      kind = parseKind(v);
      i += 1;
      continue;
    }
    if (arg.startsWith('--kind=')) {
      kind = parseKind(arg.slice('--kind='.length));
      continue;
    }
    if (arg.startsWith('--id=')) {
      ids.push(arg.slice('--id='.length));
      continue;
    }
    throw new Error(`unknown flag: ${arg}`);
  }
  return {ids, kind};
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl && import.meta.url === entryUrl) {
  try {
    const args = parseShimArgs(process.argv.slice(2));
    const normalized =
      args.kind === 'cartridge'
        ? normaliseCartridgeLabels(args.ids)
        : normaliseModelFamilyLabels(args.ids);
    const out = {
      kind: args.kind,
      raw: args.ids,
      normalized,
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({ok: false, error: message})}\n`,
    );
    process.exitCode = 1;
  }
}
