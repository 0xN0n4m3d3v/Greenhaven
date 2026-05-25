/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 Phase 4 source sweep — shared scanner for the readiness CLI
// and `arch19ReaderSweep.test.ts`. The architecture test stays
// authoritative for the allowlist semantics; this module exists so
// the CLI can reuse the same regex + allowlist + walker without
// duplicating logic. The architecture test currently still owns the
// allowlist literal (a small array constant); when the readiness CLI
// imports the allowlist via this module it stays in lockstep.

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative, sep} from 'node:path';

export interface SourceSweepOffender {
  file: string;
  sample: string;
}

/** Documented production exceptions — every entry is justified at its
 *  call site in `arch19ReaderSweep.test.ts`. Production readers MUST
 *  not be appended without justification.
 *
 *  The last two entries are the readiness gate itself: they
 *  intentionally consult `profile->>'cartridge_id'` etc. to count
 *  parity mismatches and document the keys the upcoming Phase 4 drop
 *  will remove. They are not runtime readers — they exist precisely
 *  to prove the runtime readers no longer need the JSONB keys. */
export const ARCH19_READER_SWEEP_ALLOWLIST: ReadonlyArray<string> = [
  'entities/profileProjection.ts',
  'tools/entity.ts',
  'worldFactGuard.ts',
  'quest/dynamicQuestPlan.ts',
  'devtools/generateMigrationSnippet.ts',
  'scripts/entity-card-io.ts',
  'devtools/arch19SourceSweep.ts',
  'devtools/arch19Phase4Readiness.ts',
  'devtools/arch19ForgeSqlEvidence.ts',
  'scripts/arch19-phase4-readiness.ts',
];

const KEYS = ['cartridge_id', 'topology_parent_id', 'origin'] as const;

const SQL_RE = new RegExp(
  String.raw`profile\s*->>\s*['"](?:` + KEYS.join('|') + `)['"]`,
);
const JS_RE = new RegExp(
  String.raw`profile\s*\[\s*['"](?:` + KEYS.join('|') + `)['"]\s*\]`,
);

function walkTsFiles(root: string, excludeAbsPaths: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walker = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      if (entry === '__tests__') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walker(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      if (entry.endsWith('.d.ts')) continue;
      if (excludeAbsPaths.has(full)) continue;
      out.push(full);
    }
  };
  walker(root);
  return out;
}

export interface ScanArch19LegacyReadersOpts {
  /** Absolute path to `packages/web-server/src/`. */
  srcRoot: string;
  /** Allowlisted entries (repo-relative) — defaults to the canonical
   *  `ARCH19_READER_SWEEP_ALLOWLIST`. Passing a stricter list lets
   *  the readiness CLI exit non-zero even on the entries the
   *  architecture test currently tolerates (Phase 4 will close that
   *  allowlist to zero). */
  allowlist?: ReadonlyArray<string>;
  /** Absolute paths to skip — used by tests to exclude themselves. */
  excludeAbsPaths?: ReadonlySet<string>;
}

/**
 * Scan production TypeScript files under `srcRoot` for legacy
 * `profile->>'…'` / `profile['…']` reads of the soon-to-drop JSONB
 * keys. Returns the list of offenders not on the allowlist.
 */
export function scanArch19LegacyReaders(
  opts: ScanArch19LegacyReadersOpts,
): SourceSweepOffender[] {
  const allowlist = new Set(
    (opts.allowlist ?? ARCH19_READER_SWEEP_ALLOWLIST).map((p) =>
      p.split('/').join(sep),
    ),
  );
  const offenders: SourceSweepOffender[] = [];
  const files = walkTsFiles(opts.srcRoot, opts.excludeAbsPaths ?? new Set());
  for (const file of files) {
    const rel = relative(opts.srcRoot, file);
    if (allowlist.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    const sqlMatch = SQL_RE.exec(text);
    const jsMatch = JS_RE.exec(text);
    const match = sqlMatch ?? jsMatch;
    if (match) {
      offenders.push({
        file: rel.split(sep).join('/'),
        sample: match[0],
      });
    }
  }
  return offenders;
}
