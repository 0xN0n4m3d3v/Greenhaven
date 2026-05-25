import {__emit} from './platform';
import {
  messageIdByTurnId,
  seenSystemEventAnchors,
} from './turnJobState';

const API_BASE = '/api';

export interface GuiEventEnvelope {
  eventId: number;
  sessionId: string;
  playerId: number | null;
  turnId: string | null;
  turnIndex: number | null;
  lane: string;
  phase: string;
  type: string;
  messageId: number | null;
  displayPolicy: Record<string, unknown>;
  payload: Record<string, unknown>;
  createdAt: string;
  releasedAt?: string | null;
  releaseSeq?: number | null;
}

export const SYSTEM_EVENT_TYPES = [
  'memory:added',
  'memory:enriched',
  'quest:created',
  'quest:started',
  'quest:advanced',
  'quest:completed',
  'quest:auto_advanced',
  'quest:choice_required',
  'scene:opened',
  'scene:choice_selected',
  'scene:closed',
  'materializer:applied',
  'materializer:auto_applied',
  'string:changed',
  'damage:dealt',
  'xp:awarded',
  'xp:levelup',
  'inspiration:gained',
  'inspiration:spent',
  'mode:changed',
  'dialogue:engaged',
  'dialogue:noticed',
  'dialogue:partner_switched',
  'dice:rolled',
  'sex_move:fired',
  'entity:revealed',
  'entity:duplicate_warning',
  'location:first_entry',
  'location:memory_added',
  'actor:status_changed',
  'media:shown',
  'movement:teleport_detected',
  'companion:added',
  'companion:removed',
  'companion:auto_departed',
  'npc:moved_with_player',
  'quest_pacer:overload',
  'quest_pacer:stale',
  'quest_pacer:dead_npc_arc',
  'npc:initiative',
  'intimacy:trigger',
  'adventure:oracle_rolled',
  'adventure:hook',
  'adventure:accepted',
  'adventure:ignored',
  'adventure:expired',
  'narrate:quarantined',
  'post_turn:slot_failed',
  // FEAT-STATE-1 — Character State mutation envelopes. Allowing
  // them in the replay filter lets the durable Character State
  // hook refresh on reload as well as live ticks.
  'character:stat_changed',
  'character:skill_unlocked',
  'character:skill_progressed',
  'character:title_awarded',
  'character:title_equipped',
] as const;

const SYSTEM_EVENT_TYPE_SET = new Set<string>(SYSTEM_EVENT_TYPES);
let lastMediaMusicDetail: Record<string, unknown> | null = null;

export function dispatchAdventureChanged(detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('adventure:changed', {detail}));
}

// GE-1 — quest panels listen for a `window` `quest:changed` event to
// refresh their state. Before GE-1 the server emitted a legacy
// per-type `quest:changed` SSE alongside the normalized `gui:event`,
// and `sseClient` translated that legacy SSE into the window event.
// Now the outbox emits only `gui:event`, so the normalized handler
// in this module is responsible for the same window dispatch. The
// helper is intentionally a side effect — quest changes are not
// rendered as `EventCard` timeline entries by the existing card
// contract, so we never push them into `system:event` for the
// timeline.
export function dispatchQuestChanged(detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('quest:changed', {detail}));
}

export function dispatchMediaMusic(detail: Record<string, unknown>): void {
  lastMediaMusicDetail = detail;
  __emit('media:music', detail);
}

export function getLastMediaMusicDetail(): Record<string, unknown> | null {
  return lastMediaMusicDetail;
}

export async function replayGuiEvents(
  sessionId: string,
  playerEntityId: number,
): Promise<void> {
  try {
    const res = await fetch(
      `${API_BASE}/session/${encodeURIComponent(sessionId)}/events?limit=200&playerId=${playerEntityId}`,
      {credentials: 'include'},
    );
    if (!res.ok) return;
    const body = (await res.json()) as {events?: GuiEventEnvelope[]};
    if (!Array.isArray(body.events)) return;
    for (const event of body.events) {
      emitSystemEventFromGuiEnvelope(event);
    }
  } catch (err) {
    console.warn('[bridge] replay gui events failed', err);
  }
}

