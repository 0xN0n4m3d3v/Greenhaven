/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-3 — adventure domain-pack boundary check.
//
// Invariants the static check enforces:
//   1. The legacy `agents/adventureMaterializer*.ts` cluster is gone
//      (materializer slice, closed 2026-05-16).
//   2. The legacy `src/adventure/` runtime folder is gone (runtime
//      slice, closed 2026-05-16). All runtime modules live under
//      `src/domain/adventure/runtime/`.
//   3. `src/services/AdventureService.ts` is gone; the service lives
//      at `src/domain/adventure/AdventureService.ts`.
//   4. No production source file outside `src/domain/adventure/**`
//      imports `../adventure/X.js`, `services/AdventureService.js`,
//      `domain/adventure/runtime/X.js`, or
//      `domain/adventure/AdventureService.js` directly. Production
//      callers must route through `domain/adventure/index.ts` or
//      `domain/adventure/materializer/index.ts`.
//      Tests under `__tests__/**` are exempt — they may target the
//      leaf files when the focused coverage requires it (e.g. for
//      `vi.mock(...)` targets).
//   5. The new `domain/adventure/materializer/index.ts` barrel exists
//      and exports the documented surface.
//   6. The new `domain/adventure/index.ts` facade exists and exports
//      the documented surface (AdventureService, hooks, queue helpers,
//      types).
//
// The scan walks `src/` recursively and skips this test file plus
// `node_modules/` and `dist/`. The check is intentionally textual:
// regex-driven import-string matching catches a stray re-introduction
// of any legacy import path the moment an editor saves it.

import {readdirSync, readFileSync, statSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, relative, sep} from 'node:path';
import {describe, expect, it} from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AGENTS_DIR = join(ROOT, 'agents');
const LEGACY_ADVENTURE_DIR = join(ROOT, 'adventure');
const LEGACY_SERVICES_ADV = join(ROOT, 'services', 'AdventureService.ts');
const MATERIALIZER_BARREL_DIR = join(ROOT, 'domain', 'adventure', 'materializer');
const DOMAIN_FACADE_DIR = join(ROOT, 'domain', 'adventure');
const SELF = fileURLToPath(import.meta.url);

const LEGACY_MATERIALIZER_FILE_NAMES = [
  'adventureMaterializer.ts',
  'adventureMaterializerFallback.ts',
  'adventureMaterializerInput.ts',
  'adventureMaterializerPrompt.ts',
  'adventureMaterializerQueue.ts',
  'adventureMaterializerTypes.ts',
];

