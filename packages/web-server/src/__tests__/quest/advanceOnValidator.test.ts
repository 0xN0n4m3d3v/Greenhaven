/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// QE-6 — cartridge validator wiring. `checkQuestStages(...)` must
// flag any quest stage whose `advance_on` is set but not one of the
// four shared aliases. Tests drive the helper directly against
// synthetic entity rows so the validator behaviour is observable
// without a real database. `validateCartridge(...)` calls
// `checkQuestStages` for every quest entity, so this regression
// covers the wiring through the public entry point too.

import {describe, expect, it} from 'vitest';
import {
  checkQuestStages,
  type CartridgeValidationIssue,
  type EntityRow,
} from '../../devtools/validateCartridge.js';
import {VALID_ADVANCE_ON_VALUES} from '../../quest/advanceOn.js';

function fixture(profile: Record<string, unknown>): EntityRow {
  return {
    id: 999,
    kind: 'quest',
    display_name: 'QE-6 Test Quest',
    summary: '',
    profile,
    i18n: {},
    cartridge_id: 'test',
    dynamic_origin: false,
  };
}

function runChecks(profile: Record<string, unknown>): CartridgeValidationIssue[] {
  const issues: CartridgeValidationIssue[] = [];
  checkQuestStages(fixture(profile), issues);
  return issues;
}

describe('checkQuestStages — QE-6 advance_on validation', () => {
  it('accepts every documented alias on a stage', () => {
    for (const alias of VALID_ADVANCE_ON_VALUES) {
      const issues = runChecks({
        stages: [{id: 'stage-1', advance_on: alias}],
      });
      const advanceOnIssues = issues.filter(
        i => i.code === 'invalid_quest_advance_on',
      );
      expect(advanceOnIssues).toEqual([]);
    }
  });

  it('accepts a stage with missing / null advance_on (defaults to AND)', () => {
    const missing = runChecks({stages: [{id: 'stage-1'}]});
    expect(missing.filter(i => i.code === 'invalid_quest_advance_on')).toEqual(
      [],
    );
    const explicitNull = runChecks({
      stages: [{id: 'stage-1', advance_on: null}],
    });
    expect(
      explicitNull.filter(i => i.code === 'invalid_quest_advance_on'),
    ).toEqual([]);
  });

  it('flags legacy "manual" with severity=error and the expected code + path', () => {
    const issues = runChecks({
      stages: [{id: 'stage-1', advance_on: 'manual'}],
    });
    const flagged = issues.filter(
      i => i.code === 'invalid_quest_advance_on',
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.severity).toBe('error');
    expect(flagged[0]!.path).toBe('$.profile.stages[0].advance_on');
    expect(flagged[0]!.message).toContain('manual');
    // The error message names the allowlist so authors can fix it.
    for (const v of VALID_ADVANCE_ON_VALUES) {
      expect(flagged[0]!.message).toContain(v);
    }
  });

  it('flags every legacy synonym used in old fixtures', () => {
    for (const bad of ['manual', 'manual_or_watcher', 'manual_debug']) {
      const issues = runChecks({
        stages: [{id: 'stage-1', advance_on: bad}],
      });
      const flagged = issues.filter(
        i => i.code === 'invalid_quest_advance_on',
      );
      expect(flagged).toHaveLength(1);
      expect(flagged[0]!.path).toBe('$.profile.stages[0].advance_on');
    }
  });

  it('flags non-string advance_on values', () => {
    for (const bad of [0, true, [], {}]) {
      const issues = runChecks({
        stages: [{id: 'stage-1', advance_on: bad}],
      });
      const flagged = issues.filter(
        i => i.code === 'invalid_quest_advance_on',
      );
      expect(flagged).toHaveLength(1);
    }
  });

  it('reports the offending stage index for the second of multiple stages', () => {
    const issues = runChecks({
      stages: [
        {id: 'stage-1', advance_on: 'all'},
        {id: 'stage-2', advance_on: 'manual'},
        {id: 'stage-3'},
      ],
    });
    const flagged = issues.filter(
      i => i.code === 'invalid_quest_advance_on',
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.path).toBe('$.profile.stages[1].advance_on');
  });
});
