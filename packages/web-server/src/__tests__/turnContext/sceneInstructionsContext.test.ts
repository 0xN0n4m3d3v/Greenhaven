/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `renderSceneInstructions` preamble renderer contract.
//
// Pins the static-context renderer: empty input → empty string;
// populated input → `## SCENE INSTRUCTIONS` header with one bullet
// per row, deterministic ordering preserved from the service,
// trimmed long fields, and the soft `limit` cap honoured.
//
// The bridge service is mocked at module scope so the renderer can
// be exercised in isolation without a PGlite fixture.

import {beforeEach, describe, expect, it, vi} from 'vitest';

type SceneInstructionEntry =
  import('../../services/SceneInstructionBridgeService.js').SceneInstructionEntry;
type RelevantQuery =
  import('../../services/SceneInstructionBridgeService.js').RelevantSceneQuery;

const bridgeState = vi.hoisted(() => ({
  rows: [] as SceneInstructionEntry[],
  lastQuery: undefined as RelevantQuery | undefined,
}));

vi.mock('../../services/SceneInstructionBridgeService.js', () => ({
  listRelevantSceneInstructions: vi.fn(async (q: RelevantQuery) => {
    bridgeState.lastQuery = q;
    const limit = Math.max(0, q.limit ?? 6);
    return bridgeState.rows.slice(0, limit);
  }),
  listSceneInstructionEntries: vi.fn(async () => bridgeState.rows),
  isSceneInstructionBridgeAvailable: vi.fn(async () => bridgeState.rows.length > 0),
  clearSceneInstructionBridgeCache: vi.fn(),
}));

beforeEach(() => {
  bridgeState.rows = [];
  bridgeState.lastQuery = undefined;
});

function row(overrides: Partial<SceneInstructionEntry>): SceneInstructionEntry {
  return {
    sceneSlug: 'demo-scene',
    sceneMention: '@Demo scene',
    sourceKind: 'scene',
    sourcePath: 'demo.md',
    locationSlug: null,
    locationEntityId: null,
    ownerNpcSlug: null,
    ownerNpcEntityId: null,
    participantSlugs: [],
    participantEntityIds: [],
    trigger: '',
    priority: 'normal',
    hook: '',
    beatByBeat: '',
    playerChoices: '',
    memoryAndStringChanges: '',
    successResult: '',
    failureResult: '',
    behavior: '',
    doNot: '',
    voice: '',
    modelInstructions: [],
    stateFields: [],
    mediaScript: [],
    visualAsset: null,
    ...overrides,
  };
}

describe('renderSceneInstructions (OWV-17)', () => {
  it('returns an empty string when no rows are relevant', async () => {
    const mod = await import('../../turnContext/sceneInstructions.js');
    const out = await mod.renderSceneInstructions({
      locationId: 42,
      focusedNpcId: null,
      participantIds: [],
    });
    expect(out).toBe('');
  });

  it('renders a SCENE INSTRUCTIONS block with one bullet per row', async () => {
    bridgeState.rows = [
      row({
        sceneSlug: 'first-descent',
        sceneMention: '@First descent',
        locationSlug: 'thiefs-market',
        locationEntityId: 100,
        participantSlugs: ['sable-vey'],
        participantEntityIds: [200],
        priority: 'high',
        trigger: 'Player enters market via the hatch.',
        behavior: 'Market reacts to a stranger.',
        doNot: 'Do not let the market read like a shop on first entry.',
        modelInstructions: ['Make rules visible.', 'Watch for trouble.'],
      }),
      row({
        sceneSlug: 'mikka-combat',
        sceneMention: '@Mikka combat',
        locationSlug: 'town-square',
        locationEntityId: 101,
        ownerNpcSlug: 'mikka',
        ownerNpcEntityId: 300,
        priority: 'normal',
        behavior: 'Throwing knives first.',
        voice: '"Closer was not the right call."',
      }),
    ];
    const mod = await import('../../turnContext/sceneInstructions.js');
    const out = await mod.renderSceneInstructions({
      locationId: 100,
      focusedNpcId: 300,
      participantIds: [],
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('## SCENE INSTRUCTIONS');
    expect(out).toContain('@First descent (first-descent)');
    expect(out).toContain('priority: high');
    expect(out).toContain('location thiefs-market (#100)');
    expect(out).toContain('participants: sable-vey');
    expect(out).toContain('trigger: Player enters market via the hatch.');
    expect(out).toContain('do_not: Do not let the market read like a shop');
    expect(out).toContain('model: Make rules visible. | Watch for trouble.');
    expect(out).toContain('@Mikka combat (mikka-combat)');
    expect(out).toContain('owner mikka (#300)');
    expect(out).toContain('voice: "Closer was not the right call."');
  });

  it('forwards location/owner/participant ids and respects the limit cap', async () => {
    bridgeState.rows = [
      row({sceneSlug: 'a'}),
      row({sceneSlug: 'b'}),
      row({sceneSlug: 'c'}),
    ];
    const mod = await import('../../turnContext/sceneInstructions.js');
    const out = await mod.renderSceneInstructions({
      locationId: 7,
      focusedNpcId: 9,
      participantIds: [11, 12],
      limit: 2,
    });
    expect(bridgeState.lastQuery).toMatchObject({
      locationId: 7,
      focusedNpcId: 9,
      participantIds: [11, 12],
      limit: 2,
    });
    // Two scene bullets means three top-level dashes (header + 2 bullets).
    expect(out.match(/^- /gm)?.length).toBe(2);
  });

  it('OWV-9 — renders a companion-owned do_not constraint into the preamble', async () => {
    // Mirrors the live Mikka violence-starts scene: the writer
    // authored "не делать @Mikka успокаивать героя как generic
    // companion" so the broker must see a `do_not:` line carrying the
    // `generic companion` token in the static preamble. The runtime
    // promise is that the renderer surfaces this constraint verbatim
    // (modulo the field-cap trim) so the companion-prompt override
    // block has something concrete to defer to.
    bridgeState.rows = [
      row({
        sceneSlug: 'mikka-violence-starts',
        sceneMention: '@Mikka violence starts',
        locationSlug: 'town-square',
        locationEntityId: 101,
        ownerNpcSlug: 'mikka',
        ownerNpcEntityId: 300,
        participantSlugs: ['mikka'],
        participantEntityIds: [300],
        priority: 'high',
        behavior: 'Mikka uchodit iz linii udara.',
        doNot: 'Ne zastavljat’ @Mikka uspokaivat’ geroja kak generic companion.',
        voice: '"Vniz."',
      }),
    ];
    const mod = await import('../../turnContext/sceneInstructions.js');
    const out = await mod.renderSceneInstructions({
      locationId: 101,
      focusedNpcId: 300,
      participantIds: [300],
    });
    expect(out).toContain('## SCENE INSTRUCTIONS');
    expect(out).toContain('@Mikka violence starts (mikka-violence-starts)');
    expect(out).toContain('priority: high');
    expect(out).toContain('do_not:');
    expect(out).toContain('generic companion');
  });

  it('trims long fields to the configured cap and skips empty fields', async () => {
    const long = 'a'.repeat(500);
    bridgeState.rows = [row({sceneSlug: 'long', behavior: long, trigger: ''})];
    const mod = await import('../../turnContext/sceneInstructions.js');
    const out = await mod.renderSceneInstructions({
      locationId: null,
      focusedNpcId: 1,
      participantIds: [],
      fieldCharCap: 80,
    });
    expect(out).not.toContain('trigger:');
    expect(out).toMatch(/behavior: a{1,80}…/);
  });
});
