// Spec 29 §A.3 — message-flow loop extracted from App.tsx.
//
// Handles: persisted-dice strips above each non-self bubble; bubble
// motion entrance; left/right click handlers (open BubbleMenu);
// "Continue" button on the last assistant; optimistic-self bubble;
// pending bubble with live dice + typing indicator + error line.

import { Fragment, type ReactNode, type RefObject } from 'react';
import { MessageCircle } from 'lucide-react';

/**
 * Spec 139 v2 — find the player's most recent message in the same turn
 * as the NPC bubble at `npcIndex` (search backwards). Returns
 * {author, text} or null if no match in the same turn. Strips any
 * existing quote-prefix so we don't recurse-quote.
 */
function findRecentPlayerInTurn(
  all: Array<{
    id: number;
    tone: string;
    author: string;
    text: string;
    turn: number;
  }>,
  npcIndex: number,
  turn: number,
): { author: string; text: string } | null {
  for (let i = npcIndex - 1; i >= 0; i--) {
    const m = all[i];
    if (!m) continue;
    if (m.turn !== turn) return null;
    if (m.tone !== 'player') continue;
    const body = m.text.replace(/^> [^:\n]{1,80}: «[\s\S]+?»\r?\n\r?\n/, '');
    const raw = body.replace(/\s+/g, ' ').trim();
    if (!raw) return null;
    const snippet = raw.length > 200 ? raw.slice(0, 200).trimEnd() + '…' : raw;
    return { author: m.author ?? '', text: snippet };
  }
  return null;
}
import { DiceBubble, type DiceRoll } from '../../DiceBubble';
import { renderRichMessage } from '../../lib/mentions';
import { parseQuotePrefix } from '../../lib/quotePrefix';
import { safeArray } from '../../lib/state';
import type {
  GameState,
  MentionTarget,
  TurnJobSnapshot,
} from '../../types/app';
import type { BubbleMenuState } from './BubbleMenu';
import { EventCard, type SystemEvent } from './EventCard';
import type { AdventureTerminalStatus } from './EventCardAdventure';
import { compareSystemEvents } from './eventOrdering';
import { NpcRevealCard } from './NpcRevealCard';
import { PersonaBubble } from './PersonaBubble';
import type { PersonRegistry } from '../../hooks/usePersonRegistry';

export interface MessageFlowProps {
  state: GameState;
  flowRef: RefObject<HTMLDivElement | null>;
  mentionTargets: MentionTarget[];
  diceLog: Record<number, DiceRoll[]>;
  pendingJob: TurnJobSnapshot | null;
  liveDice: DiceRoll[];
  diceRevealed: boolean;
  diceCheckRequested: boolean;
  optimisticUser: string;
  busy: boolean;
  /** Used to colour the per-row left stripe by speaker persona_hue. */
  personRegistry: PersonRegistry;
  t: (key: string, vars?: Record<string, string>) => string;
  setBubbleMenu: (next: BubbleMenuState) => void;
  handleMention: (target: MentionTarget) => void;
  continueScene: () => void;
  onRunAction?: (message: string, actionId: string) => void | Promise<void>;
  /** Spec 139 v2 — Reply action invoked from the hover-icon on each
   *  non-player bubble. Composer should pre-fill with a quoted line. */
  onReplyTo?: (message: { id: number; author: string; text: string }) => void;
  // Spec 31 §A.1 — render-prop for streaming tokens animation in the
  // pending bubble. App.tsx provides <StreamingTokens animated={…}>;
  // when omitted, fall back to renderRichMessage.
  renderPendingText?: (text: string) => ReactNode;
  // Spec 32 §A.1 — render-prop for the bubble's author slot. App.tsx
  // returns <Portrait size="sm" …> for tone='npc' bubbles, falsy
  // for everything else (default <MessageCircle> kicks in).
  renderBubbleAuthor?: (message: {
    tone: string;
    authorId: number;
    author: string;
  }) => ReactNode;
  // Spec 32 §A.3 — render-prop for the pending bubble's typing
  // indicator. App.tsx returns <PersonaTypingIndicator persona={…}>;
  // omitted → original three-dot bouncer.
  renderPendingTypingIndicator?: () => ReactNode;
  // Spec 38 follow-up — system event cards (memory captured, quest
  // issued, strings shifted, damage dealt). Interleaved between
  // bubbles by timestamp; new events stream in via SSE.
  systemEvents?: SystemEvent[];
}

