import {z} from 'zod';
import {
  ADVENTURE_BLUEPRINT_SCHEMA_VERSION,
} from '../runtime/adventureBlueprint.js';
import type {AdventureKind} from '../runtime/adventureTables.js';
import {SituationBlueprintSchema} from '../runtime/situationBlueprint.js';

export interface AdventureMaterializerInput {
  schemaVersion: typeof ADVENTURE_BLUEPRINT_SCHEMA_VERSION;
  language: string;
  queue: {
    id: number;
    adventureKind: AdventureKind;
    source: string;
    tableId: string;
    seed: string;
    sequence: number;
    rollResult: Record<string, unknown>;
    contextSnapshot: Record<string, unknown>;
  };
  player: {
    id: number;
    name: string;
    level: number;
    currentLocationId: number | null;
    currentLocationName: string | null;
  };
  locationContext: {
    id: number;
    kind: string;
    displayName: string;
    summary: string | null;
    ownerEntityId: number | null;
    topologyParentId: number | null;
    accessPolicy: string | null;
    accessReason: string | null;
    hiddenUntilStage: string | null;
    exits: Array<{
      id: number;
      kind: string;
      displayName: string;
      summary: string | null;
      ownerEntityId: number | null;
      topologyParentId: number | null;
      accessPolicy: string | null;
      accessReason: string | null;
      hiddenUntilStage: string | null;
    }>;
  } | null;
  activeQuests: Array<{
    id: number;
    title: string;
    summary: string | null;
    currentStageId: string | null;
    tags: string[];
    stages: Array<{id: string; title: string; next_stage?: string}>;
  }>;
  nearby: Array<{
    id: number;
    kind: string;
    displayName: string;
    summary: string | null;
    locationId: number | null;
    powerCenterId: number | null;
    homeId: number | null;
    ownerEntityId: number | null;
    topologyParentId: number | null;
    accessPolicy: string | null;
    accessReason: string | null;
    hiddenUntilStage: string | null;
    reachable: boolean;
  }>;
  relationships: Array<{
    npcId: number;
    npcName: string;
    strings: number;
    band: string;
  }>;
  relevantMemories: Array<{
    ownerEntityId: number;
    ownerName: string;
    aboutEntityId: number | null;
    aboutName: string | null;
    text: string;
    importance: number;
    tags: string[];
  }>;
  activeSituations: Array<{
    queueId: number;
    status: string;
    adventureKind: string;
    turnId: string | null;
    title: string | null;
    summary: string | null;
    pressureType: string | null;
    existingQuestId: number | null;
  }>;
  duplicateCandidates: Array<{
    id: number;
    kind: string;
    displayName: string;
  }>;
  recentNarrative: string;
}

export const MaterializerOutput = SituationBlueprintSchema;

export type MaterializerOutput = z.infer<typeof MaterializerOutput>;
