/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-4 — Memory domain-pack facade.
//
// Static service that wraps every memory subsystem the rest of the
// codebase needs. Tools (`tools/memory.ts`, `tools/worldMemory.ts`),
// the post-turn pipeline, the turn-context builder, route services,
// devtools, and tests all consume `MemoryService` (or the
// re-exports in `./index.ts`) rather than reaching into the
// `npc/` / `location/` / `loop/` / `clusters/` / `maintenance/`
// subfolders directly.
//
// The fixspec calls for static methods, not interface + impl —
// keeping a singleton class with namespace-style grouping matches
// the `ARCH-18` static-method convention used elsewhere.

import {
  buildContinuityPacket,
  renderContinuityPacket,
  type ContinuityPacket,
} from './npc/continuityPacket.js';
import {
  ambientThreadId,
  attachMemoryToThread,
  ensureSessionMemoryThread,
  recordThreadEvidence,
  type SessionMemoryThread,
} from './npc/sessionThread.js';
import {
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
import {
  buildLocationMemoryPacket,
  loadIntroBubble,
  recordCurrentLocationVisit,
  recordLocationVisit,
  renderLocationMemoryPacket,
  type LocationMemoryPacket,
  type LocationMemoryRow,
  type LocationVisitRecord,
} from './location/locationMemory.js';
import {
  buildMemoryLoopPacket,
  renderMemoryLoopPacket,
  type MemoryLoopPacket,
} from './loop/packet.js';
import {memoryLoopWatcherHook} from './loop/watcher.js';
import {
  assignMemoryCluster,
  recomputeClusterSalience,
} from './clusters/clusters.js';
import {
  maybeRunMemoryMaintenance,
  runMemoryMaintenance,
  runMemoryMaintenanceFailOpen,
  type MemoryMaintenanceResult,
} from './maintenance/maintenance.js';
import {
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

export class MemoryService {
  // ── NPC memory (npc_memories) ──────────────────────────────────
  static buildContinuityPacket = buildContinuityPacket;
  static renderContinuityPacket = renderContinuityPacket;
  static ambientThreadId = ambientThreadId;
  static ensureSessionMemoryThread = ensureSessionMemoryThread;
  static attachMemoryToThread = attachMemoryToThread;
  static recordThreadEvidence = recordThreadEvidence;
  static insertNpcMemory = insertNpcMemory;
  static insertArchivalNpcMemory = insertArchivalNpcMemory;
  static bumpNpcMemorySalience = bumpNpcMemorySalience;
  static queryNpcMemories = queryNpcMemories;
  static upsertRollingDialogueSummary = upsertRollingDialogueSummary;
  static readRollingDialogueSummaryCheckpoint =
    readRollingDialogueSummaryCheckpoint;
  static selectNpcMemoryById = selectNpcMemoryById;
  static selectActorMemoryFamilies = selectActorMemoryFamilies;
  static selectActorPromiseMemories = selectActorPromiseMemories;
  static selectDialoguePublicHighlights = selectDialoguePublicHighlights;
  static selectDialogueRollingSummary = selectDialogueRollingSummary;
  static selectDialoguePrivateNotes = selectDialoguePrivateNotes;
  static selectVoicePastMemoryCandidates = selectVoicePastMemoryCandidates;
  static applyNpcVoiceEnrichment = applyNpcVoiceEnrichment;
  static selectRelationshipMemories = selectRelationshipMemories;
  static selectRecentMemoriesAboutPlayer = selectRecentMemoriesAboutPlayer;
  static insertQuestRewardMemory = insertQuestRewardMemory;
  static selectQuestActorMemoryIds = selectQuestActorMemoryIds;
  static selectQuestTagMemoryIds = selectQuestTagMemoryIds;
  static selectRecentFailureMemoryExists = selectRecentFailureMemoryExists;
  static selectAdventureIgnoreMemoryId = selectAdventureIgnoreMemoryId;
  static insertAdventureIgnoreMemory = insertAdventureIgnoreMemory;
  static selectAdventureMaterializerRelevantMemories =
    selectAdventureMaterializerRelevantMemories;
  static selectAppliedMaterializerMemoryId = selectAppliedMaterializerMemoryId;
  static deleteAllNpcMemoriesForReset = deleteAllNpcMemoriesForReset;
  static selectNpcMemoryResetCountRow = selectNpcMemoryResetCountRow;
  static selectSaveSlotNpcMemoryRows = selectSaveSlotNpcMemoryRows;
  static deleteSaveSlotNpcMemoriesForPlayer =
    deleteSaveSlotNpcMemoriesForPlayer;
  static restoreSaveSlotNpcMemoryRows = restoreSaveSlotNpcMemoryRows;
  static selectDebugNpcVoiceMemory = selectDebugNpcVoiceMemory;
  static selectDiagnosticsNpcMemoriesForDate =
    selectDiagnosticsNpcMemoriesForDate;
  static SAVE_SLOT_NPC_MEMORIES_KEY = SAVE_SLOT_NPC_MEMORIES_KEY;
  static LIVE_PLAYTEST_NPC_MEMORIES_KEY = LIVE_PLAYTEST_NPC_MEMORIES_KEY;
  static countAllNpcMemories = countAllNpcMemories;
  static countNpcMemoriesByExactText = countNpcMemoriesByExactText;
  static countNpcMemoriesForOwnerAboutWithText =
    countNpcMemoriesForOwnerAboutWithText;
  static countNpcMemoriesByOwnersAndTags = countNpcMemoriesByOwnersAndTags;
  static insertLivePlaytestDebugMemory = insertLivePlaytestDebugMemory;
  static selectLivePlaytestDebugMemoryRows = selectLivePlaytestDebugMemoryRows;
  static selectInvalidMemoryCategoryIds = selectInvalidMemoryCategoryIds;
  static selectMissingMemoryFamilyIds = selectMissingMemoryFamilyIds;
  static selectBadSalienceMemoryIds = selectBadSalienceMemoryIds;
  static selectBrokenClusterMemoryIds = selectBrokenClusterMemoryIds;
  static selectRefWithoutTimestampMemoryIds =
    selectRefWithoutTimestampMemoryIds;
  static fillMemoryFamilyDefaults = fillMemoryFamilyDefaults;
  static clampNpcMemorySalience = clampNpcMemorySalience;
  static clearBrokenMemoryClusters = clearBrokenMemoryClusters;
  static fillMissingLastReferencedAt = fillMissingLastReferencedAt;
  static selectEntityCardNpcMemoryRows = selectEntityCardNpcMemoryRows;

  // ── Location memory ────────────────────────────────────────────
  static recordCurrentLocationVisit = recordCurrentLocationVisit;
  static recordLocationVisit = recordLocationVisit;
  static buildLocationMemoryPacket = buildLocationMemoryPacket;
  static renderLocationMemoryPacket = renderLocationMemoryPacket;
  static loadIntroBubble = loadIntroBubble;

  // ── Loop detection / watcher ───────────────────────────────────
  static buildMemoryLoopPacket = buildMemoryLoopPacket;
  static renderMemoryLoopPacket = renderMemoryLoopPacket;
  static memoryLoopWatcherHook = memoryLoopWatcherHook;

  // ── Clustering ─────────────────────────────────────────────────
  static assignMemoryCluster = assignMemoryCluster;
  static recomputeClusterSalience = recomputeClusterSalience;

  // ── Maintenance ────────────────────────────────────────────────
  static maybeRunMemoryMaintenance = maybeRunMemoryMaintenance;
  static runMemoryMaintenance = runMemoryMaintenance;
  static runMemoryMaintenanceFailOpen = runMemoryMaintenanceFailOpen;

  // ── Categories / kinds ─────────────────────────────────────────
  static MEMORY_CATEGORIES = MEMORY_CATEGORIES;
  static MEMORY_FAMILIES = MEMORY_FAMILIES;
  static memoryFamilyForCategory = memoryFamilyForCategory;
  static normalizeMemoryCategory = normalizeMemoryCategory;
  static inferMemoryCategory = inferMemoryCategory;
  static behaviorHintForFamily = behaviorHintForFamily;
  static salienceBump = salienceBump;
  static salienceDecay = salienceDecay;
}

export type {
  ContinuityPacket,
  SessionMemoryThread,
  LocationVisitRecord,
  LocationMemoryPacket,
  LocationMemoryRow,
  MemoryLoopPacket,
  MemoryMaintenanceResult,
  MemoryCategory,
  MemoryFamily,
  NpcMemoryInsertInput,
  NpcMemoryBumpInput,
  NpcMemoryBumpResult,
  NpcMemoryQueryFilters,
  NpcMemoryQueryRow,
  ArchivalNpcMemoryInput,
  RollingDialogueSummaryInput,
  ActorMemoryFamilyRow,
  ActorPromiseRow,
  DialoguePublicMemoryRow,
  DialogueRollingSummaryRow,
  DialoguePrivateNoteRow,
  NpcMemoryRowById,
  NpcVoiceEnrichmentInput,
  VoicePastMemoryQuery,
  VoicePastMemoryRow,
  QuestRewardMemoryInput,
  RecentMemoryAboutPlayerRow,
  RelationshipMemoryRow,
  AdventureIgnoreMemoryInput,
  AdventureMaterializerMemoryRow,
  DebugNpcVoiceMemoryRow,
  DiagnosticsNpcMemoryRow,
  ResetWorldCountRow,
  EntityCardNpcMemoryRow,
  LivePlaytestDebugMemoryInsert,
  LivePlaytestDebugMemoryRow,
};
