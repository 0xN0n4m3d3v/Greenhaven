/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Tiny shim used by the N-2 soak driver to normalize raw model /
// cartridge ids into stable diversity labels. Pins the argv contract
// (repeatable `--id`, `--id=` form, `--ids-json` JSON array, and the
// `--kind {model-family|cartridge}` selector) so PowerShell can rely
// on the documented surface.

import {describe, expect, it} from 'vitest';
import {parseShimArgs} from '../../scripts/n2-normalise-model-family.js';

describe('parseShimArgs', () => {
  it('reads repeated --id flags in order', () => {
    expect(
      parseShimArgs(['--id', 'deepseek-chat', '--id', 'claude-3.5-sonnet']),
    ).toEqual({ids: ['deepseek-chat', 'claude-3.5-sonnet'], kind: 'model-family'});
  });

  it('accepts the --id=value form', () => {
    expect(parseShimArgs(['--id=ds-r1', '--id=gpt-4o'])).toEqual({
      ids: ['ds-r1', 'gpt-4o'],
      kind: 'model-family',
    });
  });

  it('reads a JSON array via --ids-json', () => {
    expect(
      parseShimArgs(['--ids-json', '["deepseek-chat","claude-3.5-sonnet"]']),
    ).toEqual({ids: ['deepseek-chat', 'claude-3.5-sonnet'], kind: 'model-family'});
  });

  it('skips non-string entries inside --ids-json', () => {
    expect(parseShimArgs(['--ids-json', '["ok", 42, null, "two"]'])).toEqual({
      ids: ['ok', 'two'],
      kind: 'model-family',
    });
  });

  it('returns empty ids when no flags supplied', () => {
    expect(parseShimArgs([])).toEqual({ids: [], kind: 'model-family'});
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseShimArgs(['--unknown', 'x'])).toThrow(/unknown flag/);
    expect(() => parseShimArgs(['--id'])).toThrow(/missing value/);
    expect(() => parseShimArgs(['--ids-json'])).toThrow(/missing value/);
  });

  it('rejects --ids-json that is not a JSON array', () => {
    expect(() => parseShimArgs(['--ids-json', '"not an array"'])).toThrow(
      /must be a JSON array/,
    );
    expect(() => parseShimArgs(['--ids-json', '{"foo":1}'])).toThrow(
      /must be a JSON array/,
    );
  });

  it('reads --kind in both `--kind X` and `--kind=X` forms', () => {
    expect(
      parseShimArgs(['--kind', 'cartridge', '--id', 'grinhaven-full']),
    ).toEqual({ids: ['grinhaven-full'], kind: 'cartridge'});
    expect(
      parseShimArgs(['--kind=cartridge', '--id=grinhaven-full']),
    ).toEqual({ids: ['grinhaven-full'], kind: 'cartridge'});
  });

  it('defaults --kind to model-family and rejects unknown values', () => {
    // Pre-cartridge callers that never pass --kind keep the old shape.
    expect(parseShimArgs(['--id', 'deepseek-chat']).kind).toBe('model-family');
    expect(() => parseShimArgs(['--kind', 'galaxies'])).toThrow(
      /unknown --kind value/,
    );
    expect(() => parseShimArgs(['--kind'])).toThrow(/missing value for --kind/);
  });
});
