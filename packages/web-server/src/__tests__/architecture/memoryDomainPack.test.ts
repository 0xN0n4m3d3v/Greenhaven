/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-4 — memory domain-pack boundary check.
//
// Invariants the static check enforces:
//   1. The legacy `src/memory/` folder is gone.
//   2. The legacy `src/world/locationMemory.ts` is gone (the rest of
//      `src/world/` may stay; only the location-memory module moved).
//   3. The legacy `src/agents/memoryLoopWatcher.ts` is gone.
//   4. No production source file outside `src/domain/memory/**`
//      imports `memory/*`, `world/locationMemory.js`,
//      `agents/memoryLoopWatcher.js`, or any leaf under
//      `domain/memory/{npc,location,loop,clusters,maintenance}/**`.
//      Production callers must route through
//      `domain/memory/index.ts` (or the `MemoryService` static class
//      it exposes). Tests under `__tests__/**` are exempt — `vi.mock`
//      targets the leaves directly.
//   5. The new `domain/memory/index.ts` facade exists and exports
//      the documented public surface (continuity packet, session
//      thread, location memory, loop packet, watcher, clustering,
//      maintenance, categories, `MemoryService`).
//
// The scan walks `src/` recursively and skips this test file plus
// `node_modules/` and `dist/`. The check is intentionally textual:
// regex-driven import-string matching catches a stray re-introduction
// of any legacy import path the moment an editor saves it.

import {readdirSync, readFileSync, statSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, relative, sep} from 'node:path';
import {describe, expect, it} from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LEGACY_MEMORY_DIR = join(ROOT, 'memory');
const LEGACY_LOCATION_MEMORY = join(ROOT, 'world', 'locationMemory.ts');
const LEGACY_MEMORY_LOOP_WATCHER = join(ROOT, 'agents', 'memoryLoopWatcher.ts');
const DOMAIN_FACADE_DIR = join(ROOT, 'domain', 'memory');
const SELF = fileURLToPath(import.meta.url);

const FORBIDDEN_IMPORTS: Array<{label: string; re: RegExp}> = [
  {
    label: 'legacy memory/* (use domain/memory facade)',
    re: /from\s+['"][^'"]*\/memory\/(?:continuityPacket|memoryCategories|memoryClusters|memoryLoopPacket|memoryMaintenance|sessionMemoryThread)\.js['"]/,
  },
  {
    label: 'legacy world/locationMemory (use domain/memory facade)',
    re: /from\s+['"][^'"]*world\/locationMemory\.js['"]/,
  },
  {
    label: 'legacy agents/memoryLoopWatcher (use domain/memory facade)',
    re: /from\s+['"][^'"]*agents\/memoryLoopWatcher\.js['"]/,
  },
  {
    label:
      'domain/memory/{npc,location,loop,clusters,maintenance}/* (use the facade instead)',
    re: /from\s+['"][^'"]*domain\/memory\/(?:npc|location|loop|clusters|maintenance)\/[a-zA-Z]+\.js['"]/,
  },
  {
    label: 'domain/memory/kinds.js (use the facade instead)',
    re: /from\s+['"][^'"]*domain\/memory\/kinds\.js['"]/,
  },
  {
    label: 'domain/memory/MemoryService (use the facade instead)',
    re: /from\s+['"][^'"]*domain\/memory\/MemoryService\.js['"]/,
  },
];

