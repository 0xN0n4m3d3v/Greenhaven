import {engine} from './platform';
import {__emit} from './platform';
import {
  rememberTurnMessageId,
  type NarrateMeta,
  type PersistedDice,
} from './turnJobState';

export interface PersistedMessage {
  id: number;
  authorId: number;
  author: string | null;
  tone: string;
  text: string;
  turnIndex: number;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface StatePlayerSnapshot {
  entity_id: number;
  display_name: string;
  current_xp: number;
  current_level: number;
  current_hp: number;
  max_hp: number;
  current_location_id: number | null;
  current_scene_id: number | null;
  current_location_name: string | null;
  current_scene_name: string | null;
  current_location_visual_asset_urls?: Record<string, string> | null;
}

export interface ServerSessionSnapshot {
  sessionId: string;
  cwd: string;
  ready: boolean;
  authType?: string;
  model?: string;
}

export function chatMessagesFromPersisted(
  persistedMessages: PersistedMessage[],
): engine.ChatMessage[] {
  return persistedMessages.map(message =>
    engine.ChatMessage.createFrom({
      id: message.id,
      authorId: message.authorId,
      author: message.author ?? '',
      tone: message.tone,
      text: message.text,
      turn: message.turnIndex,
    }),
  );
}

export function rememberPersistedTurnMessageIds(
  persistedMessages: PersistedMessage[],
): void {
  for (const message of persistedMessages) {
    const turnId =
      message.payload && typeof message.payload['turn_id'] === 'string'
        ? message.payload['turn_id']
        : null;
    if (turnId && message.tone !== 'player') {
      rememberTurnMessageId(turnId, message.id);
    }
  }
}

export function synthState(
  snapshot: ServerSessionSnapshot,
  player: StatePlayerSnapshot,
  persistedMessages: PersistedMessage[] = [],
): engine.GameState {
  const xpForNext = (player.current_level + 1) * (player.current_level + 1) * 100;
  const locName = player.current_location_name ?? '';
  const sceneName = player.current_scene_name ?? '';
  rememberPersistedTurnMessageIds(persistedMessages);
  return engine.GameState.createFrom({
    dbPath: snapshot.cwd,
    currentLocation: {
      id: player.current_location_id ?? 0,
      name: locName,
      status: 'connected',
      unread: 0,
      visual_asset_urls: player.current_location_visual_asset_urls ?? null,
    },
    currentScene: {
      id: player.current_scene_id ?? 0,
      type: 'scene',
      name: sceneName,
      summary: '',
      status: [],
      state: [],
      tags: sceneName ? ['scene'] : [],
    },
    focusEntity: {
      id: 0,
      type: 'person',
      name: '',
      summary: '',
      status: [],
      state: [],
      tags: [],
    },
    locations:
      player.current_location_id != null
        ? [
            {
              id: player.current_location_id,
              name: locName,
              status: 'connected',
              unread: 0,
              visual_asset_urls: player.current_location_visual_asset_urls ?? null,
            },
          ]
        : [],
    nearby: [],
    hero: {
      id: player.entity_id,
      name: player.display_name,
      statuses: [
        `lvl ${player.current_level}`,
        `${player.current_xp}/${xpForNext} XP`,
      ],
      states: [`hp ${player.current_hp}/${player.max_hp}`],
    },
    inventory: [],
    worldEntities: [],
    quests: [],
    memories: [],
    messages: chatMessagesFromPersisted(persistedMessages),
    actions: [],
    runtimeSlots: [],
    provider: {
      mode: snapshot.authType ?? 'unknown',
      model: snapshot.model ?? 'unknown',
      online: !!snapshot.ready,
    },
    diceRolls: {},
  });
}

export function emptyPatchReport(): engine.PatchReport {
  return engine.PatchReport.createFrom({
    fields: [],
    inventory: [],
    memory: [],
    skipped: [],
    transitions: [],
  });
}

export function appendUserMessage(
  state: engine.GameState,
  text: string,
  opts: {messageId?: number | null; turnIndex?: number | null} = {},
): engine.GameState {
  const next = engine.GameState.createFrom(state);
  const messageId =
    typeof opts.messageId === 'number' && Number.isFinite(opts.messageId)
      ? opts.messageId
      : state.messages.length + 1;
  const turnIndex =
    typeof opts.turnIndex === 'number' && Number.isFinite(opts.turnIndex)
      ? opts.turnIndex
      : state.messages.length + 1;
  if (state.messages.some(message => message.id === messageId)) return next;
  next.messages = [
    ...state.messages,
    engine.ChatMessage.createFrom({
      id: messageId,
      authorId: state.hero?.id ?? 0,
      author: state.hero?.name ?? 'You',
      tone: 'player',
      text,
      turn: turnIndex,
    }),
  ];
  return next;
}

export function updateLastUserMessageText(
  state: engine.GameState,
  originalText: string,
  visibleText: string,
): engine.GameState {
  const original = originalText.trim();
  let target = -1;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (
      message?.tone === 'player' &&
      typeof message.text === 'string' &&
      message.text.trim() === original
    ) {
      target = i;
      break;
    }
  }
  if (target < 0) return state;
  const next = engine.GameState.createFrom(state);
  next.messages = state.messages.map((message, index) =>
    index === target
      ? engine.ChatMessage.createFrom({...message, text: visibleText})
      : message,
  );
  return next;
}

