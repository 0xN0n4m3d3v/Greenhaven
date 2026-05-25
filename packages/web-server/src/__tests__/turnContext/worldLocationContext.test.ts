/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  renderLocalHooks,
  renderMaterializerHooks,
  renderPeopleHere,
  renderItemsHere,
} from '../../turnContext/worldLocationContext.js';
import type {EntityRow} from '../../turnContext/entitySections.js';
import type {MaterializerEntry} from '../../services/MaterializerBridgeService.js';

function item(profile: Record<string, unknown>): EntityRow & {count?: number} {
  return {
    id: 77,
    kind: 'item',
    display_name: 'Missing Passenger Notice',
    summary: 'A fresh notice pinned to the arrivals post.',
    profile,
    tags: null,
    i18n: null,
  };
}

function hook(kind: string, profile: Record<string, unknown>): EntityRow {
  return {
    id: 88,
    kind,
    display_name: kind === 'scene' ? 'Cellar Door Scrape' : 'Find The Ledger',
    summary: 'Playable local hook.',
    profile,
    tags: null,
    i18n: null,
  };
}

function npc(profile: Record<string, unknown>): EntityRow {
  return {
    id: 99,
    kind: 'person',
    display_name: 'Tessa Wrenlight',
    summary: 'Port scout and first quest giver.',
    profile,
    tags: null,
    i18n: null,
  };
}

describe('renderItemsHere', () => {
  it('surfaces authored item affordances and constraints', () => {
    const rendered = renderItemsHere([
      item({
        item_canon: 'Clue item visible at Greenhaven Port.',
        item_usage: 'Read, compare with wax, tear down with consequence.',
        threat_profile: 'Removing it publicly attracts the wrong eyes.',
        cross_hub_reach: 'The main square witness circle reacts to it.',
        do_not_do_here: 'Do not turn the notice into ambient flavor.',
      }),
    ]);

    expect(rendered).toContain('## ITEMS HERE');
    expect(rendered).toContain('canon: Clue item visible at Greenhaven Port.');
    expect(rendered).toContain(
      'usage: Read, compare with wax, tear down with consequence.',
    );
    expect(rendered).toContain(
      'threat: Removing it publicly attracts the wrong eyes.',
    );
    expect(rendered).toContain(
      'cross_hub: The main square witness circle reacts to it.',
    );
    expect(rendered).toContain(
      'do_not: Do not turn the notice into ambient flavor.',
    );
  });

  it('clips oversized item fields', () => {
    const rendered = renderItemsHere([
      item({item_usage: `start ${'x'.repeat(900)} end`}),
    ]);

    expect(rendered).toContain('usage: start');
    expect(rendered).toContain('...');
    expect(rendered).not.toContain(' end');
  });
});

describe('renderMaterializerHooks', () => {
  it('surfaces exact materializer ids for authored world changes', () => {
    const entry: MaterializerEntry = {
      materializerId: 'mat-open-cellar',
      sourceSlug: 'greenhaven-port',
      sourceMention: '@Greenhaven Port',
      sourceKind: 'location',
      sourceEntityId: 10,
      sourcePath: 'GreenHavenWorld/Locations/@Greenhaven Port/PortMind.md',
      entity: '@Blue Warehouse Cellar Door',
      entitySlug: 'blue-warehouse-cellar-door',
      targetEntityId: 22,
      targetStatus: 'existing',
      triggerCondition: 'When the hero opens the hatch.',
      triggerSource: 'location_explore',
      type: 'access / threat',
      scope: '@Greenhaven Port',
      scopeMentions: [
        {mention: '@Greenhaven Port', slug: 'greenhaven-port', entityId: 10},
      ],
      effect: 'The cellar door becomes an interactable dangerous object.',
    };

    const rendered = renderMaterializerHooks([entry]);

    expect(rendered).toContain('## MATERIALIZER HOOKS');
    expect(rendered).toContain('id=mat-open-cellar');
    expect(rendered).toContain('call apply_materializer_bridge');
    expect(rendered).toContain('trigger_source=location_explore');
    expect(rendered).toContain('target=@Blue Warehouse Cellar Door');
    expect(rendered).toContain('type=access / threat');
  });
});

describe('renderLocalHooks', () => {
  it('surfaces authored scene frames instead of only scene summaries', () => {
    const rendered = renderLocalHooks([
      hook('scene', {
        scene_trigger: 'The player kneels near the shaking hatch.',
        beat_by_beat: '1. The wood jumps. 2. A voice whispers below.',
        player_choices: '- Lift the latch.\n- Call for Tessa.',
        memory_and_string_changes: 'Tessa remembers whether the hero called her.',
        success_result: 'The cellar route opens safely.',
        failure_result: 'The rats break through first.',
      }),
    ]);

    expect(rendered).toContain('## LOCAL HOOKS');
    expect(rendered).toContain('scene: **Cellar Door Scrape**');
    expect(rendered).toContain(
      'trigger: The player kneels near the shaking hatch.',
    );
    expect(rendered).toContain('choices: - Lift the latch. - Call for Tessa.');
    expect(rendered).toContain(
      'memory_strings: Tessa remembers whether the hero called her.',
    );
  });

  it('surfaces authored quest frames and runtime stage ids', () => {
    const rendered = renderLocalHooks([
      hook('quest', {
        objective: 'Find the ledger before the rival crew moves it.',
        success_result: 'The evidence chain holds.',
        reward_and_consequence: '+strings with Tessa.',
        stages: [
          {id: 'stage-1', title: 'Question Tessa.', next_stage: 'stage-2'},
          {id: 'stage-2', title: 'Inspect the warehouse.', next_stage: {kind: 'choice'}},
        ],
      }),
    ]);

    expect(rendered).toContain('quest: **Find The Ledger**');
    expect(rendered).toContain('objective: Find the ledger');
    expect(rendered).toContain('stages: stage-1: Question Tessa. -> stage-2');
    expect(rendered).toContain('stage-2: Inspect the warehouse. -> choice');
  });
});

describe('renderPeopleHere', () => {
  it('surfaces authored NPC motivation, relationship, and companion frames', () => {
    const rendered = renderPeopleHere(
      [
        npc({
          role: 'Quest giver, scout, possible companion.',
          want: 'Find the missing passenger before the rival crew buries it.',
          fear: 'The hero treats the case as a performance.',
          relationship_triggers: '+strings when the hero protects witnesses.',
          companion_rules: 'Join condition: hero proves the port route is safe.',
        }),
      ],
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Map(),
    );

    expect(rendered).toContain('## PEOPLE HERE');
    expect(rendered).toContain('role: Quest giver, scout, possible companion.');
    expect(rendered).toContain(
      'relationship_triggers: +strings when the hero protects witnesses.',
    );
    expect(rendered).toContain(
      'companion_rules: Join condition: hero proves the port route is safe.',
    );
  });
});