// ARCH-4 criterion (b) — `npc_memories` SQL ownership.
//
// Direct references to the `npc_memories` table must be owned by
// `domain/memory/**`. The previous slice mechanical-moved the
// memory cluster; this slice (broker-tool SQL) extracts the
// `tools/memory.ts` and `tools/worldMemory.ts` INSERT/SELECT/UPDATE
// statements into `domain/memory/npc/memoryStore.ts`. The `npc_memories`
// references remaining outside `domain/memory/**` are tracked as an
// explicit allowlist below; future slices shrink the list and the
// test fails immediately if a new caller introduces raw SQL.
//
// Files in the allowlist are expected to still touch `npc_memories`
// directly until their own ownership slice lands. New direct callers
// MUST NOT be added — the test enforces an exact match. Once a file
// is migrated, remove it from the list and the test will fail if it
// regresses.
// ARCH-4 closed 2026-05-16: every direct `npc_memories` SQL reference
// outside `domain/memory/**` has been migrated to typed helpers. The
// allowlist is intentionally empty; any new non-test, non-domain
// caller is a regression and fails the "match exactly" check below.
const NPC_MEMORIES_SQL_ALLOWLIST = new Set<string>([
  'scripts/hero-continuity-smoke.ts',
  'scripts/obsidian-dev-apply.ts',
  'services/HeroContinuityCarryoverService.ts',
  'services/HeroContinuityLedgerService.ts',
  'services/HeroContinuityService.ts',
  'tools/companionRule.ts',
  'tools/relationshipTrigger.ts',
  'turnContext/worldLocationContext.ts',
]);

