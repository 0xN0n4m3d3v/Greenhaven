import { CheckCircle2, CircleX, Compass } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AcceptPlayerAdventure, IgnorePlayerAdventure } from '../../bridge/api';
import type {
  PersonRecord,
  PersonRegistry,
} from '../../hooks/usePersonRegistry';
import { renderRichMessage } from '../../lib/mentions';
import type { MentionTarget } from '../../types/app';
import { Portrait } from '../npc/Portrait';
import type { SystemEvent, Translator } from './EventCardTypes';
import { PersonaBubble } from './PersonaBubble';

export type AdventureTerminalStatus = 'accepted' | 'ignored' | 'expired';

export interface AdventureEventContext {
  mentionTargets?: MentionTarget[];
  onMention?: (target: MentionTarget) => void;
  personRegistry?: PersonRegistry;
  terminalStatus?: AdventureTerminalStatus | null;
  suppressTerminalCard?: boolean;
  busy?: boolean;
  onAcceptAdventure?: (
    message: string,
    actionId: string,
  ) => void | Promise<void>;
  onIgnoreAdventure?: (
    message: string,
    actionId: string,
  ) => void | Promise<void>;
}

interface AdventureSpeaker {
  id: number | null;
  name: string;
  record: PersonRecord | null;
}

function formatDanger(value: unknown): string {
  const danger = String(value ?? 'safe');
  switch (danger) {
    case 'deadly':
      return 'deadly';
    case 'risky':
      return 'risky';
    default:
      return 'safe';
  }
}

function formatRewardHint(value: unknown, tr: Translator): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reward = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof reward['xp'] === 'number' && reward['xp'] > 0) {
    parts.push(`+${reward['xp']} XP`);
  }
  const strings = reward['strings'];
  if (Array.isArray(strings) && strings.length > 0) {
    parts.push(
      tr('ui.event_card.reward.bond_shift_count', { n: strings.length }),
    );
  }
  return parts.length > 0 ? parts.join(' / ') : null;
}

function readPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function textMentionsName(text: string, name: string): boolean {
  const haystack = normalizeSearchText(text);
  const fullName = normalizeSearchText(name);
  if (!haystack || !fullName) return false;
  if (haystack.includes(fullName)) return true;
  const firstName = fullName.split(' ')[0] ?? '';
  return firstName.length > 2 && haystack.includes(firstName);
}

function resolveAdventureSpeaker(
  payload: Record<string, unknown>,
  context: AdventureEventContext | undefined,
  t: Translator,
): AdventureSpeaker {
  const speakerId =
    readPositiveInt(payload['speakerEntityId']) ??
    readPositiveInt(payload['giverEntityId']) ??
    readPositiveInt(payload['sourceEntityId']);
  const registryRecord =
    speakerId != null
      ? (context?.personRegistry?.get(speakerId) ?? null)
      : null;
  const payloadName =
    typeof payload['speakerName'] === 'string' && payload['speakerName'].trim()
      ? payload['speakerName'].trim()
      : null;
  if (speakerId != null || payloadName) {
    return {
      id: speakerId,
      name:
        registryRecord?.name ??
        payloadName ??
        t('ui.event_card.header.adventure.hook'),
      record: registryRecord,
    };
  }

  const title = String(payload['title'] ?? '');
  const hook = String(payload['playerFacingHook'] ?? payload['summary'] ?? '');
  const searchable = `${title}\n${hook}`;
  for (const record of context?.personRegistry?.values() ?? []) {
    if (textMentionsName(searchable, record.name)) {
      return { id: record.id, name: record.name, record };
    }
  }
  for (const target of context?.mentionTargets ?? []) {
    if ((target.type ?? '').toLowerCase() !== 'person') continue;
    if (textMentionsName(searchable, target.name)) {
      return { id: target.id, name: target.name, record: null };
    }
  }

  return {
    id: null,
    name: t('ui.event_card.header.adventure.hook'),
    record: null,
  };
}

function speakerAvatar(speaker: AdventureSpeaker) {
  if (speaker.id != null && speaker.id > 0) {
    return (
      <Portrait
        npcId={speaker.id}
        name={speaker.name}
        portraitSet={speaker.record?.portrait_set ?? undefined}
        size="sm"
      />
    );
  }
  return (
    <span className="adventure-hook-avatar-fallback" aria-hidden="true">
      <Compass size={14} />
    </span>
  );
}

