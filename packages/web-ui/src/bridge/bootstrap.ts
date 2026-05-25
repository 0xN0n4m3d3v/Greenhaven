import { engine } from './platform';
import {
  CLIENT_STORAGE_KEYS,
  clearStoredPlayerIdentity,
  clearStoredSessionId,
  readClientStorage,
  readStoredPlayerPublicId,
  readStoredSessionId,
  writeStoredPlayerPublicId,
  writeStoredSessionId,
} from '../lib/clientStorage';
import {
  recordFrontendEvent,
  setFrontendTelemetryContext,
} from '../lib/frontendTelemetry';
import { __emit } from './platform';
import {
  chatMessagesFromPersisted,
  rememberPersistedTurnMessageIds,
  synthState,
  type PersistedMessage,
  type ServerSessionSnapshot,
} from './stateReconciler';

const API_BASE = '/api';

export interface BridgeRuntime {
  sessionId: string;
  player: PlayerSnapshot;
  state: engine.GameState;
  source: EventSource;
}

export interface PlayerSnapshot {
  public_id: string;
  entity_id: number;
  display_name: string;
  profile_created?: boolean;
  current_xp: number;
  current_level: number;
  current_hp: number;
  max_hp: number;
  current_location_id: number | null;
  current_scene_id: number | null;
  current_location_name: string | null;
  current_scene_name: string | null;
  dialogue_partner_id?: number | null;
  dialogue_partner_name?: string | null;
  companions?: Array<{ id: number; name: string }>;
  current_location_first_visit?: boolean;
  current_location_visit_count?: number;
  current_location_intro_bubble?: string | null;
  current_location_visual_asset_urls?: Record<string, string> | null;
}

interface PlayerWithLegacyRecovery extends PlayerSnapshot {
  recovery_code?: string;
}

export interface BridgeBootstrapDeps {
  openSseStream(sessionId: string, playerEntityId: number): EventSource;
  replayGuiEvents(sessionId: string, playerEntityId: number): Promise<void>;
}

export interface BridgeBootstrapApi {
  getBridge(): Promise<BridgeRuntime>;
  refreshPersistedMessages(
    runtime: BridgeRuntime,
    reason: string,
  ): Promise<boolean>;
  refreshPlayer(runtime: BridgeRuntime): Promise<void>;
  refreshAffordances(runtime: BridgeRuntime): Promise<void>;
  resetBootstrap(): void;
}

