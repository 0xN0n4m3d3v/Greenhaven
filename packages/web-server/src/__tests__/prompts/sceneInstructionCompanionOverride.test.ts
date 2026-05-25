/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-9 — authored scene fields override generic companion guidance.
//
// The static preamble may carry a `## SCENE INSTRUCTIONS` block with
// authored `behavior:` / `voice:` / `do_not:` lines per scene row.
// When the player has at least one active companion the broker prompt
// also appends `companions.md`, which carries a generic "what a loyal
// companion does" contract (party support, peacemaking, calming the
// hero, soft interjections, ...). Without an explicit precedence
// statement the model would happily let the generic companion contract
// override a scene-authored `do_not:` line such as "не успокаивать
// героя как generic companion".
//
// This test pins three things at the prompt layer so a future
// regression cannot quietly strip the override contract:
//   1. The conditional `companions.md` fragment is loaded for every
//      broker mode when `{hasCompanion: true}` is passed.
//   2. The assembled default prompt names `SCENE INSTRUCTIONS` and
//      states that authored `do_not:` lines override generic companion
//      defaults (the exact `generic companion` token is the same
//      anti-pattern the live Mikka violence-starts scene calls out).
//   3. The caveman-compressed variant carries the same contract in a
//      compact form so token-budget mode does not silently drop the
//      override semantics.

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {beforeAll, describe, expect, it} from 'vitest';
import {setConfigEnv} from '../../config.js';
import {
  brokerPromptFragmentFilesForMode,
  loadBrokerPromptForMode,
} from '../../ai/prompts.js';

beforeAll(() => {
  setConfigEnv(
    'AUTH_SECRET',
    'scene-instruction-companion-override-test-secret-32-bytes',
  );
});

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.resolve(TESTS_DIR, '..', '..', '..', 'prompts');

function readPromptFile(...segments: string[]): string {
  return readFileSync(path.join(PROMPTS_ROOT, ...segments), 'utf-8');
}

const BROKER_MODES = ['exploration', 'dialogue', 'combat', 'intimacy'] as const;

const OVERRIDE_CORE_TOKENS = [
  'SCENE INSTRUCTIONS',
  'override',
  'generic companion',
  'do_not',
] as const;

function expectContainsAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack).toContain(needle);
  }
}

describe('OWV-9 — authored scene fields override generic companion guidance', () => {
  it('companions.md fragment is loaded for every broker mode when a companion is active', () => {
    // `companions.md` is currently in the base fragment list and is
    // also requested conditionally when `hasCompanion=true`; what
    // OWV-9 needs to pin is that the fragment is present whenever
    // the override semantics matter (i.e., the player has at least
    // one active companion). The de-duped output always carries
    // it, but that is the conservative outcome — if a future
    // refactor moves the fragment behind the conditional, the
    // hasCompanion=true path must still load it.
    for (const mode of BROKER_MODES) {
      const withCompanion = brokerPromptFragmentFilesForMode(mode, 'default', {
        hasCompanion: true,
      });
      expect(withCompanion, `mode=${mode} hasCompanion=true`).toContain(
        'companions.md',
      );
    }
  });

  it('every default broker mode prompt carries the override contract when a companion is present', () => {
    for (const mode of BROKER_MODES) {
      const prompt = loadBrokerPromptForMode(mode, 'default', {
        hasCompanion: true,
      });
      expectContainsAll(prompt, OVERRIDE_CORE_TOKENS);
      // Spell-out check: the prompt must say *precedence*, not just
      // "see scene block" — that is the contract the live Mikka
      // violence-starts scene depends on.
      expect(
        prompt,
        `mode=${mode}: override block must claim precedence`,
      ).toMatch(/precedence|override/i);
    }
  });

  it('default companions.md fragment file itself names the override contract', () => {
    // Reading the file directly catches the case where assembly
    // accidentally trims the contract (e.g. if a future edit dropped
    // the section heading and the body got reflowed into another
    // fragment's content).
    const compact = readPromptFile('broker', 'companions.md');
    expectContainsAll(compact, OVERRIDE_CORE_TOKENS);
    expect(compact).toMatch(/precedence|override/i);
    // The contract must be visibly placed near the top so the model
    // reads it before the generic chains.
    const headingIndex = compact.indexOf(
      'Authored scenes override generic companion guidance',
    );
    const firstChainIndex = compact.indexOf('### Joining the party');
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(firstChainIndex).toBeGreaterThan(headingIndex);
  });

  it('caveman companions variant ships the compact override contract', () => {
    const compact = readPromptFile('broker', 'companions.caveman.md');
    expectContainsAll(compact, OVERRIDE_CORE_TOKENS);
    expect(compact).toMatch(/precedence|override/i);
  });
});
