/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Focused tests for `cartridge:i18n:check`'s Materializes create-
// candidate contract. The Obsidian vault validator already treats
// authored `materializes[*].entity` rows with `target_status: 'new'`
// as forward references (the materializer tool will create the entity
// at runtime), but the cartridge validator previously flagged them as
// `missing_mention_target`. This file pins the new behavior:
//
//   * `target_status: 'new'` entity field → no error.
//   * `target_status: 'existing'` entity field → must resolve to a
//     real entity, otherwise still errors.
//   * Multi-word create-candidate names ("@Quiet trading token")
//     don't get tokenized to their first word ("@Quiet") — the
//     candidate set is passed into `extractMentions` as additional
//     known names so longest-match captures the full target.
//   * Mentions in `scope`, `effect`, `source_mention` validate
//     normally (resolved via `entityByName` like any other field).
//   * `source_markdown` prose that mentions a create-candidate name
//     of the same entity is also exempt — the materializer block
//     authored those names, so they're forward references for the
//     same entity.
//   * Ordinary unresolved prose mentions outside any create-candidate
//     name still produce `missing_mention_target`.

import {describe, expect, it} from 'vitest';
import {
  checkMentions,
  collectMaterializerCreateCandidates,
  type CartridgeValidationIssue,
  type EntityRow,
} from '../../devtools/validateCartridge.js';

function makeEntity(profile: Record<string, unknown>): EntityRow {
  return {
    id: 938547,
    kind: 'person',
    display_name: 'Sable Vey',
    summary: null,
    profile,
    i18n: {},
    cartridge_id: 'grinhaven-full',
    dynamic_origin: false,
  };
}

function makeKnownNames(names: string[]): Map<string, EntityRow> {
  return new Map(
    names.map(name => [
      name,
      {
        id: 1,
        kind: 'location',
        display_name: name,
        summary: null,
        profile: {},
        i18n: {},
        cartridge_id: 'grinhaven-full',
        dynamic_origin: false,
      },
    ]),
  );
}

function runMentions(
  profile: Record<string, unknown>,
  knownNames: string[] = [],
): CartridgeValidationIssue[] {
  const entity = makeEntity(profile);
  const map = makeKnownNames(knownNames);
  const issues: CartridgeValidationIssue[] = [];
  checkMentions(entity, profile, '$.profile', map, issues);
  return issues;
}

describe('collectMaterializerCreateCandidates', () => {
  it('returns an empty set when materializes is missing or not an array', () => {
    expect(collectMaterializerCreateCandidates(makeEntity({}))).toEqual(new Set());
    expect(
      collectMaterializerCreateCandidates(makeEntity({materializes: 'not-array'})),
    ).toEqual(new Set());
  });

  it('extracts only target_status="new" rows, stripping the leading @', () => {
    const entity = makeEntity({
      materializes: [
        {entity: '@Quiet trading token', target_status: 'new'},
        {entity: '@Existing market', target_status: 'existing'},
        {entity: '@Locked market box', target_status: 'new'},
        {entity: '@Thief’s market', target_status: 'existing'},
        {entity: 'no-at-prefix', target_status: 'new'},
        {entity: '   ', target_status: 'new'},
        {target_status: 'new'},
      ],
    });
    expect(collectMaterializerCreateCandidates(entity)).toEqual(
      new Set(['Quiet trading token', 'Locked market box', 'no-at-prefix']),
    );
  });
});