function AdventureActionButtons({
  event,
  t,
  variant = 'card',
  terminalStatus = null,
  context,
}: {
  event: SystemEvent;
  t: Translator;
  variant?: 'card' | 'menu';
  terminalStatus?: AdventureTerminalStatus | null;
  context?: AdventureEventContext;
}) {
  const [state, setState] = useState<
    'idle' | 'busy' | 'accepted' | 'ignored' | 'error'
  >('idle');
  const p = event.payload as Record<string, unknown>;
  const queueId = Number(p['queueId']);
  const playerId = Number(p['playerId']);
  const serverStatus =
    terminalStatus ??
    (String(p['status'] ?? 'ready') === 'accepted'
      ? 'accepted'
      : String(p['status'] ?? 'ready') === 'ignored' ||
          String(p['status'] ?? 'ready') === 'cancelled'
        ? 'ignored'
        : String(p['status'] ?? 'ready') === 'expired'
          ? 'expired'
          : null);
  const disabled =
    context?.busy === true ||
    serverStatus != null ||
    state !== 'idle' ||
    !Number.isInteger(queueId) ||
    !Number.isInteger(playerId) ||
    String(p['status'] ?? 'ready') !== 'ready';

  async function accept() {
    if (disabled) return;
    setState('busy');
    try {
      if (context?.onAcceptAdventure) {
        await context.onAcceptAdventure(
          acceptLabel,
          `adventure.accept:${queueId}`,
        );
        setState('idle');
        return;
      }
      await AcceptPlayerAdventure(playerId, queueId);
      setState('accepted');
    } catch (err) {
      console.warn('[adventure] accept failed', err);
      setState('error');
    }
  }

  async function ignore() {
    if (disabled) return;
    setState('busy');
    try {
      if (context?.onIgnoreAdventure) {
        await context.onIgnoreAdventure(
          ignoreLabel,
          `adventure.ignore:${queueId}`,
        );
        setState('idle');
        return;
      }
      await IgnorePlayerAdventure(playerId, queueId);
      setState('ignored');
    } catch (err) {
      console.warn('[adventure] ignore failed', err);
      setState('error');
    }
  }

  const status =
    serverStatus === 'accepted' || state === 'accepted'
      ? t('ui.event_card.status.accepted')
      : serverStatus === 'ignored' || state === 'ignored'
        ? t('ui.event_card.status.ignored')
        : serverStatus === 'expired'
          ? t('ui.event_card.status.expired')
          : state === 'error'
            ? t('ui.event_card.status.failed')
            : null;
  const acceptLabel = t('ui.event_card.action.accept');
  const ignoreLabel = t('ui.event_card.action.ignore');

  return (
    <div
      className={
        variant === 'menu' ? 'adventure-hook-actions' : 'event-card-actions'
      }
    >
      <button
        type="button"
        onClick={accept}
        disabled={disabled}
        title={acceptLabel}
      >
        <CheckCircle2 size={13} />
        <span>{acceptLabel}</span>
      </button>
      <button
        type="button"
        onClick={ignore}
        disabled={disabled}
        title={ignoreLabel}
      >
        <CircleX size={13} />
        <span>{ignoreLabel}</span>
      </button>
      {status && (
        <span
          className={
            variant === 'menu' ? 'adventure-hook-status' : 'event-card-meta'
          }
        >
          {status}
        </span>
      )}
    </div>
  );
}

