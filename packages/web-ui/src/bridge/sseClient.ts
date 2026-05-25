import {createTurnJobSnapshot, createTurnResult} from './platform';
import {recordFrontendEvent} from '../lib/frontendTelemetry';
import {type BridgeRuntime} from './bootstrap';
import {
  SYSTEM_EVENT_TYPES,
  emitSystemEventFromGuiEnvelope,
  emitSystemEventFromLegacySse,
  type GuiEventEnvelope,
} from './eventTimeline';
import {__emit} from './platform';
import {
  appendAssistantMessage,
  appendUserMessage,
  emptyPatchReport,
  updateLastUserMessageText,
} from './stateReconciler';
import {
  clearLocalSessionRuntime,
  jobs,
  rememberTurnMessageId,
  settleJob,
  turnAuthor,
  turnDice,
  turnText,
  type PersistedDice,
} from './turnJobState';

const API_BASE = '/api';

export interface SseClientDeps {
  getBridge(): Promise<BridgeRuntime>;
  resetBootstrap(): void;
  refreshPersistedMessages(
    runtime: BridgeRuntime,
    reason: string,
  ): Promise<boolean>;
  refreshPlayer(runtime: BridgeRuntime): Promise<void>;
  refreshAffordances(runtime: BridgeRuntime): Promise<void>;
}

export interface SseClient {
  openSseStream(sessionId: string, playerEntityId: number): EventSource;
}