function sanitiseAssistantText(text: string): string {
  let value = text;
  value = value.replace(
    /^[ \t]*#{1,6}[ \t]*\[?(stanislavski|internal|analysis|actor|director|ooc|meta)[^\n]*\]?[ \t]*\n?/gim,
    '',
  );
  const labels = [
    'Given Circumstances',
    'Emotional Memory',
    'Magic If',
    'Subtext',
    'Motive',
    'Beat',
    'Stakes',
    'Internal',
    'OOC',
    "Director(?:'s)? note",
  ].join('|');
  value = value.replace(
    new RegExp(`^[ \\t]*\\*\\*(${labels})\\*\\*[ \\t]*[:.\\-—][^\\n]*\\n?`, 'gim'),
    '',
  );
  value = value.replace(
    new RegExp(`^[ \\t]*(${labels})[ \\t]*[:.\\-—][^\\n]*\\n?`, 'gim'),
    '',
  );
  value = value.replace(/\[(OOC|Internal|Meta|Director|Actor)[^\]]*\][^\n]*\n?/gi, '');
  const paragraphs = value.split(/\n{2,}/);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const paragraph of paragraphs) {
    const key = paragraph.trim().toLowerCase();
    if (key.length === 0) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(paragraph.trim());
  }
  return kept.join('\n\n').trim();
}

export function appendAssistantMessage(
  state: engine.GameState,
  rawText: string,
  meta?: NarrateMeta,
  dice?: PersistedDice[],
): engine.GameState {
  const text = sanitiseAssistantText(rawText);
  if (!text) return state;
  const next = engine.GameState.createFrom(state);
  const newMessageId =
    typeof meta?.messageId === 'number' && meta.messageId > 0
      ? meta.messageId
      : state.messages.length + 1;
  next.messages = [
    ...state.messages,
    engine.ChatMessage.createFrom({
      id: newMessageId,
      authorId: meta?.authorId ?? state.focusEntity?.id ?? 0,
      author: meta?.author || state.focusEntity?.name || 'narrator',
      tone: meta?.tone ?? 'npc',
      text,
      turn: meta?.turnIndex ?? newMessageId,
    }),
  ];
  if (dice && dice.length > 0) {
    __emit('dice:persisted', {messageId: newMessageId, dice});
  }
  if (meta?.mentions?.length) {
    const knownLoc = new Set(
      (state.locations ?? []).map(location => `${location.id}:${location.name}`),
    );
    const knownWorld = new Set(
      (state.worldEntities ?? []).map(entity => `${entity.id}:${entity.name}`),
    );
    const newLocations = [...(state.locations ?? [])];
    const newWorld = [...(state.worldEntities ?? [])];
    for (const mention of meta.mentions) {
      const key = `${mention.id}:${mention.name}`;
      if (mention.kind === 'location' || mention.kind === 'district') {
        if (knownLoc.has(key)) continue;
        newLocations.push(
          engine.LocationSummary.createFrom({
            id: mention.id,
            name: mention.name,
            status: 'mentioned',
            unread: 0,
          }),
        );
        knownLoc.add(key);
      } else {
        if (knownWorld.has(key)) continue;
        newWorld.push(
          engine.EntityCard.createFrom({
            id: mention.id,
            type: mention.kind,
            name: mention.name,
            summary: '',
            status: [],
            state: [],
            tags: [mention.kind],
          }),
        );
        knownWorld.add(key);
      }
    }
    next.locations = newLocations;
    next.worldEntities = newWorld;
  }
  return next;
}