function AdventureHookBubble({
  event,
  t,
  context,
}: {
  event: SystemEvent;
  t: Translator;
  context?: AdventureEventContext;
}) {
  const p = event.payload as Record<string, unknown>;
  const title = (p['title'] as string) ?? '?';
  const hook =
    (p['playerFacingHook'] as string) ?? (p['summary'] as string) ?? title;
  const danger = formatDanger(p['danger']);
  const rewardHint = formatRewardHint(p['rewardHint'], t);
  const speaker = resolveAdventureSpeaker(p, context, t);
  const speakerId =
    speaker.id ?? 900_000_000 + (readPositiveInt(p['queueId']) ?? 0);
  const mentionTargets = context?.mentionTargets ?? [];
  const onMention = context?.onMention ?? (() => undefined);
  return (
    <div className="adventure-hook-thread" role="status" aria-live="polite">
      <PersonaBubble
        msg={{
          tone: 'npc',
          author: speaker.name,
          authorId: speakerId,
          persona_hue: speaker.record?.persona_hue ?? null,
          persona_slug: speaker.record?.persona_slug ?? null,
        }}
        side="other"
        className="adventure-hook-bubble"
      >
        <div className="bubble-author">
          {speakerAvatar(speaker)}
          {speaker.name}
        </div>
        <div className="message-rich">
          {renderRichMessage(hook, mentionTargets, onMention)}
        </div>
        <div className="adventure-hook-context">
          <span className="adventure-hook-title">{title}</span>
          <span
            className={`adventure-hook-danger adventure-hook-danger-${danger}`}
          >
            {t(`ui.event_card.danger.${danger}`)}
          </span>
          {rewardHint && (
            <span className="adventure-hook-reward">{rewardHint}</span>
          )}
        </div>
      </PersonaBubble>
      <AdventureActionButtons
        event={event}
        t={t}
        variant="menu"
        terminalStatus={context?.terminalStatus ?? null}
        context={context}
      />
    </div>
  );
}

export function renderAdventureEvent(
  event: SystemEvent,
  t: Translator,
  context?: AdventureEventContext,
): ReactNode | undefined {
  if (event.type === 'adventure:hook') {
    return <AdventureHookBubble event={event} t={t} context={context} />;
  }
  if (
    context?.suppressTerminalCard &&
    (event.type === 'adventure:accepted' ||
      event.type === 'adventure:ignored' ||
      event.type === 'adventure:expired')
  ) {
    return null;
  }
  return undefined;
}

export function renderAdventureBody(
  event: SystemEvent,
  t: Translator,
): ReactNode | undefined {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'adventure:oracle_rolled': {
      const kind =
        (p['adventureKind'] as string) ?? (p['selectedKind'] as string) ?? '?';
      const roll = p['roll'] as number | undefined;
      const die = (p['die'] as string) ?? 'oracle';
      return (
        <>
          <span className="event-card-title">{kind}</span>
          {typeof roll === 'number' && (
            <span className="event-card-meta">
              {' '}
              ({die}: {roll})
            </span>
          )}
        </>
      );
    }
    case 'adventure:hook': {
      const title = (p['title'] as string) ?? '?';
      const hook =
        (p['playerFacingHook'] as string) ?? (p['summary'] as string) ?? '';
      const danger = formatDanger(p['danger']);
      const rewardHint = formatRewardHint(p['rewardHint'], t);
      return (
        <>
          <span className="event-card-title">{title}</span>
          <span className={`event-card-tag event-card-danger-${danger}`}>
            {t(`ui.event_card.danger.${danger}`)}
          </span>
          {hook && <p className="event-card-quote">{hook}</p>}
          {rewardHint && (
            <p className="event-card-meta event-card-meta--stacked">
              {rewardHint}
            </p>
          )}
          <AdventureActionButtons event={event} t={t} />
        </>
      );
    }
    case 'adventure:accepted': {
      const title = (p['title'] as string) ?? '?';
      const danger = formatDanger(p['danger']);
      return (
        <>
          <span className="event-card-title">{title}</span>
          <span className="event-card-outcome success">
            {t('ui.event_card.status.accepted')}
          </span>
          <span className={`event-card-tag event-card-danger-${danger}`}>
            {t(`ui.event_card.danger.${danger}`)}
          </span>
        </>
      );
    }
    case 'adventure:ignored':
    case 'adventure:expired': {
      const title = (p['title'] as string) ?? '?';
      return (
        <>
          <span className="event-card-title">{title}</span>
          <span className="event-card-meta">
            {' '}
            {event.type === 'adventure:expired'
              ? t('ui.event_card.status.expired')
              : t('ui.event_card.status.ignored')}
          </span>
        </>
      );
    }
    default:
      return undefined;
  }
}