export function createSseStreamClient(deps: SseClientDeps): SseClient {
  function openSseStream(sessionId: string, playerEntityId: number): EventSource {
    recordFrontendEvent('info', 'sse_opening', 'Opening SSE stream', {
      sessionId,
      playerId: playerEntityId,
    });
    const url = `${API_BASE}/session/${encodeURIComponent(sessionId)}/stream?playerId=${playerEntityId}`;
    const source = new EventSource(url);

    source.addEventListener('turn.start', e => {
      const data = parseEvent<{turnId: string}>(e);
      if (!data) return;
      turnText.set(data.turnId, '');
      const existing = jobs.get(data.turnId);
      if (existing && existing.status === 'queued') {
        jobs.set(
          data.turnId,
          createTurnJobSnapshot({
            ...existing,
            status: 'running',
            startedAt: Date.now(),
          }),
        );
      }
    });

    source.addEventListener('message:created', e => {
      // USER-6 / UI-9 — server-side `message:created` is emitted only
      // by PlayerMessagePersistencePhase (inside an `onTransactionCommit`
      // hook), so any event that reaches the client is a player message
      // whose row has been committed. Validate the required persisted
      // identifiers instead of filtering on `tone`.
      const data = parseEvent<{
        turnId: string;
        messageId: number;
        turnIndex: number;
        text?: string;
        visibleText?: string;
      }>(e);
      if (
        !data ||
        typeof data.turnId !== 'string' ||
        typeof data.messageId !== 'number' ||
        typeof data.turnIndex !== 'number'
      ) {
        return;
      }
      const text = data.visibleText ?? data.text ?? '';
      if (!text) return;
      void deps.getBridge().then(runtime => {
        runtime.state = appendUserMessage(runtime.state, text, {
          messageId: data.messageId,
          turnIndex: data.turnIndex,
        });
      });
      __emit('player:message_created', {
        turnId: data.turnId,
        text,
        messageId: data.messageId,
        turnIndex: data.turnIndex,
      });
    });

    source.addEventListener('player:message_rendered', e => {
      const data = parseEvent<{
        turnId: string;
        originalText: string;
        visibleText: string;
        changed: boolean;
      }>(e);
      if (!data) return;
      __emit('player:message_rendered', data);
      if (data.changed) {
        void deps.getBridge().then(runtime => {
          runtime.state = updateLastUserMessageText(
            runtime.state,
            data.originalText,
            data.visibleText,
          );
        });
      }
    });

    source.addEventListener('narrate', e => {
      const data = parseEvent<{
        turnId: string;
        messageId?: number | null;
        turnIndex?: number | null;
        author: string | null;
        authorId: number | null;
        tone: 'npc' | 'narrator' | 'system';
        mentions?: Array<{id: number; name: string; kind: string}>;
      }>(e);
      if (!data) return;
      rememberTurnMessageId(data.turnId, data.messageId);
      turnAuthor.set(data.turnId, {
        author: data.author,
        authorId: data.authorId,
        tone: data.tone,
        messageId: data.messageId ?? null,
        turnIndex: data.turnIndex ?? null,
        mentions: data.mentions ?? [],
      });
      if (Array.isArray(data.mentions) && data.mentions.length > 0) {
        __emit('mentions:discovered', data.mentions);
      }
    });

    source.addEventListener('dialogue:engaged', e => {
      const data = parseEvent<{npcId: number; npcName: string | null}>(e);
      if (!data || typeof data.npcId !== 'number') return;
      __emit('dialogue:engaged', {id: data.npcId, name: data.npcName ?? ''});
    });

    source.addEventListener('dialogue:partner_switched', e => {
      const data = parseEvent<{
        partner_id?: number | null;
        partner_name?: string | null;
        partnerId?: number | null;
        partnerName?: string | null;
        reason?: string | null;
      }>(e);
      if (!data) return;
      const id = data.partner_id ?? data.partnerId ?? null;
      __emit('dialogue:partner_switched', {
        id,
        name: data.partner_name ?? data.partnerName ?? '',
        partner_id: id,
        partner_name: data.partner_name ?? data.partnerName ?? '',
        reason: data.reason ?? null,
      });
    });

    source.addEventListener('dialogue:participants_updated', e => {
      const data = parseEvent<{
        focused_partner_id?: number | null;
        participant_ids?: number[];
        participants?: Array<{
          id: number;
          display_name?: string | null;
          name?: string | null;
        }>;
        source?: string | null;
      }>(e);
      if (!data) return;
      const id =
        typeof data.focused_partner_id === 'number' &&
        data.focused_partner_id > 0
          ? data.focused_partner_id
          : null;
      const partner = data.participants?.find(p => p.id === id);
      __emit('dialogue:partner_switched', {
        id,
        name: partner?.display_name ?? partner?.name ?? '',
        partner_id: id,
        partner_name: partner?.display_name ?? partner?.name ?? '',
        reason: data.source ?? null,
      });
    });

    source.addEventListener('player:moved', e => {
      const moved = parseEvent<{
        fromId?: number | null;
        toId?: number | null;
        toName?: string | null;
        noop?: boolean;
      }>(e);
      console.log(
        `[bridge] player:moved received fromId=${moved?.fromId ?? '?'} ` +
          `toId=${moved?.toId ?? '?'} toName=${moved?.toName ?? '?'} ` +
          `noop=${moved?.noop ?? false}`,
      );
      // Spec 139 v2 — fire refreshLocations TWICE on player:moved.
      //   immediate → catch the common case where server has committed.
      //   400 ms later → catch the race where server emits player:moved
      //                   slightly before the DB commit lands.
      // Without the second tick, the UI could end up with the new
      // location title but the OLD location's nearby NPCs (or empty).
      void refreshLocations(sessionId, playerEntityId);
      window.setTimeout(
        () => void refreshLocations(sessionId, playerEntityId),
        400,
      );
    });

    // Backup refresh path: `location:first_entry` is part of SYSTEM_EVENT_TYPES
    // and is always delivered when the player physically enters a location for
    // the first time. We hook the same refresh here so the rail/header update
    // even when `player:moved` was lost (race with reconnect, sessionManager
    // miss, etc.). refreshLocations dedupes naturally — second call is cheap
    // and idempotent.
    source.addEventListener('location:first_entry', () => {
      console.log('[bridge] location:first_entry — refreshing locations');
      void refreshLocations(sessionId, playerEntityId);
    });

    source.addEventListener('content', e => {
      const data = parseEvent<{
        turnId?: string;
        streamSeq?: number | null;
        delta: string;
      }>(e);
      if (!data?.delta) return;
      __emit('turn:token', data.delta);
      if (data.turnId && turnText.has(data.turnId)) {
        turnText.set(
          data.turnId,
          (turnText.get(data.turnId) ?? '') + data.delta,
        );
      }
    });

    source.addEventListener('turn.end', e => {
      const data = parseEvent<{
        turnId: string;
        messageId?: number | null;
        durationMs?: number;
      }>(e);
      if (!data) return;
      rememberTurnMessageId(data.turnId, data.messageId);
      const visible = turnText.get(data.turnId) ?? '';
      const meta = turnAuthor.get(data.turnId);
      const dice = turnDice.get(data.turnId) ?? [];
      turnText.delete(data.turnId);
      turnAuthor.delete(data.turnId);
      turnDice.delete(data.turnId);

      void deps
        .getBridge()
        .then(async runtime => {
          const beforeCount = runtime.state.messages?.length ?? 0;
          runtime.state = appendAssistantMessage(
            runtime.state,
            visible,
            meta,
            dice,
          );
          const afterCount = runtime.state.messages?.length ?? 0;
          if (
            afterCount === beforeCount &&
            (visible.trim().length === 0 || data.messageId != null)
          ) {
            await deps.refreshPersistedMessages(
              runtime,
              'turn.end rehydrate',
            );
          }
          await deps.refreshPlayer(runtime);
          await deps.refreshAffordances(runtime);
          const result = createTurnResult({
            state: runtime.state,
            usedProvider: runtime.state.provider?.model ?? 'gemini',
            visible,
            patchReport: emptyPatchReport(),
          });
          settleJob(data.turnId, {status: 'done', result});
        })
        .catch(err => {
          console.error('[bridge] turn.end finalisation failed', err);
          const existing = jobs.get(data.turnId);
          const fallbackState = existing?.result?.state;
          if (fallbackState) {
            settleJob(data.turnId, {
              status: 'done',
              result: createTurnResult({
                state: fallbackState,
                usedProvider: fallbackState.provider?.model ?? 'gemini',
                visible,
                patchReport: emptyPatchReport(),
              }),
            });
          } else {
            settleJob(data.turnId, {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      __emit('turn:stream_done', visible);
    });

    source.addEventListener('turn.error', e => {
      const data = parseEvent<{message: string}>(e as MessageEvent);
      const msg = data?.message ?? 'stream error';
      console.error('[bridge] turn error:', msg);
      settleActiveJobsWithError(msg);
      __emit('turn:stream_done', '');
    });

    source.addEventListener('cancelled', e => {
      const data = parseEvent<{turnId: string}>(e);
      if (!data) return;
      settleJob(data.turnId, {status: 'canceled'});
      __emit('turn:stream_done', '');
    });

    source.addEventListener('reset', e => {
      const data = parseEvent<Record<string, unknown>>(e) ?? {};
      clearLocalSessionRuntime('session reset');
      __emit('session:reset', data);
      __emit('turn:stream_done', '');
    });

    source.addEventListener('runtime:field', e => {
      const data = parseEvent<{
        owner_entity_id: number;
        field_key: string;
        value: unknown;
        source: string;
      }>(e);
      if (!data) return;
      __emit('runtime:field', data);
    });

    source.addEventListener('inventory:changed', e => {
      const data = parseEvent<Record<string, unknown>>(e);
      if (!data) return;
      __emit('inventory:changed', data);
    });

    source.addEventListener('currency:changed', e => {
      const data = parseEvent<Record<string, unknown>>(e);
      if (!data) return;
      __emit('currency:changed', data);
    });

    source.addEventListener('mode:changed', e => {
      const data = parseEvent<{mode: string; prev?: string | null}>(e);
      if (!data) return;
      __emit('mode:changed', data);
    });

    source.addEventListener('ambient:bed', e => {
      const data = parseEvent<{slug: string}>(e);
      if (!data) return;
      __emit('ambient:bed', data);
    });

    source.addEventListener('dialogue:noticed', e => {
      const data = parseEvent<{
        npc_id: number;
        npc_name: string;
        reason?: string;
      }>(e);
      if (!data) return;
      __emit('dialogue:noticed', data);
    });

    source.addEventListener('quest:changed', e => {
      const data = parseEvent<{
        questId: number;
        status: 'advanced' | 'completed' | 'failed';
        stage?: string;
      }>(e);
      if (!data) return;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('quest:changed', {detail: data}));
      }
    });

    let lastMode: string | null = null;
    let lastDialoguePartner: number | null = null;
    for (const type of SYSTEM_EVENT_TYPES) {
      source.addEventListener(type, e => {
        const data = parseEvent<Record<string, unknown>>(e);
        if (!data) return;
        if (type === 'mode:changed') {
          const mode = data['mode'] as string | undefined;
          if (mode === lastMode) return;
          lastMode = mode ?? null;
        }
        if (type === 'dialogue:engaged') {
          const id = (data['npcId'] ?? data['npc_id']) as number | undefined;
          if (id === lastDialoguePartner) return;
          lastDialoguePartner = id ?? null;
        }
        console.debug('[system:event]', type, data);
        emitSystemEventFromLegacySse(type, data);
      });
    }

    source.addEventListener('gui:event', e => {
      const data = parseEvent<GuiEventEnvelope>(e);
      if (!data || typeof data.eventId !== 'number') return;
      emitSystemEventFromGuiEnvelope(data);
    });

    source.addEventListener('dice:rolled', e => {
      const data = parseEvent<{
        turnId?: string;
        roll: number;
        total?: number;
        modifier?: number;
        dc?: number | null;
        outcome?: 'success' | 'failure' | null;
        label?: string | null;
        roller?: 'player' | 'npc';
        position?: 'controlled' | 'risky' | 'desperate';
        effect?: 'limited' | 'standard' | 'great';
      }>(e);
      if (!data) return;
      const persisted: PersistedDice = {
        roll: data.roll,
        dc: data.dc ?? null,
        outcome: data.outcome ?? null,
        description: data.label ?? '',
        roller: data.roller ?? 'player',
        position: data.position,
        effect: data.effect,
      };
      __emit('dice:rolled', {
        action_id: '',
        description: persisted.description,
        roll: persisted.roll,
        dc: persisted.dc,
        outcome: persisted.outcome,
        roller: persisted.roller,
        position: persisted.position,
        effect: persisted.effect,
      });
      if (data.turnId) {
        const list = turnDice.get(data.turnId) ?? [];
        list.push(persisted);
        turnDice.set(data.turnId, list);
      }
    });

    let staleAt: number | null = null;
    source.onerror = err => {
      console.warn('[bridge] EventSource error', err);
      recordFrontendEvent('warn', 'sse_error', 'EventSource reported an error', {
        readyState: source.readyState,
        sessionId,
        playerId: playerEntityId,
      });
      if (source.readyState === EventSource.CLOSED) {
        staleAt = null;  // Reset on close so next reconnect gets full grace period
        deps.resetBootstrap();
        return;
      }
      if (source.readyState === EventSource.CONNECTING) {
        if (staleAt == null) {
          staleAt = Date.now();
        } else if (Date.now() - staleAt > 10000) {
          console.warn('[bridge] SSE stuck reconnecting; dropping session');
          recordFrontendEvent(
            'error',
            'sse_stale_reconnect',
            'SSE stayed reconnecting too long',
            {
              sessionId,
              playerId: playerEntityId,
              staleMs: Date.now() - staleAt,
            },
          );
          try {
            source.close();
          } catch {
            // ignore stale EventSource close errors
          }
          deps.resetBootstrap();
          settleActiveJobsWithError('connection lost - please retry');
          __emit('turn:stream_done', '');
        }
      } else {
        staleAt = null;
      }
    };

    return source;
  }

  return {openSseStream};
}

async function refreshLocations(
  sessionId: string,
  playerEntityId: number,
): Promise<void> {
  try {
    const response = await fetch(
      `${API_BASE}/session/${encodeURIComponent(sessionId)}/locations?playerId=${playerEntityId}`,
      {credentials: 'include'},
    );
    if (!response.ok) {
      console.warn(
        `[bridge] /locations returned HTTP ${response.status} ${response.statusText}`,
      );
      return;
    }
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
        // FEAT-PRESENCE-2 — preserve server-canonical bond + status
        // badges through the SSE-driven refresh path as well, so the
        // rail / map / NPC profile surfaces always see the same shape
        // the bootstrap snapshot delivered.
        relationship?: {band: string | null; count: number | null} | null;
        statuses?: Array<{kind: string; value: string; intensity: number}>;
      }>;
      map?: {
        nodes: Array<{
          id: number;
          name: string;
          kind: string;
          location_kind: string | null;
          x: number;
          y: number;
          color: string | null;
          topology_parent_id: number | null;
          is_current: boolean;
          is_exit: boolean;
        }>;
      };
    };
    console.log(
      `[bridge] /locations → current=${data.current?.id ?? '?'}/${data.current?.name ?? '?'} ` +
        `exits=${data.exits?.length ?? 0} nearby=${data.nearby?.length ?? 0} ` +
        `mapNodes=${data.map?.nodes?.length ?? 0}`,
    );
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
      if (merged.some(location => location.id === exit.id)) continue;
      merged.push({
        id: exit.id,
        name: exit.name,
        status: 'exit',
        unread: 0,
        visual_asset_urls: exit.visual_asset_urls ?? null,
      });
    }
    __emit('locations:updated', merged);
    __emit('nearby:updated', Array.isArray(data.nearby) ? data.nearby : []);
    __emit('map:updated', data.map?.nodes ?? []);
  } catch (err) {
    console.warn('[bridge] player:moved fetch locations failed', err);
  }
}

function settleActiveJobsWithError(error: string): void {
  for (const [id, job] of [...jobs]) {
    if (job.status === 'queued' || job.status === 'running') {
      settleJob(id, {status: 'error', error});
    }
  }
}

function parseEvent<T>(event: MessageEvent): T | undefined {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return undefined;
  }
}
