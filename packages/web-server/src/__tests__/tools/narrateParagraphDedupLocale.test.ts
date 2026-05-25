/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-4 — narrate paragraph dedup is locale-safe.
//
// Before this slice the sanitizer keyed paragraph dedup on
// `p.trim().toLowerCase()`. That is unsafe for Turkish (the dotted-I
// rule) and any other case-folding locale, and worse, it implicitly
// inherits the host process's default locale at runtime.
//
// The new contract:
//   - With no language (or an invalid/empty BCP-47 tag) dedup uses
//     strict trimmed comparison. Case-different paragraphs are not
//     considered duplicates.
//   - With a valid BCP-47 tag the comparison is performed through
//     `toLocaleLowerCase(locale)` so `İstanbul` and `istanbul`
//     dedupe under `tr`, and `Hello` / `HELLO` dedupe under `en`.
//   - The `paragraph_dedup` pattern id still fires whenever at least
//     one paragraph is dropped, so the N-2 Phase 1 telemetry
//     contract stays compatible.

import {describe, expect, it} from 'vitest';
import {
  sanitiseNarrateText,
  sanitiseNarrateTextWithReport,
} from '../../tools/narrate/sanitiser.js';

describe('paragraph dedup — locale-aware (N-4)', () => {
  it('dedupes Turkish dotted-I when language=tr', () => {
    const input = 'İstanbul\n\nistanbul';
    const report = sanitiseNarrateTextWithReport(input, 'tr');
    // Under Turkish, `İ` lower-cases to `i`, so both paragraphs map
    // to the same key and the second one is dropped.
    expect(report.text).toBe('İstanbul');
    expect(report.patternsFired).toContain('paragraph_dedup');
    expect(report.changed).toBe(true);
  });

  it('keeps both paragraphs when no locale is supplied (strict trimmed comparison)', () => {
    const input = 'İstanbul\n\nistanbul';
    const report = sanitiseNarrateTextWithReport(input);
    // No locale → strict trimmed keys → distinct strings → no dedup.
    expect(report.text).toBe('İstanbul\n\nistanbul');
    expect(report.patternsFired).not.toContain('paragraph_dedup');
  });

  it('dedupes English mixed case under language=en', () => {
    const input = 'Hello there.\n\nHELLO THERE.';
    const report = sanitiseNarrateTextWithReport(input, 'en');
    expect(report.text).toBe('Hello there.');
    expect(report.patternsFired).toContain('paragraph_dedup');
  });

  it('keeps English mixed case as distinct paragraphs when no locale is given', () => {
    const input = 'Hello there.\n\nHELLO THERE.';
    const report = sanitiseNarrateTextWithReport(input);
    expect(report.text).toBe('Hello there.\n\nHELLO THERE.');
    expect(report.patternsFired).not.toContain('paragraph_dedup');
  });

  it('still collapses byte-identical duplicates regardless of locale', () => {
    // Exact strict duplicate must always dedupe — strict trimmed
    // comparison covers this without any locale handling.
    const exact = 'Mikka grins.\n\nMikka grins.';
    expect(sanitiseNarrateTextWithReport(exact).text).toBe('Mikka grins.');
    expect(sanitiseNarrateTextWithReport(exact, 'en').text).toBe('Mikka grins.');
    expect(sanitiseNarrateTextWithReport(exact, 'tr').text).toBe('Mikka grins.');
  });

  it('falls back to strict comparison when the locale tag is malformed', () => {
    // `***not-a-locale***` is rejected by `Intl.getCanonicalLocales`;
    // the sanitizer must not silently fall back to the host default
    // locale, so dedup stays strict-trimmed for safety.
    const input = 'Hello\n\nHELLO';
    const report = sanitiseNarrateTextWithReport(input, '***not-a-locale***');
    expect(report.text).toBe('Hello\n\nHELLO');
    expect(report.patternsFired).not.toContain('paragraph_dedup');
  });

  it('falls back to strict comparison when the locale tag is an empty string', () => {
    const input = 'Hello\n\nHELLO';
    const report = sanitiseNarrateTextWithReport(input, '');
    expect(report.text).toBe('Hello\n\nHELLO');
    expect(report.patternsFired).not.toContain('paragraph_dedup');
  });

  it('exposes the locale parameter on the public sanitiseNarrateText wrapper', () => {
    // Wrapper ABI must still return the string. The optional
    // language argument is a back-compat extension, so existing
    // single-arg callers stay unaffected.
    expect(sanitiseNarrateText('İstanbul\n\nistanbul', 'tr')).toBe('İstanbul');
    expect(sanitiseNarrateText('İstanbul\n\nistanbul')).toBe(
      'İstanbul\n\nistanbul',
    );
  });
});
