/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-4 — Memory domain-pack barrel.
//
// External callers (tools, services, turn phases, post-turn pipeline,
// turn-context builder, devtools, tests) MUST import memory symbols
// through this barrel rather than the individual leaves under
// `./npc/`, `./location/`, `./loop/`, `./clusters/`, `./maintenance/`,
// or `./kinds.js`. The boundary is enforced by
// `src/__tests__/architecture/memoryDomainPack.test.ts` plus a flat
// ESLint `no-restricted-imports` rule on `domain/memory/npc/**`.
// Tests under `src/__tests__/**` are exempt — they may target leaves
// when `vi.mock(...)` requires the exact module path.

export {MemoryService} from './MemoryService.js';

export {
  buildContinuityPacket,
  renderContinuityPacket,
  type ContinuityPacket,
} from './npc/continuityPacket.js';
export {
  ambientThreadId,
  attachMemoryToThread,
  ensureSessionMemoryThread,
  recordThreadEvidence,
  type SessionMemoryThread,
} from './npc/sessionThread.js';

export {
  LIVE_PLAYTEST_NPC_MEMORIES_KEY,
  SAVE_SLOT_NPC_MEMORIES_KEY,
  applyNpcVoiceEnrichment,
  bumpNpcMemorySalience,
  clampNpcMemorySalience,
  clearBrokenMemoryClusters,
  countAllNpcMemories,
  countNpcMemoriesByExactText,
  countNpcMemoriesByOwnersAndTags,
  countNpcMemoriesForOwnerAboutWithText,
  deleteAllNpcMemoriesForReset,
  deleteSaveSlotNpcMemoriesForPlayer,
  fillMemoryFamilyDefaults,
  fillMissingLastReferencedAt,
  insertAdventureIgnoreMemory,
  insertArchivalNpcMemory,
  insertLivePlaytestDebugMemory,
  insertNpcMemory,
  insertQuestRewardMemory,
  queryNpcMemories,
  readRollingDialogueSummaryCheckpoint,
  restoreSaveSlotNpcMemoryRows,
  selectActorMemoryFamilies,
  selectActorPromiseMemories,
  selectAdventureIgnoreMemoryId,
  selectAdventureMaterializerRelevantMemories,
  selectAppliedMaterializerMemoryId,
  selectBadSalienceMemoryIds,
  selectBrokenClusterMemoryIds,
  selectDebugNpcVoiceMemory,
  selectDialoguePrivateNotes,
  selectDialoguePublicHighlights,
  selectDialogueRollingSummary,
  selectDiagnosticsNpcMemoriesForDate,
  selectEntityCardNpcMemoryRows,
  selectInvalidMemoryCategoryIds,
  selectLivePlaytestDebugMemoryRows,
  selectMissingMemoryFamilyIds,
  selectNpcMemoryById,
  selectNpcMemoryResetCountRow,
  selectQuestActorMemoryIds,
  selectQuestTagMemoryIds,
  selectRecentFailureMemoryExists,
  selectRecentMemoriesAboutPlayer,
  selectRefWithoutTimestampMemoryIds,
  selectRelationshipMemories,
  selectSaveSlotNpcMemoryRows,
  selectVoicePastMemoryCandidates,
  upsertRollingDialogueSummary,
  type ActorMemoryFamilyRow,
  type ActorPromiseRow,
  type AdventureIgnoreMemoryInput,
  type AdventureMaterializerMemoryRow,
  type ArchivalNpcMemoryInput,
  type DebugNpcVoiceMemoryRow,
  type DialoguePrivateNoteRow,
  type DialoguePublicMemoryRow,
  type DialogueRollingSummaryRow,
  type DiagnosticsNpcMemoryRow,
  type EntityCardNpcMemoryRow,
  type LivePlaytestDebugMemoryInsert,
  type LivePlaytestDebugMemoryRow,
  type NpcMemoryBumpInput,
  type NpcMemoryBumpResult,
  type NpcMemoryInsertInput,
  type NpcMemoryQueryFilters,
  type NpcMemoryQueryRow,
  type NpcMemoryRowById,
  type NpcVoiceEnrichmentInput,
  type QuestRewardMemoryInput,
  type RecentMemoryAboutPlayerRow,
  type RelationshipMemoryRow,
  type ResetWorldCountRow,
  type RollingDialogueSummaryInput,
  type VoicePastMemoryQuery,
  type VoicePastMemoryRow,
} from './npc/memoryStore.js';

export {
  buildLocationMemoryPacket,
  loadIntroBubble,
  recordCurrentLocationVisit,
  recordLocationVisit,
  renderLocationMemoryPacket,
  type LocationMemoryPacket,
  type LocationMemoryRow,
  type LocationVisitRecord,
} from './location/locationMemory.js';

export {
  buildMemoryLoopPacket,
  renderMemoryLoopPacket,
  type MemoryLoopPacket,
} from './loop/packet.js';
export {memoryLoopWatcherHook} from './loop/watcher.js';

export {
  assignMemoryCluster,
  recomputeClusterSalience,
} from './clusters/clusters.js';

export {
  maybeRunMemoryMaintenance,
  runMemoryMaintenance,
  runMemoryMaintenanceFailOpen,
  type MemoryMaintenanceResult,
} from './maintenance/maintenance.js';

export {
  MEMORY_CATEGORIES,
  MEMORY_FAMILIES,
  behaviorHintForFamily,
  inferMemoryCategory,
  memoryFamilyForCategory,
  normalizeMemoryCategory,
  salienceBump,
  salienceDecay,
  type MemoryCategory,
  type MemoryFamily,
} from './kinds.js';