// Forbidden import patterns, matched on full `from '...'` clauses.
// Production source outside `domain/adventure/**` and outside
// `__tests__/**` must not match any of these.
const FORBIDDEN_IMPORTS: Array<{label: string; re: RegExp}> = [
  {
    label: 'agents/adventureMaterializer*',
    re: /from\s+['"][^'"]*agents\/adventureMaterializer[A-Za-z]*\.js['"]/,
  },
  {
    label: 'legacy adventure/* (use domain/adventure facade)',
    re: /from\s+['"](?:\.{1,2}\/)+adventure\/[a-zA-Z]+\.js['"]/,
  },
  {
    label: 'services/AdventureService (moved to domain/adventure)',
    re: /from\s+['"][^'"]*services\/AdventureService\.js['"]/,
  },
  {
    label: 'domain/adventure/runtime/* (use the facade instead)',
    re: /from\s+['"][^'"]*domain\/adventure\/runtime\/[a-zA-Z]+\.js['"]/,
  },
  {
    label: 'domain/adventure/AdventureService (use the facade instead)',
    re: /from\s+['"][^'"]*domain\/adventure\/AdventureService\.js['"]/,
  },
];

describe('ARCH-3 — adventure domain-pack boundary', () => {
  it('removes every legacy agents/adventureMaterializer*.ts file', () => {
    const offenders = LEGACY_MATERIALIZER_FILE_NAMES.filter(name =>
      existsSync(join(AGENTS_DIR, name)),
    );
    expect(
      offenders,
      `Legacy materializer files must be deleted: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('removes the legacy src/adventure/ runtime folder', () => {
    expect(
      existsSync(LEGACY_ADVENTURE_DIR),
      'src/adventure/ must no longer exist; runtime lives under src/domain/adventure/runtime/',
    ).toBe(false);
  });

  it('removes the legacy src/services/AdventureService.ts', () => {
    expect(
      existsSync(LEGACY_SERVICES_ADV),
      'src/services/AdventureService.ts must no longer exist; it lives at src/domain/adventure/AdventureService.ts',
    ).toBe(false);
  });

  it('no production source outside domain/adventure imports legacy or internal adventure paths', () => {
    const offenders: Array<{file: string; line: string; label: string}> = [];
    for (const file of walkTsFiles(ROOT)) {
      if (file === SELF) continue;
      if (isInsideDomainAdventure(file)) continue;
      if (isTestFile(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const {label, re} of FORBIDDEN_IMPORTS) {
        const globalRe = new RegExp(re.source, 'g');
        const matches = text.match(globalRe);
        if (!matches) continue;
        for (const m of matches) {
          offenders.push({file: relative(ROOT, file), line: m, label});
        }
      }
    }
    expect(
      offenders,
      `Files importing forbidden adventure paths:\n  ${offenders
        .map(o => `${o.file}: ${o.line} [${o.label}]`)
        .join('\n  ')}`,
    ).toEqual([]);
  });

  it('domain/adventure/materializer barrel exports the public surface', async () => {
    expect(existsSync(join(MATERIALIZER_BARREL_DIR, 'index.ts'))).toBe(true);
    const mod = await import('../../domain/adventure/materializer/index.js');
    expect(typeof mod.adventureMaterializerHook).toBe('object');
    expect(mod.adventureMaterializerHook.name).toBe('adventure_materializer');
    expect(typeof mod.materializeNextAdventureForSession).toBe('function');
    expect(typeof mod.buildMaterializerInput).toBe('function');
    expect(typeof mod.buildFallbackSituation).toBe('function');
    expect(typeof mod.tryMaterializerFallback).toBe('function');
    expect(typeof mod.claimQueuedAdventureForCurrentTurn).toBe('function');
    expect(typeof mod.adventureMaterializerPrompt).toBe('object');
    expect(typeof mod.adventureMaterializerPrompt.system).toBe('string');
    expect(typeof mod.adventureMaterializerPrompt.buildUser).toBe('function');
    expect(typeof mod.MaterializerOutput).toBe('object');
    expect(typeof mod.ADVENTURE_MATERIALIZER_SLOT_DEADLINE_MS).toBe('number');
    expect(typeof mod.ADVENTURE_MATERIALIZER_SPECIALIST_TIMEOUT_MS).toBe(
      'number',
    );
  });

  it('domain/adventure facade exports the runtime + service public surface', async () => {
    expect(existsSync(join(DOMAIN_FACADE_DIR, 'index.ts'))).toBe(true);
    const mod = await import('../../domain/adventure/index.js');
    // Runtime queue helpers.
    expect(typeof mod.maybeEnqueueAdventureOpportunity).toBe('function');
    expect(typeof mod.expireStaleReadyAdventures).toBe('function');
    expect(typeof mod.listAdventureQueue).toBe('function');
    expect(typeof mod.recoverAbandonedMaterializingAdventures).toBe('function');
    expect(typeof mod.markAdventureReady).toBe('function');
    expect(typeof mod.adventureOracleHook).toBe('object');
    expect(mod.adventureOracleHook.name).toBe('adventure_oracle');
    // Service surface.
    expect(typeof mod.AdventureService).toBe('function');
    expect(typeof mod.acceptPlayerAdventure).toBe('function');
    expect(typeof mod.ignorePlayerAdventure).toBe('function');
    expect(typeof mod.listPlayerAdventures).toBe('function');
    // Intent surface.
    expect(typeof mod.maybeAcceptReadyAdventureFromText).toBe('function');
    expect(typeof mod.maybeIgnoreReadyAdventureFromText).toBe('function');
    // Schema constants.
    expect(typeof mod.ADVENTURE_BLUEPRINT_SCHEMA_VERSION).toBe('string');
  });
});

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTsFiles(full);
      continue;
    }
    if (!st.isFile()) continue;
    if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      yield full;
    }
  }
}

function isInsideDomainAdventure(file: string): boolean {
  const prefix = join(ROOT, 'domain', 'adventure') + sep;
  return file.startsWith(prefix);
}

function isTestFile(file: string): boolean {
  return file.includes(`${sep}__tests__${sep}`);
}
