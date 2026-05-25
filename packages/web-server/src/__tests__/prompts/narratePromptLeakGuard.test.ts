/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-2 Phase 2 — prompt-side leak guard contract.
//
// The runtime sanitiser (Phase 1) records pattern firings as
// `gameplay narrate.sanitiser.fired`. Phase 2 closes the loop by
// telling every visible-prose prompt — common, narrator, broker
// (default + caveman), Scene Painter, protagonist action renderer
// — to never emit analysis headings, Stanislavski-labelled
// bullets, bracketed meta, raw JSON wrappers, or pseudo tool-call
// syntax. Phase 3 (deleting the runtime regexes) stays gated on
// telemetry showing those firings drop to zero or to an accepted
// threshold; this test pins the prompt-level contract so a future
// regression cannot quietly strip the anti-leak instructions.

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {beforeAll, describe, expect, it} from 'vitest';
import {setConfigEnv} from '../../config.js';
import {
  loadBrokerPromptForMode,
  loadCommonPrompt,
  loadNarratorPrompt,
} from '../../ai/prompts.js';
import {SCENE_PAINTER_ADDENDUM} from '../../agents/scenePainterPrompt.js';
import {buildProtagonistActionRendererPrompt} from '../../agents/protagonistActionRendererPrompt.js';

beforeAll(() => {
  // `loadBrokerFragment` reads `config().cavemanPrompts` per call;
  // the AUTH_SECRET-required schema needs at least one valid value
  // so the test runner can call into the broker assembler.
  setConfigEnv('AUTH_SECRET', 'narrate-prompt-test-secret-32-bytes-min');
});

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.resolve(TESTS_DIR, '..', '..', '..', 'prompts');

function readPromptFile(...segments: string[]): string {
  return readFileSync(path.join(PROMPTS_ROOT, ...segments), 'utf-8');
}

/** Tokens every visible-prose prompt surface must mention so the
 *  N-2 Phase 2 contract is unambiguous to the model. */
const LEAK_GUARD_CORE_TOKENS = [
  'Stanislavski',
  'Given Circumstances',
  'OOC',
  'JSON',
];

function expectContainsAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack).toContain(needle);
  }
}

describe('N-2 Phase 2 — visible-prose prompts carry the Analysis Leakage contract', () => {
  it('common Greenhaven prompt names every forbidden pattern class', () => {
    const prompt = loadCommonPrompt();
    expectContainsAll(prompt, LEAK_GUARD_CORE_TOKENS);
    expect(prompt).toContain('Analysis Leakage');
    expect(prompt).toContain('narrate.sanitiser.fired');
  });

  it('narrator prompt extends the contract for narrate.text specifically', () => {
    const prompt = loadNarratorPrompt();
    expectContainsAll(prompt, LEAK_GUARD_CORE_TOKENS);
    expect(prompt).toContain('Analysis Leakage');
    expect(prompt).toContain('narrate.text');
    // Bilingual anti-example coverage flows in through the narrator
    // prompt via the broker `internal-analysis.md` fragment; the
    // narrator wording itself must still call out the JSON-wrapper
    // failure mode.
    expect(prompt).toContain('JSON');
  });

  it('broker default-profile exploration prompt contains the bilingual anti-example block', () => {
    const prompt = loadBrokerPromptForMode('exploration');
    expectContainsAll(prompt, LEAK_GUARD_CORE_TOKENS);
    expect(prompt).toContain('Analysis Leakage');
    // English bad/good anti-example anchors.
    expect(prompt).toContain('Mikka grins at you');
    // Russian bad/good anti-example anchors.
    expect(prompt).toContain('Микка улыбается тебе');
    // The raw-JSON anti-example must be present in some form so the
    // model sees a concrete forbidden shape.
    expect(prompt).toContain('{"text":');
  });

  it('every broker mode profile still carries the contract (mode fragments share internal-analysis)', () => {
    for (const mode of ['exploration', 'dialogue', 'combat', 'intimacy'] as const) {
      const prompt = loadBrokerPromptForMode(mode);
      expect(prompt, `mode=${mode}`).toContain('Analysis Leakage');
      expect(prompt, `mode=${mode}`).toContain('Stanislavski');
    }
  });

  it('caveman internal-analysis variant ships the compact leak-guard wording', () => {
    // The caveman variant is loaded at runtime when
    // GREENHAVEN_CAVEMAN_PROMPTS=1; reading the file directly here
    // sidesteps the assembled-prompt cache and gives a stable
    // assertion regardless of the test process flags.
    const compact = readPromptFile('broker', 'internal-analysis.caveman.md');
    expectContainsAll(compact, LEAK_GUARD_CORE_TOKENS);
    expect(compact).toContain('Analysis Leakage');
    expect(compact).toContain('Mikka grins');
    expect(compact).toContain('Микка улыбается');
    expect(compact).toContain('{"text":');
  });

  it('SCENE_PAINTER_ADDENDUM blocks Analysis Leakage in T2 ambient prose', () => {
    expectContainsAll(SCENE_PAINTER_ADDENDUM, LEAK_GUARD_CORE_TOKENS);
    expect(SCENE_PAINTER_ADDENDUM).toContain('Analysis Leakage');
    expect(SCENE_PAINTER_ADDENDUM).toContain('narrate.text');
  });

  it('protagonist action renderer system prompt blocks Analysis Leakage in rendered_text', () => {
    const built = buildProtagonistActionRendererPrompt({
      rawText: 'I greet the trader.',
      language: 'en',
    });
    expectContainsAll(built.system, LEAK_GUARD_CORE_TOKENS);
    expect(built.system).toContain('Analysis Leakage');
    expect(built.system).toContain('rendered_text');
  });
});