const HIDDEN_TIMELINE_EVENT_TYPES = new Set<string>(['adventure:oracle_rolled']);

function eventFlowKey(event: SystemEvent): string {
  return `event:${event.eventId ?? event.id}`;
}

function visibleTimelineEvent(event: SystemEvent): boolean {
  return !HIDDEN_TIMELINE_EVENT_TYPES.has(event.type);
}

export function MessageFlow({
  state,
  flowRef,
  mentionTargets,
  diceLog,
  pendingJob,
  liveDice,
  diceRevealed,
  diceCheckRequested,
  optimisticUser,
  busy,
  personRegistry,
  t,
  handleMention,
  onRunAction,
  onReplyTo,
  renderPendingText,
  renderBubbleAuthor,
  systemEvents,
}: MessageFlowProps) {
  // Inner-voice whispers removed 2026-05-14.
  const all = safeArray(state.messages) as Array<{
    id: number;
    tone: string;
    author: string;
    authorId: number;
    text: string;
    turn: number;
  }>;
  const isPlayer = (m: { tone: string } | null | undefined) =>
    !!m && m.tone === 'player';

  // Spec 139 v2 — first NPC encounter card. The first time an NPC
  // appears in the chat (in this loaded session), insert a tall portrait
  // reveal card just before the bubble. Tracked by authorId across the
  // visible chat history.
  const firstNpcMessageIds = new Set<number>();
  const seenNpcAuthors = new Set<number>();
  for (const m of all) {
    if (m.tone !== 'npc' || m.authorId <= 0) continue;
    if (seenNpcAuthors.has(m.authorId)) continue;
    seenNpcAuthors.add(m.authorId);
    firstNpcMessageIds.add(m.id);
  }

  const readNumber = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const adventureHookQueueIds = new Set<number>();
  const adventureTerminalByQueueId = new Map<number, AdventureTerminalStatus>();
  for (const ev of systemEvents ?? []) {
    const queueId = readNumber(ev.payload?.queueId);
    if (queueId == null) continue;
    if (ev.type === 'adventure:hook') {
      adventureHookQueueIds.add(queueId);
      continue;
    }
    if (ev.type === 'adventure:accepted') {
      adventureTerminalByQueueId.set(queueId, 'accepted');
    } else if (ev.type === 'adventure:ignored') {
      adventureTerminalByQueueId.set(queueId, 'ignored');
    } else if (ev.type === 'adventure:expired') {
      adventureTerminalByQueueId.set(queueId, 'expired');
    }
  }

  const adventureContextFor = (ev: SystemEvent) => {
    const queueId = readNumber(ev.payload?.queueId);
    const isTerminalAdventure =
      ev.type === 'adventure:accepted' ||
      ev.type === 'adventure:ignored' ||
      ev.type === 'adventure:expired';
    return {
      mentionTargets,
      onMention: handleMention,
      personRegistry,
      busy,
      onAcceptAdventure: onRunAction,
      onIgnoreAdventure: onRunAction,
      terminalStatus:
        ev.type === 'adventure:hook' && queueId != null
          ? (adventureTerminalByQueueId.get(queueId) ?? null)
          : null,
      suppressTerminalCard:
        isTerminalAdventure &&
        queueId != null &&
        adventureHookQueueIds.has(queueId),
    };
  };

  const sceneContextFor = (_ev: SystemEvent) => ({
    busy,
    onChooseSceneOption: onRunAction,
  });

  // Spec 103 — system events are standalone timeline items, never a
  // bottom stack. The message id / turn index is an ordering key only:
  // mutation/pre-response cards can sit before the bubble, while
  // post-response cards such as adventure offers sit after the bubble
  // that caused them.
  const eventsBeforeMessage = new Map<number, SystemEvent[]>();
  const eventsAfterMessage = new Map<number, SystemEvent[]>();
  const standaloneEvents: SystemEvent[] = [];
  const pendingTurnId = pendingJob?.id ?? null;
  const messageById = new Map(all.map((message) => [message.id, message]));
  const assistantMessageIdByTurn = new Map<number, number>();
  for (const message of all) {
    if (!isPlayer(message) && !assistantMessageIdByTurn.has(message.turn)) {
      assistantMessageIdByTurn.set(message.turn, message.id);
    }
  }
  for (const ev of systemEvents ?? []) {
    const directMessageId = readNumber(ev.messageId);
    const eventTurnIndex = readNumber(ev.payload?.turnIndex);
    const placeAfter =
      ev.type.startsWith('adventure:') ||
      ev.type.startsWith('quest:') ||
      ev.type.startsWith('quest_pacer:') ||
      ev.payload?.lane === 'post_response' ||
      ev.payload?.phase === 'post_turn';
    const requiresAssistantAnchor = placeAfter;
    const directMessage =
      directMessageId != null ? messageById.get(directMessageId) : undefined;
    let timelineMessageId: number | null = null;
    if (directMessage) {
      if (!requiresAssistantAnchor || !isPlayer(directMessage)) {
        timelineMessageId = directMessage.id;
      }
    }
    if (timelineMessageId == null && eventTurnIndex != null) {
      timelineMessageId = assistantMessageIdByTurn.get(eventTurnIndex) ?? null;
    }
    if (requiresAssistantAnchor && timelineMessageId == null) {
      continue;
    }
    if (timelineMessageId != null) {
      const target = placeAfter ? eventsAfterMessage : eventsBeforeMessage;
      const bucket = target.get(timelineMessageId) ?? [];
      bucket.push(ev);
      target.set(timelineMessageId, bucket);
    } else if (pendingTurnId && ev.turnId === pendingTurnId) {
      // Do not render current-turn system cards before the assistant
      // bubble exists. Mutation tools can emit quest/adventure cards
      // seconds before narrate(), and showing them here places the
      // mechanical result above the NPC prose that caused it. Once
      // narrate/turn.end exposes messageId, system:turn_message_known
      // attaches the event and the normal before/after buckets render it.
      continue;
    } else {
      standaloneEvents.push(ev);
    }
  }

  // Pre-compute "this row continues the previous speaker" so the CSS
  // can collapse the author label and tighten the gap on consecutive
  // messages — the Slack/Discord/Telegram pattern that turns a wall of
  // bubbles into a readable thread.
  const groupedFlags = new Array<boolean>(all.length).fill(false);
  for (let i = 1; i < all.length; i += 1) {
    const prev = all[i - 1];
    const cur = all[i];
    if (!prev || !cur) continue;
    if (isPlayer(prev) || isPlayer(cur)) continue;
    if (prev.tone !== cur.tone) continue;
    if (prev.authorId !== cur.authorId) continue;
    if (prev.author !== cur.author) continue;
    groupedFlags[i] = true;
  }

  return (
    <div className="message-flow" ref={flowRef}>
      {standaloneEvents
        .filter(visibleTimelineEvent)
        .sort(compareSystemEvents)
        .map((ev) => (
          <div
            key={ev.id}
            data-flow-item-key={eventFlowKey(ev)}
            data-flow-item-kind="event"
          >
            <EventCard
              event={ev}
              adventureContext={adventureContextFor(ev)}
              sceneContext={sceneContextFor(ev)}
            />
          </div>
        ))}
      {all.map((message, index) => {
        const isSelf = isPlayer(message);
        const sideClass = isSelf ? 'self' : 'other';
        const grouped = groupedFlags[index] === true;
        const speakerRecord =
          message.authorId > 0 ? personRegistry?.get?.(message.authorId) : null;
        const personaHue = speakerRecord?.persona_hue;
        const personaColor = personaHue
          ? `hsl(${personaHue}, 55%, 55%)`
          : undefined;
        const persistedRolls = !isSelf ? (diceLog[message.id] ?? []) : [];
        const isNpcBubble = message.tone === 'npc' && message.authorId > 0;
        return (
          <Fragment key={message.id}>
            {/* Spec 139 v2 — first time this NPC appears in chat, drop a
                tall portrait reveal card. Once-per-NPC for the loaded
                session. */}
            {firstNpcMessageIds.has(message.id) && speakerRecord && (
              <div
                data-flow-item-key={`npc-reveal:${message.id}`}
                data-flow-item-kind="image"
              >
                <NpcRevealCard
                  npcId={message.authorId}
                  name={message.author}
                  portraitSet={speakerRecord.portrait_set ?? null}
                  accent={personaColor}
                />
              </div>
            )}
            {/* Inline event cards that fired during the turn that
                produced THIS message. Rendered BEFORE the bubble so
                they sit as standalone timeline items between the
                previous message and this one. */}
            {(eventsBeforeMessage.get(message.id) ?? [])
              .filter(visibleTimelineEvent)
              .sort(compareSystemEvents)
              .map((ev) => (
                <div
                  key={ev.id}
                  data-flow-item-key={eventFlowKey(ev)}
                  data-flow-item-kind="event"
                >
                  <EventCard
                    event={ev}
                    adventureContext={adventureContextFor(ev)}
                    sceneContext={sceneContextFor(ev)}
                  />
                </div>
              ))}
            {persistedRolls.length > 0 && (
              <div
                className={`dice-strip ${sideClass}`}
                data-flow-item-key={`dice:${message.id}`}
                data-flow-item-kind="dice"
              >
                {persistedRolls.map((d, i) => (
                  <div
                    key={`dice-${message.id}-${i}`}
                    className={`dice-strip-row ${d.roller === 'npc' ? 'npc' : 'player'} ${d.outcome ?? ''}`}
                  >
                    <span className="dice-strip-d">d20</span>
                    <span className="dice-strip-roll">{d.roll}</span>
                    {d.dc != null && (
                      <span className="dice-strip-dc">
                        {t('dice.vs_dc')} {d.dc}
                      </span>
                    )}
                    {d.outcome && (
                      <span className={`dice-strip-outcome ${d.outcome}`}>
                        {d.outcome === 'success'
                          ? t('dice.success')
                          : t('dice.failure')}
                      </span>
                    )}
                    {d.description && (
                      <span className="dice-strip-label">{d.description}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <PersonaBubble
              msg={message as never}
              side={sideClass as 'self' | 'other'}
              className={isNpcBubble ? 'clickable' : ''}
              data-flow-item-key={`message:${message.id}`}
              data-flow-item-kind={isSelf ? 'player' : 'message'}
              data-grouped={grouped ? 'true' : undefined}
              style={
                personaColor
                  ? ({ '--persona-color': personaColor } as React.CSSProperties)
                  : undefined
              }
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: Math.min(index * 0.02, 0.18) }}
              // Spec 139 v2 — no click-popup-menu. Native text selection
              // and the browser's right-click menu work as in any
              // messenger. Hover reveals a `Reply` icon on non-player
              // bubbles via .bubble-reply-action below.
            >
              <div className="bubble-author">
                {renderBubbleAuthor?.(message) ?? <MessageCircle size={15} />}
                {message.author}
              </div>
              {(() => {
                // Spec 139 v2 — render the quote prefix (if any) as a
                // styled reply-card above the message body. If no
                // explicit quote is present in the broker's text, but
                // this is an NPC bubble that comes after a player
                // message in this turn, auto-quote the player's last
                // message so the chat reads as a reply chain.
                const parsed = parseQuotePrefix(message.text);
                if (parsed) {
                  return (
                    <>
                      <div className="bubble-quote-card">
                        <div className="bubble-quote-author">
                          {parsed.author}
                        </div>
                        <div className="bubble-quote-text">{parsed.text}</div>
                      </div>
                      <div className="message-rich">
                        {renderRichMessage(
                          parsed.body,
                          mentionTargets,
                          handleMention,
                        )}
                      </div>
                    </>
                  );
                }
                // Auto-quote: only on non-player bubbles, only when
                // there is a recent player message in the SAME turn
                // (so we don't quote across multiple turns).
                const autoQuote = !isSelf
                  ? findRecentPlayerInTurn(all, index, message.turn)
                  : null;
                return (
                  <>
                    {autoQuote && (
                      <div className="bubble-quote-card bubble-quote-card--auto">
                        <div className="bubble-quote-author">
                          {autoQuote.author || t('ui.you') || 'You'}
                        </div>
                        <div className="bubble-quote-text">
                          {autoQuote.text}
                        </div>
                      </div>
                    )}
                    <div className="message-rich">
                      {renderRichMessage(
                        message.text,
                        mentionTargets,
                        handleMention,
                      )}
                    </div>
                  </>
                );
              })()}
              {!isSelf && onReplyTo && (
                <button
                  type="button"
                  className="bubble-reply-action"
                  aria-label={t('ui.bubble_menu.reply')}
                  title={t('ui.bubble_menu.reply')}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onReplyTo({
                      id: message.id,
                      author: message.author ?? '',
                      text: message.text ?? '',
                    });
                  }}
                >
                  <MessageCircle size={13} />
                </button>
              )}
            </PersonaBubble>
            {(eventsAfterMessage.get(message.id) ?? [])
              .filter(visibleTimelineEvent)
              .sort(compareSystemEvents)
              .map((ev) => (
                <div
                  key={ev.id}
                  data-flow-item-key={eventFlowKey(ev)}
                  data-flow-item-kind="event"
                >
                  <EventCard
                    event={ev}
                    adventureContext={adventureContextFor(ev)}
                    sceneContext={sceneContextFor(ev)}
                  />
                </div>
              ))}
          </Fragment>
        );
      })}
      {pendingJob &&
        optimisticUser &&
        !(
          safeArray(state.messages) as Array<{ authorId: number; text: string }>
        ).some(
          (m) =>
            m &&
            m.authorId === (state.hero?.id ?? 0) &&
            typeof m.text === 'string' &&
            m.text.trim() === optimisticUser.trim(),
        ) && (
          <PersonaBubble
            msg={{ tone: 'player', author: t('ui.hero.name') }}
            side="self"
            className="optimistic"
            data-flow-item-key="optimistic-player"
            data-flow-item-kind="player"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
          >
            <div className="bubble-author">
              <MessageCircle size={15} />
              {t('ui.hero.name')}
            </div>
            <div className="message-rich">
              {renderRichMessage(optimisticUser, mentionTargets, handleMention)}
            </div>
          </PersonaBubble>
        )}
      {pendingJob?.status === 'queued' && (
        <div className="turn-queued-status" role="status">
          {t('ui.pending.queued')}
        </div>
      )}
      {pendingJob && pendingJob.status !== 'queued' && (
        <>
          {liveDice.length > 0
            ? liveDice.map((d, i) => (
                <div
                  key={`live-${i}`}
                  data-flow-item-key={`live-dice:${i}`}
                  data-flow-item-kind="dice"
                >
                  <DiceBubble
                    state={diceRevealed ? 'rolled' : 'rolling'}
                    roll={diceRevealed ? d : null}
                  />
                </div>
              ))
            : diceCheckRequested && (
                <div
                  data-flow-item-key="dice-check:pending"
                  data-flow-item-kind="dice"
                >
                  <DiceBubble state="rolling" roll={null} />
                </div>
              )}
          {/* Pending render: only show the bubble once prose is actually
              streaming or an error has landed. The "still composing"
              state is communicated by the floating TypingPulse below
              the message-flow (rendered by GameScreen), not by an
              empty bubble — modern messengers (Telegram/WhatsApp/
              iMessage) all keep the typing indicator outside message
              space. */}
          {(pendingJob.text || pendingJob.error) && (
            <PersonaBubble
              msg={{ tone: 'narrator' }}
              side="other"
              className={`pending ${pendingJob.status === 'error' ? 'failed' : ''}`}
              data-flow-item-key={`pending:${pendingJob.id}`}
              data-flow-item-kind="pending"
              animate={{ opacity: 1, y: 0, scale: 1 }}
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
            >
              {pendingJob.text && (
                <div className="message-rich">
                  {renderPendingText
                    ? renderPendingText(pendingJob.text)
                    : renderRichMessage(
                        pendingJob.text,
                        mentionTargets,
                        handleMention,
                      )}
                </div>
              )}
              {pendingJob.error && (
                <p className="pending-error">{pendingJob.error}</p>
              )}
            </PersonaBubble>
          )}
        </>
      )}
    </div>
  );
}