export function emitSystemEventFromGuiEnvelope(envelope: GuiEventEnvelope): void {
  // GE-1 — `quest:changed` is a side-effect-only event: it refreshes
  // the quest panel via `window.dispatchEvent('quest:changed')` but
  // is not rendered as a timeline card. Dispatch the side-effect
  // BEFORE the timeline filter so the panel still updates on
  // every release, then fall through (the type is not in
  // SYSTEM_EVENT_TYPE_SET so it returns below).
  if (envelope.type === 'quest:changed') {
    dispatchQuestChanged({
      source: 'gui_event',
      eventId: envelope.eventId,
      payload: envelope.payload,
    });
  }
  if (envelope.type === 'media:music') {
    dispatchMediaMusic({
      source: 'gui_event',
      eventId: envelope.eventId,
      payload: envelope.payload,
    });
  }
  if (!SYSTEM_EVENT_TYPE_SET.has(envelope.type)) return;
  if (isEmptyDialoguePartnerSwitch(envelope.type, envelope.payload)) return;
  const messageId =
    envelope.messageId ??
    (envelope.turnId ? messageIdByTurnId.get(envelope.turnId) : undefined);
  if (shouldDropSeenSystemEvent(envelope.eventId, messageId)) return;
  __emit('system:event', {
    id: `gui-${envelope.eventId}`,
    eventId: envelope.eventId,
    releaseSeq: envelope.releaseSeq ?? null,
    releasedAt: envelope.releasedAt ?? null,
    type: envelope.type,
    ts: Date.parse(envelope.createdAt) || Date.now(),
    turnId: envelope.turnId,
    messageId,
    payload: {
      ...envelope.payload,
      eventId: envelope.eventId,
      releaseSeq: envelope.releaseSeq ?? null,
      releasedAt: envelope.releasedAt ?? null,
      turnId: envelope.turnId,
      turnIndex: envelope.turnIndex,
      messageId,
      lane: envelope.lane,
      phase: envelope.phase,
    },
  });
  if (envelope.type.startsWith('adventure:')) {
    dispatchAdventureChanged({
      source: 'gui_event',
      type: envelope.type,
      eventId: envelope.eventId,
      payload: envelope.payload,
    });
  }
}

export function emitSystemEventFromLegacySse(
  type: string,
  data: Record<string, unknown>,
): void {
  if (isEmptyDialoguePartnerSwitch(type, data)) return;
  const rawEventId = data['eventId'] ?? data['guiEventId'];
  const eventId =
    typeof rawEventId === 'number'
      ? rawEventId
      : typeof rawEventId === 'string'
        ? Number(rawEventId)
        : null;
  const explicitMessageId =
    typeof data['messageId'] === 'number' ? (data['messageId'] as number) : null;
  const turnId = typeof data['turnId'] === 'string' ? data['turnId'] : null;
  const messageId =
    explicitMessageId ?? (turnId ? messageIdByTurnId.get(turnId) : undefined);
  if (eventId != null && Number.isFinite(eventId)) {
    if (shouldDropSeenSystemEvent(eventId, messageId)) return;
  }
  __emit('system:event', {
    id:
      eventId != null && Number.isFinite(eventId)
        ? `gui-${eventId}`
        : `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...(eventId != null && Number.isFinite(eventId) ? {eventId} : {}),
    ...(typeof data['releaseSeq'] === 'number'
      ? {releaseSeq: data['releaseSeq'] as number}
      : {}),
    ...(typeof data['releasedAt'] === 'string'
      ? {releasedAt: data['releasedAt'] as string}
      : {}),
    type,
    ts: Date.now(),
    turnId,
    messageId,
    payload: data,
  });
  if (type.startsWith('adventure:')) {
    dispatchAdventureChanged({
      source: 'sse_event',
      type,
      eventId,
      payload: data,
    });
  }
}

function isEmptyDialoguePartnerSwitch(
  type: string,
  payload: Record<string, unknown>,
): boolean {
  if (type !== 'dialogue:partner_switched') return false;
  const rawId = payload['partner_id'] ?? payload['partnerId'] ?? payload['id'];
  const name =
    payload['partner_name'] ?? payload['partnerName'] ?? payload['name'];
  const hasPartnerId = typeof rawId === 'number' && rawId > 0;
  const hasPartnerName = typeof name === 'string' && name.trim().length > 0;
  return !hasPartnerId && !hasPartnerName;
}

function shouldDropSeenSystemEvent(
  eventId: number,
  messageId: number | null | undefined,
): boolean {
  const anchor =
    typeof messageId === 'number' && Number.isFinite(messageId) && messageId > 0
      ? messageId
      : null;
  if (!seenSystemEventAnchors.has(eventId)) {
    seenSystemEventAnchors.set(eventId, anchor);
    return false;
  }
  const previousAnchor = seenSystemEventAnchors.get(eventId) ?? null;
  if (previousAnchor == null && anchor != null) {
    seenSystemEventAnchors.set(eventId, anchor);
    return false;
  }
  return true;
}
