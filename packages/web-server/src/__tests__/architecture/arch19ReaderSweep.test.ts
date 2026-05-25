/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 pre-Phase-4 reader sweep.
//
// Static guard: no production file under `packages/web-server/src/`
// may consult the legacy `entities.profile.cartridge_id`,
// `entities.profile.topology_parent_id`, or `entities.profile.origin`
// JSONB keys via a `profile->>'…'` SQL fragment or a
// `profile['…']` JS lookup. The sole allowed exceptions are the
// projection helper (which derives the normalized columns from the
// authored profile), tool input that builds a profile to insert,
// authoring/devtool scripts that import or export cartridges, and
// migration-test files that exercise the pre/post-Phase-4 schema.
//
// Phase 4 will drop these JSONB keys. When the reader allowlist is
// empty we know the drop migration is safe to ship — any new
// production caller fails this test immediately.

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, relative, sep} from 'node:path';
import {describe, expect, it} from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

const KEYS = ['cartridge_id', 'topology_parent_id', 'origin'] as const;

// Pattern A: `profile->>'<key>'` and `profile->>"<key>"` inside SQL
// templates. We accept any whitespace between `->>` and the quoted
// key so common formatters do not break the match.
const SQL_RE = new RegExp(
  String.raw`profile\s*->>\s*['"](?:` + KEYS.join('|') + `)['"]`,
);
// Pattern B: `profile['<key>']` and `profile["<key>"]` JS bracket
// access. Other property accesses such as `args.profile?.[key]`
// inside tools/entity.ts still match — that case is on the allowlist
// because it is writing into an incoming profile, not reading a DB
// row.
const JS_RE = new RegExp(
  String.raw`profile\s*\[\s*['"](?:` + KEYS.join('|') + `)['"]\s*\]`,
);

// Files that are expected to still touch the legacy JSONB keys
// during ARCH-19 Phase 1-3. Each entry has a short explanation so
// future readers know why the hit is acceptable.
//
// Production readers must NOT appear here. Production writers that
// derive the normalized columns from the authored profile (the
// projection helper, tool input that constructs a profile to
// INSERT) are allowed because they are not reading stored DB rows.
const ALLOWLIST: ReadonlyArray<{
  path: string;
  why: string;
}> = [
  {
    path: 'entities/profileProjection.ts',
    why: 'ARCH-19 projection helper — derives normalized columns from the incoming authored profile. Not a stored-row reader.',
  },
  {
    path: 'tools/entity.ts',
    why: 'create_entity tool — sets profile.topology_parent_id on the incoming payload before INSERT (and the projection helper mirrors it into the normalized column).',
  },
  {
    path: 'worldFactGuard.ts',
    why: 'Tool input validator — reads `spawn.profile.topology_parent_id` from the broker tool payload (NOT a stored DB row). Stored-row reachability checks already consult `entities.topology_parent_id` via loadEntity.',
  },
  {
    path: 'quest/dynamicQuestPlan.ts',
    why: 'Defensive fallback — when callers cannot pass `dynamicOriginColumn` (incoming tool payload, pre-0105 callers), the helper still inspects `profile.origin`. Production stored-row callers (questDirectorPacket) pass the normalized column so Phase 4 is safe.',
  },
  {
    path: 'devtools/generateMigrationSnippet.ts',
    why: 'Devtool — exports a row snapshot for migration authoring; consults the legacy profile to build the snippet.',
  },
  {
    path: 'scripts/entity-card-io.ts',
    why: 'Authoring script — entity card import/export round-trip; reads the legacy profile to surface cartridge metadata to humans.',
  },
  {
    path: 'devtools/arch19SourceSweep.ts',
    why: 'ARCH-19 source-sweep helper — owns the regex that detects legacy reads. Doc comments mention the literal pattern; not a runtime reader.',
  },
  {
    path: 'devtools/arch19Phase4Readiness.ts',
    why: 'Phase 4 readiness gate helper — documents the legacy keys it evaluates. Pure helper, no DB reads itself; the CLI under scripts/ does the parity queries.',
  },
  {
    path: 'devtools/arch19ForgeSqlEvidence.ts',
    why: 'Phase 4 forge-SQL evidence parser — audits emitted profile JSON literals for the retired keys. Doc comments mention the literal `profile->>` pattern when explaining what NOT to count as a hit. Not a runtime reader.',
  },
  {
    path: 'scripts/arch19-phase4-readiness.ts',
    why: 'Phase 4 readiness CLI — intentionally counts parity mismatches between the legacy JSONB keys and the normalized columns. This is the audit script that proves runtime readers no longer need the JSONB keys.',
  },
];

function allowlistedPaths(): Set<string> {
  return new Set(ALLOWLIST.map(entry => entry.path.split('/').join(sep)));
}

function walkSrc(): string[] {
  const out: string[] = [];
  const walker = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        // Skip the tests directory; the migration tests legitimately
        // exercise the legacy JSONB keys to pin Phase 1-3 invariants.
        if (entry === '__tests__') continue;
        walker(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      if (entry.endsWith('.d.ts')) continue;
      out.push(full);
    }
  };
  walker(SRC_ROOT);
  return out.filter(file => file !== SELF);
}

describe('ARCH-19 pre-Phase-4 — production readers do not consult legacy profile keys', () => {
  it('allowlist contains only the documented exceptions', () => {
    // Pin the allowlist size + ordering so reviewers notice when a
    // future slice adds (or removes) a documented exception. New
    // production readers must not be appended without justification.
    expect(ALLOWLIST.map(entry => entry.path)).toEqual([
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
    ]);
  });

  it('no production source file outside the allowlist reads profile[cartridge_id|topology_parent_id|origin]', () => {
    const allowed = allowlistedPaths();
    const offenders: Array<{file: string; sample: string}> = [];
    for (const file of walkSrc()) {
      const rel = relative(SRC_ROOT, file);
      if (allowed.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      const sqlMatch = SQL_RE.exec(text);
      const jsMatch = JS_RE.exec(text);
      const match = sqlMatch ?? jsMatch;
      if (match) {
        offenders.push({file: rel, sample: match[0]});
      }
    }
    expect(
      offenders,
      'Production source files outside the documented allowlist must not read profile[cartridge_id|topology_parent_id|origin]. ' +
        'Switch the reader to the normalized entities column (cartridge_id, topology_parent_id, dynamic_origin) so Phase 4 ' +
        'can drop the JSONB keys safely.',
    ).toEqual([]);
  });
});
