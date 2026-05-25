/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 — turn-lifecycle doc freshness check.
//
// Asserts `docs/backend/turn-lifecycle.md` names every exported phase
// from `src/turn/phases/index.ts` and every exported phase-list. The
// goal is the same as the X-3/X-4 ESLint sweep: catch a phase being
// added, renamed, or removed without the lifecycle doc being updated.
// The check uses the live module exports rather than a hand-written
// inventory so renames cannot silently drift past it.

import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

import * as phasesModule from '../../turn/phases/index.js';

const DOC_URL = new URL(
  '../../../../../docs/backend/turn-lifecycle.md',
  import.meta.url,
);

const EXPECTED_PHASE_LISTS = [
  'preTurnPhases',
  'preRoutePhases',
  'routeResolutionPhases',
  'turnContextPreparationPhases',
  'playerMessagePersistencePhases',
  'turnDispatchPreparationPhases',
  'turnDispatchPhases',
] as const;

describe('docs/backend/turn-lifecycle.md freshness', () => {
  it('exists and is non-empty', async () => {
    const source = await readFile(DOC_URL, 'utf8');
    expect(source.length).toBeGreaterThan(0);
  });

  it('mentions every exported phase-list name from phases/index.ts', async () => {
    const source = await readFile(DOC_URL, 'utf8');
    for (const listName of EXPECTED_PHASE_LISTS) {
      expect(phasesModule, `phases/index.ts must export ${listName}`).toHaveProperty(
        listName,
      );
      expect(source, `turn-lifecycle.md must mention ${listName}`).toContain(
        listName,
      );
    }
  });

  it('mentions every exported phase by either export key or runtime name', async () => {
    const source = await readFile(DOC_URL, 'utf8');
    const phases = collectPhases(phasesModule);
    expect(phases.length).toBeGreaterThan(0);
    for (const phase of phases) {
      const mentioned =
        source.includes(phase.exportKey) || source.includes(phase.runtimeName);
      expect(
        mentioned,
        `turn-lifecycle.md must mention phase '${phase.exportKey}' or '${phase.runtimeName}'`,
      ).toBe(true);
    }
  });

  it('points at the canonical source files', async () => {
    const source = await readFile(DOC_URL, 'utf8');
    for (const reference of [
      'packages/web-server/src/turn/Phase.ts',
      'packages/web-server/src/turn/TurnContext.ts',
      'packages/web-server/src/turn/TurnLifecycle.ts',
      'packages/web-server/src/turn/phases/index.ts',
      'packages/web-server/src/turnRunnerV2.ts',
      'packages/web-server/src/turnBrokerStage.ts',
      'packages/web-server/src/postTurnPipeline.ts',
      'packages/web-server/src/specialists/registry.ts',
    ]) {
      expect(source, `turn-lifecycle.md must reference ${reference}`).toContain(
        reference,
      );
    }
  });
});

interface PhaseFingerprint {
  exportKey: string;
  runtimeName: string;
}

function collectPhases(
  mod: Record<string, unknown>,
): PhaseFingerprint[] {
  const seen = new Map<string, PhaseFingerprint>();
  for (const [exportKey, value] of Object.entries(mod)) {
    if (isPhaseObject(value)) {
      if (!seen.has(exportKey)) {
        seen.set(exportKey, {
          exportKey,
          runtimeName: value.name,
        });
      }
    }
  }
  return [...seen.values()];
}

function isPhaseObject(
  value: unknown,
): value is {name: string; run: (...args: unknown[]) => unknown} {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as {name?: unknown}).name === 'string' &&
    typeof (value as {run?: unknown}).run === 'function'
  );
}
