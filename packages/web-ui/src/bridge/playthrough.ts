// playthrough.ts — FEAT-CART-LIB-4 bridge adapter.
//
// Wraps the three backend playthrough endpoints
// (`/api/playthroughs/preview`, `/launch`, `/new-game`) and applies
// the server-authored client-cache reset hint that comes back with
// each launch / new-game response: stale `greenhaven.sessionId` is
// cleared, the launched hero's `greenhaven.playerPublicId` is
// written, and the bootstrap is reset so the next `getBridge()`
// re-fetches gameplay state from a clean slate.
//
// This module is intentionally narrow — it is NOT the Worlds &
// Heroes GUI screen (FEAT-CART-LIB-5). It is the contract that
// screen will drive.

import {
  CLIENT_STORAGE_KEYS,
  removeClientStorage,
  writeClientStorage,
  type ClientStorageKey,
} from '../lib/clientStorage';

export type PlaythroughMode = 'continue' | 'first_spawn' | 'repair_required';

/**
 * FEAT-HERO-CONTINUITY-5 — backend `ContinuityPreview` mirror.
 *
 * Shape follows `packages/web-server/src/services/HeroContinuityService.ts`
 * (`schemaVersion: 'greenhaven.hero_continuity.preview.v1'`). The bridge
 * keeps known status / code unions widened to plain `string` so a future
 * backend addition does not break the GUI build; mappers in
 * `cartridge-library/labels.ts` fall back to the raw code when a label is
 * missing.
 */
export type ContinuityClass =
  | 'hero_core'
  | 'universe_local'
  | 'portable_artifact'
  | 'portable_companion'
  | 'cartridge_static'
  | 'derived_projection';

export type ContinuityCompanionStatus =
  | 'native_local'
  | 'portable_companion'
  | 'world_bound'
  | 'requires_adapter'
  | 'suppressed';

export interface ContinuityHeroCore {
  playerId: number;
  displayName: string;
  level: number;
  xp: number;
  statTotal: number;
  proficientSkillCount: number;
  rankedSkillCount: number;
  equippedTitles: string[];
  ownedTitleCount: number;
  progressionTracks: Array<{
    trackKey: string;
    displayName: string;
    level: number;
    maxLevel: number;
  }>;
  wallet: {
    statPoints: number;
    skillPoints: number;
    titleSlots: number;
  };
}

export interface ContinuityCarryRow {
  classification: 'hero_core';
  code: string;
  summary: string;
}

export interface ContinuityLocalRow {
  classification: 'universe_local';
  code: string;
  count: number;
  nonEmpty: boolean;
}

export interface ContinuityCompanionEntry {
  sourceEntityId: number;
  displayName: string;
  status: ContinuityCompanionStatus | string;
  reason: string;
}

export interface ContinuityCompanionCandidate extends ContinuityCompanionEntry {
  hasBond: boolean;
  companionKey: string | null;
}

export interface ContinuityPortableArtifact {
  artifactKey: string;
  kind: string;
  portability: string;
  powerRating: number;
  sourceCartridgeId: string | null;
  sourceUniverseInstanceId: string | null;
}

export interface ContinuityWarning {
  code: string;
  severity: 'info' | 'warn' | string;
}

export interface ContinuityPolicy {
  schemaVersion: string;
  isDefault: boolean;
  carry: {
    xpLevel: 'visible' | 'hidden' | string;
    titles: 'visible' | 'hidden' | string;
    inventory: string;
    quests: string;
    relationships: string;
    memories: string;
    companions: string;
  };
  raw: Record<string, unknown> | null;
}

export interface ContinuityPreview {
  schemaVersion: string;
  targetCartridgeId: string;
  hero: ContinuityHeroCore;
  policy: ContinuityPolicy;
  carriesWithHero: ContinuityCarryRow[];
  staysInSourceWorld: ContinuityLocalRow[];
  companions: ContinuityCompanionEntry[];
  portableArtifacts: ContinuityPortableArtifact[];
  companionCandidates: ContinuityCompanionCandidate[];
  warnings: ContinuityWarning[];
  audit: {
    readsFrom: string[];
    mutatesRows: false;
  };
}

export interface PlaythroughPreview {
  playerId: number;
  publicId: string;
  heroName: string;
  cartridgeId: string;
  cartridgeTitle: string;
  mode: PlaythroughMode;
  isDefaultCartridge: boolean;
  installReady: boolean;
  installState: string | null;
  startingLocationId: number | null;
  startingLocationName: string | null;
  state: {
    status: 'available' | 'active' | 'incompatible' | 'archived';
    playthroughId: string;
    resetGeneration: number;
    lastSessionId: string | null;
    currentLocationId: number | null;
    currentLocationName: string | null;
    updatedAt: string;
  } | null;
  blockers: string[];
  /** FEAT-HERO-CONTINUITY-5 — additive read-only continuity preview.
   *  Null when the backend's preview helper itself faulted. */
  continuityPreview: ContinuityPreview | null;
  /** FEAT-HERO-CONTINUITY-2 — id of the universe instance this preview
   *  was scoped to. Null on a clean baseline where the cartridge has
   *  not been applied yet. */
  universeInstanceId: string | null;
}