describe('checkMentions Materializes create-candidate contract', () => {
  it('exempts target_status="new" entity from missing_mention_target', () => {
    const profile = {
      materializes: [
        {
          entity: '@Quiet trading token',
          target_status: 'new',
          scope: 'hero inventory',
          effect: 'герой может торговать.',
          source_mention: '@Sable Vey',
        },
      ],
    };
    const issues = runMentions(profile, ['Sable Vey']);
    expect(issues).toEqual([]);
  });

  it('still flags target_status="existing" entity that does not resolve', () => {
    const profile = {
      materializes: [
        {
          entity: '@Nowhere room',
          target_status: 'existing',
        },
      ],
    };
    const issues = runMentions(profile, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('missing_mention_target');
    expect(issues[0]?.path).toBe('$.profile.materializes[0].entity');
    // The "existing" target is NOT in the create-candidate set, so
    // `extractMentions` falls back to its single-token capture
    // ("@Nowhere") and the validator still errors. That's the
    // canonical behavior the extractMentions tests pin too.
    expect(issues[0]?.message).toContain('@Nowhere');
    expect(issues[0]?.message).not.toContain('@Nowhere room');
  });

  it('does not tokenize a multi-word candidate to its first word in source_markdown', () => {
    // The bug we're closing: extractMentions previously fell back to
    // a single-token capture for "@Quiet trading token" because no
    // known display name matched. We now inject the candidate names
    // as known names so longest-match captures the full target, and
    // suppress the error since the materializer will create it.
    const profile = {
      materializes: [
        {entity: '@Quiet trading token', target_status: 'new'},
      ],
      source_markdown:
        '## Materializes\n\n- Entity: @Quiet trading token\n',
    };
    const issues = runMentions(profile, []);
    expect(issues).toEqual([]);
  });

  it('validates scope/effect/source_mention against entityByName as normal prose', () => {
    const profile = {
      materializes: [
        {
          entity: '@Quiet trading token',
          target_status: 'new',
          scope: 'between @Sable Vey and the hero',
          effect: 'герой получает доступ к @Thief’s market.',
          source_mention: '@Sable Vey',
        },
      ],
    };
    // Both Sable Vey + Thief's market exist as entities → no errors.
    const issues = runMentions(profile, ['Sable Vey', 'Thief’s market']);
    expect(issues).toEqual([]);
  });

  it('flags an ordinary unresolved prose mention outside any create-candidate', () => {
    const profile = {
      materializes: [
        {entity: '@Quiet trading token', target_status: 'new'},
      ],
      narrator_brief: 'meet @TotallyUnknown at the gate',
    };
    const issues = runMentions(profile, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('missing_mention_target');
    expect(issues[0]?.path).toBe('$.profile.narrator_brief');
    expect(issues[0]?.message).toContain('@TotallyUnknown');
  });

  it('reproduces the original Sable Vey failure shape and resolves it', () => {
    // The exact materializes block from the donor cartridge entry
    // 938547 (Sable Vey) that was failing cartridge_i18n_check
    // before this slice. With the create-candidate exemption, all
    // six previously-reported errors are gone.
    const profile = {
      materializes: [
        {
          entity: '@Quiet trading token',
          target_status: 'new',
          type: 'item/access-state',
          scope: 'hero inventory and @Thief’s market',
          effect: 'герой может торговать в @Thief’s market.',
        },
        {
          entity: '@Locked market box',
          target_status: 'new',
          type: 'container/service',
          scope: 'under @Sable Vey’s control',
          effect: 'я помню, какой предмет принят на хранение.',
        },
        {
          entity: '@Back room under Thief’s market',
          target_status: 'new',
          type: 'location/shelter',
          scope: 'inside @Thief’s market',
          effect: 'у героя есть оплаченный доступ.',
        },
      ],
      source_markdown:
        '## Materializes\n\n'
        + '- Когда герой платит за тихий торговый жетон:\n'
        + '  - Entity: @Quiet trading token\n'
        + '  - Type: item/access-state\n'
        + '- Когда герой платит за безопасное хранение:\n'
        + '  - Entity: @Locked market box\n'
        + '- Когда герой платит за временное укрытие:\n'
        + '  - Entity: @Back room under Thief’s market\n',
    };
    const issues = runMentions(profile, ['Sable Vey', 'Thief’s market']);
    expect(issues).toEqual([]);
  });

  it('flags target_status="existing" that points at a missing entity, even if the name shape resembles a create-candidate', () => {
    // Belt-and-suspenders: an "existing" pointer with a multi-word
    // name that doesn't resolve should still error. The
    // create-candidate set is filtered to target_status="new", so
    // this row's name is NOT in the candidate set and the
    // single-token fallback fires on the first word.
    const profile = {
      materializes: [
        {entity: '@Phantom token', target_status: 'existing'},
      ],
    };
    const issues = runMentions(profile, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('missing_mention_target');
    expect(issues[0]?.path).toBe('$.profile.materializes[0].entity');
    expect(issues[0]?.message).toContain('@Phantom');
  });

  it('does not skip mentions in entities that have no materializes block at all', () => {
    const profile = {
      narrator_brief: 'meet @WhoEverThisIs at the door',
    };
    const issues = runMentions(profile, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('$.profile.narrator_brief');
  });
});
