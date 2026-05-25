/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// X-3 follow-up — focused tests for `parseQuestChoiceActionId`.
//
// Replaces the previous `^quest-choice:(\d+):(.+)$` regex in
// `QuestChoicePhase.ts`. The wire-format actionId is
// `quest-choice:<questId>:<targetStageId>` and target stage IDs may
// themselves contain colons (e.g. namespaced cartridge stage keys
// like `route:dock:north`), so the parser must split on the FIRST two
// colons and treat the remainder as the target — the old regex
// already did this via `(.+)$`, and the new parser preserves the
// behaviour without an X-3-flagged regex literal.

import {describe, expect, it} from 'vitest';
import {parseQuestChoiceActionId} from '../../turn/phases/QuestChoicePhase.js';

describe('parseQuestChoiceActionId', () => {
  it('parses a canonical quest-choice action id', () => {
    expect(parseQuestChoiceActionId('quest-choice:42:branch_a')).toEqual({
      questId: 42,
      targetStageId: 'branch_a',
    });
  });

  it('preserves target stage IDs that contain additional colons', () => {
    expect(
      parseQuestChoiceActionId('quest-choice:7:route:dock:north'),
    ).toEqual({
      questId: 7,
      targetStageId: 'route:dock:north',
    });
  });

  it('returns null when the prefix is missing', () => {
    expect(parseQuestChoiceActionId('attack:42')).toBeNull();
    expect(parseQuestChoiceActionId('social:1:persuade')).toBeNull();
    expect(parseQuestChoiceActionId('free-text-input')).toBeNull();
  });

  it('returns null for non-string / empty / undefined input', () => {
    expect(parseQuestChoiceActionId(undefined)).toBeNull();
    expect(parseQuestChoiceActionId(null)).toBeNull();
    expect(parseQuestChoiceActionId('')).toBeNull();
  });

  it('returns null when the quest id is not a positive integer', () => {
    expect(parseQuestChoiceActionId('quest-choice:0:branch')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice:-3:branch')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice:1.5:branch')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice:abc:branch')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice::branch')).toBeNull();
  });

  it('rejects non-decimal quest IDs that `Number(...)` would silently coerce', () => {
    // The previous `Number(questIdRaw)` accepted hex literals, exponent
    // notation, and whitespace-padded inputs — the strict decimal
    // scanner now rejects them just like the prior `\d+` regex did.
    expect(parseQuestChoiceActionId('quest-choice:0x2:x')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice:0X2:x')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice:1e3:x')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice:1E3:x')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice: 2:x')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice:2 :x')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice:+2:x')).toBeNull();
  });

  it('accepts leading zeros to match the prior `\\d+` regex behaviour', () => {
    // `\d+` matched leading zeros; the strict decimal scanner does too.
    expect(parseQuestChoiceActionId('quest-choice:007:branch_c')).toEqual({
      questId: 7,
      targetStageId: 'branch_c',
    });
  });

  it('returns null when the target stage id is empty or whitespace-only', () => {
    expect(parseQuestChoiceActionId('quest-choice:42:')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice:42:   ')).toBeNull();
  });

  it('returns null when only one colon segment is present (missing target)', () => {
    expect(parseQuestChoiceActionId('quest-choice:42')).toBeNull();
    expect(parseQuestChoiceActionId('quest-choice')).toBeNull();
  });

  it('trims trailing/leading whitespace from the target stage id', () => {
    expect(parseQuestChoiceActionId('quest-choice:42:  branch_b  ')).toEqual({
      questId: 42,
      targetStageId: 'branch_b',
    });
  });
});