/**
 * FEAT-HERO-CONTINUITY-4 — companion outcome row inside the carryover
 * summary. Mirrors the backend `ContinuityCarryoverCompanionOutcome`
 * with widened literal types so the bridge stays additive when the
 * server adds new statuses.
 */
export interface ContinuityCarryoverCompanion {
  bondId: number;
  companionKey: string;
  projectionEntityId: number | null;
  sourceEntityId: number | null;
  status: string;
  reason: string;
  capsuleVersion: number | null;
}

export interface ContinuityCarryoverArtifact {
  artifactKey: string;
  kind: string;
  portability: string;
  powerRating: number;
  outcome: 'carried' | 'suppressed' | string;
  reason: string;
}

export interface ContinuityCarryoverSummary {
  schemaVersion: string;
  mode: string;
  sourceCartridgeId: string | null;
  sourceUniverseInstanceId: string | null;
  targetCartridgeId: string;
  targetUniverseInstanceId: string;
  playthroughId: string;
  resetGeneration: number;
  companions: ContinuityCarryoverCompanion[];
  portableArtifacts: ContinuityCarryoverArtifact[];
  liveRosterAfter: number[];
  departingRosterBefore: number[];
  continuityEventId: number;
}

export interface PlaythroughLaunchResult {
  playerId: number;
  publicId: string;
  cartridgeId: string;
  playthroughId: string;
  resetGeneration: number;
  mode: PlaythroughMode;
  currentLocationId: number | null;
  currentLocationName: string | null;
  /** FEAT-HERO-CONTINUITY-2 — id of the universe instance the
   *  playthrough is attached to. Always present after a successful
   *  launch / new-game. */
  universeInstanceId?: string;
  /** FEAT-HERO-CONTINUITY-4 — additive carryover summary. Null when
   *  the server's carryover helper itself faulted; current GUI
   *  callers ignore the field. */
  continuityCarryover?: ContinuityCarryoverSummary | null;
  clearClientCache: {
    keys: string[];
    playerPublicId: string;
  };
}

export interface PlaythroughBridgeOptions {
  postJSON: <T>(path: string, body?: unknown) => Promise<T>;
  /** Reset the bootstrap memo so the next `getBridge()` re-fetches
   *  player + session from the server. */
  resetBootstrap: () => void;
}

/**
 * Apply the server-authored client-cache reset hint that comes back
 * with every launch / new-game / create-hero. The server is
 * authoritative on which keys are stale — we just execute the list,
 * then write the fresh `playerPublicId` so a subsequent bootstrap
 * re-fetches `/api/player/me` against the new hero. The shared
 * shape is `{keys: string[]; playerPublicId: string}`, so any
 * endpoint that returns it can route through this helper.
 */
export interface ClearClientCacheHint {
  keys: string[];
  playerPublicId: string;
}

export function applyClientCacheReset(
  hint: ClearClientCacheHint,
): {removed: string[]} {
  const removed: string[] = [];
  for (const key of hint.keys) {
    // Only act on known Greenhaven keys to avoid drive-by writes
    // to keys the server doesn't actually control.
    if (!isClientStorageKey(key)) continue;
    if (removeClientStorage(key)) removed.push(key);
  }
  if (hint.playerPublicId) {
    writeClientStorage(
      CLIENT_STORAGE_KEYS.playerPublicId,
      hint.playerPublicId,
    );
  }
  return {removed};
}

function isClientStorageKey(key: string): key is ClientStorageKey {
  for (const v of Object.values(CLIENT_STORAGE_KEYS)) {
    if (v === key) return true;
  }
  return false;
}

export function createPlaythroughBridge(opts: PlaythroughBridgeOptions): {
  preview(args: {playerId: number; cartridgeId: string}): Promise<PlaythroughPreview>;
  launch(args: {playerId: number; cartridgeId: string}): Promise<PlaythroughLaunchResult>;
  newGame(args: {playerId: number; cartridgeId: string}): Promise<PlaythroughLaunchResult>;
} {
  return {
    async preview(args) {
      return await opts.postJSON<PlaythroughPreview>(
        '/playthroughs/preview',
        args,
      );
    },
    async launch(args) {
      const result = await opts.postJSON<PlaythroughLaunchResult>(
        '/playthroughs/launch',
        args,
      );
      applyClientCacheReset(result.clearClientCache);
      // The launched hero is server-authoritative — drop the bridge
      // memo so the next caller re-bootstraps from the new identity
      // instead of reusing the old player + session.
      opts.resetBootstrap();
      return result;
    },
    async newGame(args) {
      const result = await opts.postJSON<PlaythroughLaunchResult>(
        '/playthroughs/new-game',
        args,
      );
      applyClientCacheReset(result.clearClientCache);
      opts.resetBootstrap();
      return result;
    },
  };
}