describe('ARCH-4 — memory domain-pack boundary', () => {
  it('removes the legacy src/memory/ folder', () => {
    expect(
      existsSync(LEGACY_MEMORY_DIR),
      'src/memory/ must no longer exist; memory lives under src/domain/memory/',
    ).toBe(false);
  });

  it('removes the legacy src/world/locationMemory.ts', () => {
    expect(
      existsSync(LEGACY_LOCATION_MEMORY),
      'src/world/locationMemory.ts moved to src/domain/memory/location/locationMemory.ts',
    ).toBe(false);
  });

  it('removes the legacy src/agents/memoryLoopWatcher.ts', () => {
    expect(
      existsSync(LEGACY_MEMORY_LOOP_WATCHER),
      'src/agents/memoryLoopWatcher.ts moved to src/domain/memory/loop/watcher.ts',
    ).toBe(false);
  });

  it('no production source outside domain/memory imports legacy or internal memory paths', () => {
    const offenders: Array<{file: string; line: string; label: string}> = [];
    for (const file of walkTsFiles(ROOT)) {
      if (file === SELF) continue;
      if (isInsideDomainMemory(file)) continue;
      if (isTestFile(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const {label, re} of FORBIDDEN_IMPORTS) {
        const globalRe = new RegExp(re.source, 'g');
        const matches = text.match(globalRe);
        if (!matches) continue;
        for (const m of matches) {
          offenders.push({file: relative(ROOT, file), line: m, label});
        }
      }
    }
    expect(
      offenders,
      `Files importing forbidden memory paths:\n  ${offenders
        .map(o => `${o.file}: ${o.line} [${o.label}]`)
        .join('\n  ')}`,
    ).toEqual([]);
  });

  it('broker tools no longer reach into `npc_memories` directly', () => {
    const memoryTool = readFileSync(
      join(ROOT, 'tools', 'memory.ts'),
      'utf8',
    );
    const worldMemoryTool = readFileSync(
      join(ROOT, 'tools', 'worldMemory.ts'),
      'utf8',
    );
    expect(
      memoryTool.includes('npc_memories'),
      'tools/memory.ts must consume MemoryService helpers, not raw npc_memories SQL',
    ).toBe(false);
    expect(
      worldMemoryTool.includes('npc_memories'),
      'tools/worldMemory.ts must consume MemoryService helpers, not raw npc_memories SQL',
    ).toBe(false);
  });

  it('non-test files outside domain/memory match the npc_memories allowlist exactly', () => {
    const offenders: string[] = [];
    const stillReferenced: string[] = [];
    for (const file of walkTsFiles(ROOT)) {
      if (file === SELF) continue;
      if (isInsideDomainMemory(file)) continue;
      if (isTestFile(file)) continue;
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      const text = readFileSync(file, 'utf8');
      if (!text.includes('npc_memories')) continue;
      stillReferenced.push(rel);
      if (!NPC_MEMORIES_SQL_ALLOWLIST.has(rel)) {
        offenders.push(rel);
      }
    }
    // Stale allowlist entries (file migrated but still listed) — also
    // fail so the list shrinks naturally as ownership slices land.
    const stale: string[] = [];
    for (const entry of NPC_MEMORIES_SQL_ALLOWLIST) {
      if (!stillReferenced.includes(entry)) stale.push(entry);
    }
    expect(
      {newCallers: offenders, staleAllowlistEntries: stale},
      `npc_memories direct-SQL allowlist drift:\n  new callers: ${offenders.join(', ') || '(none)'}\n  stale entries: ${stale.join(', ') || '(none)'}`,
    ).toEqual({newCallers: [], staleAllowlistEntries: []});
  });

  it('domain/memory facade exports the documented public surface', async () => {
    expect(existsSync(join(DOMAIN_FACADE_DIR, 'index.ts'))).toBe(true);
    const mod = await import('../../domain/memory/index.js');
    // NPC memory.
    expect(typeof mod.buildContinuityPacket).toBe('function');
    expect(typeof mod.renderContinuityPacket).toBe('function');
    expect(typeof mod.ambientThreadId).toBe('function');
    expect(typeof mod.attachMemoryToThread).toBe('function');
    expect(typeof mod.ensureSessionMemoryThread).toBe('function');
    expect(typeof mod.recordThreadEvidence).toBe('function');
    // Location memory.
    expect(typeof mod.buildLocationMemoryPacket).toBe('function');
    expect(typeof mod.renderLocationMemoryPacket).toBe('function');
    expect(typeof mod.recordCurrentLocationVisit).toBe('function');
    expect(typeof mod.recordLocationVisit).toBe('function');
    expect(typeof mod.loadIntroBubble).toBe('function');
    // Loop subsystem.
    expect(typeof mod.buildMemoryLoopPacket).toBe('function');
    expect(typeof mod.renderMemoryLoopPacket).toBe('function');
    expect(typeof mod.memoryLoopWatcherHook).toBe('object');
    expect(mod.memoryLoopWatcherHook.name).toBe('memory_loop_watcher');
    // Clusters.
    expect(typeof mod.assignMemoryCluster).toBe('function');
    expect(typeof mod.recomputeClusterSalience).toBe('function');
    // Maintenance.
    expect(typeof mod.runMemoryMaintenance).toBe('function');
    expect(typeof mod.runMemoryMaintenanceFailOpen).toBe('function');
    expect(typeof mod.maybeRunMemoryMaintenance).toBe('function');
    // Categories / kinds.
    expect(Array.isArray(mod.MEMORY_CATEGORIES)).toBe(true);
    expect(Array.isArray(mod.MEMORY_FAMILIES)).toBe(true);
    expect(typeof mod.behaviorHintForFamily).toBe('function');
    expect(typeof mod.inferMemoryCategory).toBe('function');
    expect(typeof mod.memoryFamilyForCategory).toBe('function');
    expect(typeof mod.normalizeMemoryCategory).toBe('function');
    expect(typeof mod.salienceBump).toBe('function');
    expect(typeof mod.salienceDecay).toBe('function');
    // Broker-tool memory store (ARCH-4 criterion (b)).
    expect(typeof mod.insertNpcMemory).toBe('function');
    expect(typeof mod.insertArchivalNpcMemory).toBe('function');
    expect(typeof mod.bumpNpcMemorySalience).toBe('function');
    expect(typeof mod.queryNpcMemories).toBe('function');
    expect(typeof mod.upsertRollingDialogueSummary).toBe('function');
    expect(typeof mod.readRollingDialogueSummaryCheckpoint).toBe('function');
    // Active-NPC grounding + voice enrichment helpers
    // (ARCH-4 active-NPC slice).
    expect(typeof mod.selectNpcMemoryById).toBe('function');
    expect(typeof mod.selectActorMemoryFamilies).toBe('function');
    expect(typeof mod.selectActorPromiseMemories).toBe('function');
    expect(typeof mod.selectDialoguePublicHighlights).toBe('function');
    expect(typeof mod.selectDialogueRollingSummary).toBe('function');
    expect(typeof mod.selectDialoguePrivateNotes).toBe('function');
    expect(typeof mod.selectVoicePastMemoryCandidates).toBe('function');
    expect(typeof mod.applyNpcVoiceEnrichment).toBe('function');
    // Quest / world-sensing helpers (ARCH-4 quest slice).
    expect(typeof mod.selectRelationshipMemories).toBe('function');
    expect(typeof mod.selectRecentMemoriesAboutPlayer).toBe('function');
    expect(typeof mod.insertQuestRewardMemory).toBe('function');
    expect(typeof mod.selectQuestActorMemoryIds).toBe('function');
    expect(typeof mod.selectQuestTagMemoryIds).toBe('function');
    expect(typeof mod.selectRecentFailureMemoryExists).toBe('function');
    // Adventure-pack helpers (ARCH-4 adventure slice).
    expect(typeof mod.selectAdventureIgnoreMemoryId).toBe('function');
    expect(typeof mod.insertAdventureIgnoreMemory).toBe('function');
    expect(typeof mod.selectAdventureMaterializerRelevantMemories).toBe(
      'function',
    );
    // Reset / debug / save helpers (ARCH-4 reset/debug/save slice).
    expect(typeof mod.deleteAllNpcMemoriesForReset).toBe('function');
    expect(typeof mod.selectNpcMemoryResetCountRow).toBe('function');
    expect(typeof mod.selectSaveSlotNpcMemoryRows).toBe('function');
    expect(typeof mod.deleteSaveSlotNpcMemoriesForPlayer).toBe('function');
    expect(typeof mod.restoreSaveSlotNpcMemoryRows).toBe('function');
    expect(typeof mod.selectDebugNpcVoiceMemory).toBe('function');
    expect(typeof mod.selectDiagnosticsNpcMemoriesForDate).toBe('function');
    expect(mod.SAVE_SLOT_NPC_MEMORIES_KEY).toBe('npc_memories');
    // Devtool / script helpers (ARCH-4 close-out slice).
    expect(typeof mod.countAllNpcMemories).toBe('function');
    expect(typeof mod.countNpcMemoriesByExactText).toBe('function');
    expect(typeof mod.countNpcMemoriesForOwnerAboutWithText).toBe('function');
    expect(typeof mod.countNpcMemoriesByOwnersAndTags).toBe('function');
    expect(typeof mod.insertLivePlaytestDebugMemory).toBe('function');
    expect(typeof mod.selectLivePlaytestDebugMemoryRows).toBe('function');
    expect(typeof mod.selectInvalidMemoryCategoryIds).toBe('function');
    expect(typeof mod.selectMissingMemoryFamilyIds).toBe('function');
    expect(typeof mod.selectBadSalienceMemoryIds).toBe('function');
    expect(typeof mod.selectBrokenClusterMemoryIds).toBe('function');
    expect(typeof mod.selectRefWithoutTimestampMemoryIds).toBe('function');
    expect(typeof mod.fillMemoryFamilyDefaults).toBe('function');
    expect(typeof mod.clampNpcMemorySalience).toBe('function');
    expect(typeof mod.clearBrokenMemoryClusters).toBe('function');
    expect(typeof mod.fillMissingLastReferencedAt).toBe('function');
    expect(typeof mod.selectEntityCardNpcMemoryRows).toBe('function');
    expect(mod.LIVE_PLAYTEST_NPC_MEMORIES_KEY).toBe('npc_memories');
    // MemoryService static facade.
    expect(typeof mod.MemoryService).toBe('function');
    expect(typeof mod.MemoryService.assignMemoryCluster).toBe('function');
    expect(typeof mod.MemoryService.runMemoryMaintenanceFailOpen).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.buildContinuityPacket).toBe('function');
    expect(typeof mod.MemoryService.insertNpcMemory).toBe('function');
    expect(typeof mod.MemoryService.insertArchivalNpcMemory).toBe('function');
    expect(typeof mod.MemoryService.bumpNpcMemorySalience).toBe('function');
    expect(typeof mod.MemoryService.queryNpcMemories).toBe('function');
    expect(typeof mod.MemoryService.upsertRollingDialogueSummary).toBe('function');
    expect(typeof mod.MemoryService.readRollingDialogueSummaryCheckpoint).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectNpcMemoryById).toBe('function');
    expect(typeof mod.MemoryService.selectActorMemoryFamilies).toBe('function');
    expect(typeof mod.MemoryService.selectActorPromiseMemories).toBe('function');
    expect(typeof mod.MemoryService.selectDialoguePublicHighlights).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectDialogueRollingSummary).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectDialoguePrivateNotes).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectVoicePastMemoryCandidates).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.applyNpcVoiceEnrichment).toBe('function');
    expect(typeof mod.MemoryService.selectRelationshipMemories).toBe('function');
    expect(typeof mod.MemoryService.selectRecentMemoriesAboutPlayer).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.insertQuestRewardMemory).toBe('function');
    expect(typeof mod.MemoryService.selectQuestActorMemoryIds).toBe('function');
    expect(typeof mod.MemoryService.selectQuestTagMemoryIds).toBe('function');
    expect(typeof mod.MemoryService.selectRecentFailureMemoryExists).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectAdventureIgnoreMemoryId).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.insertAdventureIgnoreMemory).toBe(
      'function',
    );
    expect(
      typeof mod.MemoryService.selectAdventureMaterializerRelevantMemories,
    ).toBe('function');
    expect(typeof mod.MemoryService.deleteAllNpcMemoriesForReset).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectNpcMemoryResetCountRow).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectSaveSlotNpcMemoryRows).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.deleteSaveSlotNpcMemoriesForPlayer).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.restoreSaveSlotNpcMemoryRows).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectDebugNpcVoiceMemory).toBe(
      'function',
    );
    expect(
      typeof mod.MemoryService.selectDiagnosticsNpcMemoriesForDate,
    ).toBe('function');
    expect(mod.MemoryService.SAVE_SLOT_NPC_MEMORIES_KEY).toBe('npc_memories');
    expect(typeof mod.MemoryService.countAllNpcMemories).toBe('function');
    expect(typeof mod.MemoryService.countNpcMemoriesByExactText).toBe(
      'function',
    );
    expect(
      typeof mod.MemoryService.countNpcMemoriesForOwnerAboutWithText,
    ).toBe('function');
    expect(typeof mod.MemoryService.countNpcMemoriesByOwnersAndTags).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.insertLivePlaytestDebugMemory).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectLivePlaytestDebugMemoryRows).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectInvalidMemoryCategoryIds).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectMissingMemoryFamilyIds).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectBadSalienceMemoryIds).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectBrokenClusterMemoryIds).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectRefWithoutTimestampMemoryIds).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.fillMemoryFamilyDefaults).toBe('function');
    expect(typeof mod.MemoryService.clampNpcMemorySalience).toBe('function');
    expect(typeof mod.MemoryService.clearBrokenMemoryClusters).toBe('function');
    expect(typeof mod.MemoryService.fillMissingLastReferencedAt).toBe(
      'function',
    );
    expect(typeof mod.MemoryService.selectEntityCardNpcMemoryRows).toBe(
      'function',
    );
    expect(mod.MemoryService.LIVE_PLAYTEST_NPC_MEMORIES_KEY).toBe(
      'npc_memories',
    );
  });
});

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTsFiles(full);
      continue;
    }
    if (!st.isFile()) continue;
    if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      yield full;
    }
  }
}

function isInsideDomainMemory(file: string): boolean {
  const prefix = join(ROOT, 'domain', 'memory') + sep;
  return file.startsWith(prefix);
}

function isTestFile(file: string): boolean {
  return file.includes(`${sep}__tests__${sep}`);
}