export function createBridgeBootstrap(
  deps: BridgeBootstrapDeps,
): BridgeBootstrapApi {
  let bootstrap: Promise<BridgeRuntime> | undefined;

  function resetBootstrap(): void {
    bootstrap = undefined;
  }

  function readPersistedSessionId(): string | null {
    return readStoredSessionId();
  }

  function writePersistedSessionId(id: string): void {
    writeStoredSessionId(id);
  }

  function clearPersistedSessionId(): void {
    clearStoredSessionId();
  }

  function readUiLanguage(): string {
    const saved = readClientStorage(CLIENT_STORAGE_KEYS.uiLanguage);
    if (typeof saved === 'string' && saved.trim()) {
      return saved.trim().toLowerCase().split(/[-_]/)[0] ?? 'en';
    }
    const browserLanguage =
      typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language
        : 'en';
    return browserLanguage.trim().toLowerCase().split(/[-_]/)[0] ?? 'en';
  }

  async function fetchPlayerSnapshot(
    publicId: string,
    opts: { preferCreated?: boolean; includeIntro?: boolean } = {},
  ): Promise<PlayerSnapshot | null> {
    const params = new URLSearchParams({ id: publicId });
    if (opts.preferCreated) params.set('preferCreated', '1');
    if (opts.includeIntro) {
      params.set('includeIntro', '1');
      params.set('language', readUiLanguage());
    }
    const response = await fetch(`${API_BASE}/player/me?${params.toString()}`, {
      credentials: 'include',
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GET /player/me failed: ${response.status}`);
    }
    return (await response.json()) as PlayerSnapshot;
  }

  function writePersistedPlayerId(id: string): void {
    writeStoredPlayerPublicId(id);
  }

  async function postSession(
    player: PlayerSnapshot,
    sessionId: string | null,
  ): Promise<Response> {
    return fetch(`${API_BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(sessionId ? { sessionId } : {}),
        playerId: player.entity_id,
      }),
      credentials: 'include',
    });
  }

  async function fetchPersistedMessages(
    runtime: BridgeRuntime,
    limit = 200,
  ): Promise<PersistedMessage[]> {
    const response = await fetch(
      `${API_BASE}/session/${encodeURIComponent(runtime.sessionId)}/messages?limit=${limit}&playerId=${runtime.player.entity_id}`,
      { credentials: 'include' },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as { messages?: PersistedMessage[] };
    return Array.isArray(body.messages) ? body.messages : [];
  }

  async function refreshPersistedMessages(
    runtime: BridgeRuntime,
    reason: string,
  ): Promise<boolean> {
    try {
      const persistedMessages = await fetchPersistedMessages(runtime);
      if (persistedMessages.length === 0) return false;
      rememberPersistedTurnMessageIds(persistedMessages);
      runtime.state = engine.GameState.createFrom({
        ...runtime.state,
        messages: chatMessagesFromPersisted(persistedMessages),
      });
      return true;
    } catch (err) {
      console.warn(`[bridge] ${reason}: fetch messages failed`, err);
      return false;
    }
  }

  async function getBridge(): Promise<BridgeRuntime> {
    if (bootstrap) return bootstrap;
    bootstrap = (async () => {
      const player = await ensurePlayer();
      let persistedSessionId = readPersistedSessionId();
      let res = await postSession(player, persistedSessionId);
      if (res.status === 403 && persistedSessionId) {
        clearPersistedSessionId();
        persistedSessionId = null;
        res = await postSession(player, persistedSessionId);
      }
      if (!res.ok) throw new Error(`POST /session failed: ${res.status}`);
      const body = (await res.json()) as {
        sessionId: string;
        state: ServerSessionSnapshot;
      };
      writePersistedSessionId(body.sessionId);
      setFrontendTelemetryContext({
        sessionId: body.sessionId,
        playerId: player.entity_id,
        traceId: body.sessionId,
      });
      recordFrontendEvent(
        'info',
        'bridge_session_ready',
        'Bridge session established',
        {
          restoredSession: Boolean(persistedSessionId),
          profileCreated: player.profile_created === true,
        },
      );
      await reapplyModelOverride(body.sessionId, player.entity_id);
      const persistedMessages = await loadInitialMessages(
        body.sessionId,
        player.entity_id,
      );
      const state = synthState(body.state, player, persistedMessages);
      await emitInitialAffordances(body.sessionId, player.entity_id);
      await seedInitialLocations(state, body.sessionId, player.entity_id);

      const source = deps.openSseStream(body.sessionId, player.entity_id);
      void deps.replayGuiEvents(body.sessionId, player.entity_id);
      emitResumeUiState(player);

      return { sessionId: body.sessionId, player, state, source };
    })().catch((err) => {
      bootstrap = undefined;
      throw err;
    });
    return bootstrap;
  }

  async function reapplyModelOverride(
    sessionId: string,
    playerId: number,
  ): Promise<void> {
    const savedModel = readClientStorage(CLIENT_STORAGE_KEYS.modelOverride);
    if (!savedModel) return;
    try {
      await fetch(
        `${API_BASE}/session/${encodeURIComponent(sessionId)}/model`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: savedModel, playerId }),
          credentials: 'include',
        },
      );
    } catch (err) {
      console.warn('[bridge] re-apply modelOverride failed', err);
    }
  }

  async function loadInitialMessages(
    sessionId: string,
    playerId: number,
  ): Promise<PersistedMessage[]> {
    try {
      const response = await fetch(
        `${API_BASE}/session/${encodeURIComponent(sessionId)}/messages?limit=200&playerId=${playerId}`,
        { credentials: 'include' },
      );
      if (!response.ok) return [];
      const body = (await response.json()) as { messages: PersistedMessage[] };
      return Array.isArray(body.messages) ? body.messages : [];
    } catch (err) {
      console.warn('[bridge] resume: fetch messages failed', err);
      return [];
    }
  }

  async function emitInitialAffordances(
    sessionId: string,
    playerId: number,
  ): Promise<void> {
    try {
      const response = await fetch(
        `${API_BASE}/session/${encodeURIComponent(sessionId)}/affordances?playerId=${playerId}`,
        { credentials: 'include' },
      );
      if (!response.ok) return;
      const data = (await response.json()) as { actions?: unknown[] };
      if (Array.isArray(data.actions)) {
        __emit('affordances:updated', data.actions);
      }
    } catch (err) {
      console.warn('[bridge] initial affordances fetch failed', err);
    }
  }

  async function seedInitialLocations(
    state: engine.GameState,
    sessionId: string,
    playerId: number,
  ): Promise<void> {
    try {
      const response = await fetch(
        `${API_BASE}/session/${encodeURIComponent(sessionId)}/locations?playerId=${playerId}`,
        { credentials: 'include' },
      );
      if (!response.ok) return;
      const data = (await response.json()) as {
        current: {
          id: number;
          name: string;
          visual_asset_urls?: Record<string, string> | null;
        } | null;
        exits: Array<{
          id: number;
          name: string;
          kind: string;
          visual_asset_urls?: Record<string, string> | null;
        }>;
        nearby?: Array<{
          id: number;
          name: string;
          status?: string;
          summary?: string | null;
          portrait_set?: Record<string, string | null> | null;
          // FEAT-PRESENCE-2 — bond band + capped public status
          // badges so the initial app load already paints the rail
          // chip without waiting for the next nearby SSE refresh.
          relationship?: {band: string | null; count: number | null} | null;
          statuses?: Array<{kind: string; value: string; intensity: number}>;
        }>;
      };
      const merged: Array<{
        id: number;
        name: string;
        status: string;
        unread: number;
        visual_asset_urls?: Record<string, string> | null;
      }> = [];
      if (data.current) {
        merged.push({
          id: data.current.id,
          name: data.current.name,
          status: 'current',
          unread: 0,
          visual_asset_urls: data.current.visual_asset_urls ?? null,
        });
      }
      for (const exit of data.exits) {
        if (merged.some((location) => location.id === exit.id)) continue;
        merged.push({
          id: exit.id,
          name: exit.name,
          status: 'exit',
          unread: 0,
          visual_asset_urls: exit.visual_asset_urls ?? null,
        });
      }
      const stateAny = state as unknown as { locations?: unknown };
      stateAny.locations = merged.map((location) =>
        engine.LocationSummary.createFrom(location),
      );
      (stateAny as { nearby?: unknown }).nearby = Array.isArray(data.nearby)
        ? data.nearby
        : [];
    } catch (err) {
      console.warn('[bridge] resume: fetch locations failed', err);
    }
  }

  function emitLocationIntroState(player: PlayerSnapshot): void {
    const currentLocationId = readPositiveNumber(player.current_location_id);
    if (
      currentLocationId != null &&
      typeof player.current_location_intro_bubble === 'string' &&
      player.current_location_intro_bubble.trim().length > 0
    ) {
      __emit('system:event', {
        id: `location-first-entry-bootstrap-${player.entity_id}-${currentLocationId}`,
        type: 'location:first_entry',
        ts: Date.now(),
        payload: {
          locationId: currentLocationId,
          locationName:
            player.current_location_name ?? String(player.current_location_id),
          firstVisit: player.current_location_first_visit === true,
          visitCount: player.current_location_visit_count ?? 1,
          introBubble: player.current_location_intro_bubble,
          locationImageUrl:
            player.current_location_visual_asset_urls?.location_view ?? null,
          bootstrap: true,
        },
      });
    }
  }

  function emitResumeUiState(player: PlayerSnapshot): void {
    emitLocationIntroState(player);
    if (
      typeof player.dialogue_partner_id === 'number' &&
      player.dialogue_partner_id > 0
    ) {
      __emit('dialogue:engaged', {
        id: player.dialogue_partner_id,
        name: player.dialogue_partner_name ?? '',
      });
    }
    if (!Array.isArray(player.companions)) return;
    for (const companion of player.companions) {
      __emit('system:event', {
        id: `companion-restore-${companion.id}-${Date.now()}`,
        type: 'companion:added',
        ts: Date.now(),
        payload: {
          npcId: companion.id,
          npcName: companion.name,
          reason: '(restored after reload)',
          total: player.companions?.length ?? 0,
          already: true,
        },
      });
    }
  }

  function readPositiveNumber(value: unknown): number | null {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  async function refreshPlayer(runtime: BridgeRuntime): Promise<void> {
    try {
      const fresh = await fetchPlayerSnapshot(runtime.player.public_id, {
        includeIntro: true,
      });
      if (!fresh) {
        clearStoredPlayerIdentity();
        try {
          runtime.source.close();
        } catch {
          // ignore stale EventSource close errors
        }
        resetBootstrap();
        const fresh = await getBridge();
        runtime.sessionId = fresh.sessionId;
        runtime.player = fresh.player;
        runtime.state = fresh.state;
        runtime.source = fresh.source;
        return;
      }
      runtime.player = fresh;
      emitLocationIntroState(fresh);
      const xpForNext =
        (fresh.current_level + 1) * (fresh.current_level + 1) * 100;
      runtime.state.hero = engine.HeroSummary.createFrom({
        id: fresh.entity_id,
        name: fresh.display_name,
        statuses: [
          `lvl ${fresh.current_level}`,
          `${fresh.current_xp}/${xpForNext} XP`,
        ],
        states: [`hp ${fresh.current_hp}/${fresh.max_hp}`],
      });
    } catch (err) {
      console.warn('[bridge] refreshPlayer failed', err);
    }
  }

  async function refreshAffordances(runtime: BridgeRuntime): Promise<void> {
    try {
      const response = await fetch(
        `${API_BASE}/session/${encodeURIComponent(runtime.sessionId)}/affordances?playerId=${runtime.player.entity_id}`,
        { credentials: 'include' },
      );
      if (!response.ok) return;
      const data = (await response.json()) as { actions?: unknown[] };
      if (!Array.isArray(data.actions)) return;
      __emit('affordances:updated', data.actions);
    } catch (err) {
      console.warn('[bridge] refreshAffordances failed', err);
    }
  }

  async function ensurePlayer(): Promise<PlayerSnapshot> {
    const savedId = readStoredPlayerPublicId();

    if (savedId) {
      const player = await fetchPlayerSnapshot(savedId, {
        preferCreated: true,
      });
      if (player) {
        if (player.public_id !== savedId) {
          writePersistedPlayerId(player.public_id);
          clearPersistedSessionId();
        }
        return player;
      }
      clearStoredPlayerIdentity();
    }

    const response = await fetch(`${API_BASE}/player/anonymous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error(`POST /player/anonymous failed: ${response.status}`);
    }
    const created = (await response.json()) as PlayerWithLegacyRecovery;
    writePersistedPlayerId(created.public_id);
    // The backend still returns the legacy one-time recovery code for
    // compatibility, but the current client no longer exposes a recovery UI.
    const { recovery_code: _, ...rest } = created;
    void _;
    const hydrated = await fetchPlayerSnapshot(rest.public_id);
    return hydrated ?? rest;
  }

  return {
    getBridge,
    refreshPersistedMessages,
    refreshPlayer,
    refreshAffordances,
    resetBootstrap,
  };
}
