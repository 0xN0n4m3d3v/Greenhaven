// Spec 139 v2 — TG-style composer.
//
//  ┌────────────────────────────────────────────────────────┐
//  │ ↳ Replying to Mikka Quickgrin                       ×  │  ← chip (inside)
//  │   — А, свежий человек. — Гоблинша поднимает...         │
//  ├────────────────────────────────────────────────────────┤
//  │ Скажи что-нибудь...                                    │  ← textarea
//  └────────────────────────────────────────────────────────┘
//
// Enter — send. Shift+Enter — newline. No dedicated send button (the
// player presses Enter as in any modern messenger).

import {useEffect, useRef, type FormEvent, type KeyboardEvent, type RefObject} from 'react';
import {CornerDownRight, X} from 'lucide-react';
import {useMentionAutocomplete} from '../../hooks/useMentionAutocomplete';
import type {MentionTarget} from '../../types/app';
import type {PersonRegistry} from '../../hooks/usePersonRegistry';
import {parseQuotePrefix} from '../../lib/quotePrefix';

interface Props {
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  onSubmit: (e: FormEvent) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  t: (key: string) => string;
  mentionTargets: MentionTarget[];
  personRegistry: PersonRegistry;
}

const TYPE_GLYPH: Record<string, string> = {
  person: '✦',
  location: '⌂',
  district: '⌂',
  scene: '⌂',
  item: '◆',
  entity: '·',
};

const TYPE_LABEL: Record<string, string> = {
  person: 'NPC',
  location: 'place',
  district: 'place',
  scene: 'scene',
  item: 'item',
  entity: 'entity',
};

// Auto-resize the textarea to fit its content up to ~5 visual lines.
const MAX_VISIBLE_LINES = 5;
const LINE_HEIGHT_PX = 21;

function useAutoResize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = LINE_HEIGHT_PX * MAX_VISIBLE_LINES + 16; // padding
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }, [ref, value]);
}

export function ChatComposer({
  draft,
  setDraft,
  busy,
  onSubmit,
  composerRef,
  t,
  mentionTargets,
  personRegistry,
}: Props) {
  const tx = (key: string, fallback: string) => {
    const v = t(key);
    return v === key ? fallback : v;
  };
  const formRef = useRef<HTMLFormElement | null>(null);
  const auto = useMentionAutocomplete({
    draft,
    setDraft,
    inputRef: composerRef,
    mentionTargets,
  });

  // Spec 139 v2 — quote prefix parsing for the reply chip.
  const reply = parseQuotePrefix(draft);
  const cancelReply = () => {
    if (reply) setDraft(reply.body);
  };

  // Auto-resize textarea so it grows up to 5 visible lines, then scrolls.
  const visibleValue = reply ? reply.body : draft;
  useAutoResize(composerRef, visibleValue);

  // Enter → submit (unless Shift held, then newline). Esc → cancel reply.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (auto.open && auto.items.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        auto.setActiveIndex((auto.activeIndex + 1) % auto.items.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        auto.setActiveIndex(
          (auto.activeIndex - 1 + auto.items.length) % auto.items.length,
        );
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        auto.accept();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        auto.dismiss();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (busy || draft.trim() === '') return;
      formRef.current?.requestSubmit();
      return;
    }
    if (event.key === 'Escape' && reply) {
      event.preventDefault();
      cancelReply();
    }
  }

  return (
    <footer className="action-dock">
      <form ref={formRef} className="composer composer--tg" onSubmit={onSubmit}>
        {auto.open && (
          <div className="composer-mention-picker" role="listbox">
            <div className="composer-mention-picker-header">
              <span>{tx('sessions.mention.label', 'mention')}</span>
              <span className="composer-mention-picker-hint">
                @{auto.trigger?.query || tx('sessions.mention.empty', '…')}
              </span>
            </div>
            <ul className="composer-mention-picker-list">
              {auto.items.map((target, idx) => {
                const isPerson = (target.type ?? '').toLowerCase() === 'person';
                const record = isPerson ? personRegistry?.get?.(target.id) : null;
                const hueRaw = record?.persona_hue;
                const hueColor = hueRaw
                  ? `hsl(${hueRaw}, 55%, 55%)`
                  : 'hsl(var(--ember))';
                const initial = target.name.slice(0, 1).toUpperCase();
                const type = (target.type ?? 'entity').toLowerCase();
                const glyph = TYPE_GLYPH[type] ?? TYPE_GLYPH.entity;
                const typeLabel = TYPE_LABEL[type] ?? TYPE_LABEL.entity;
                return (
                  <li
                    key={`${target.type}-${target.id}-${target.name}`}
                    role="option"
                    aria-selected={idx === auto.activeIndex}
                    className={idx === auto.activeIndex ? 'active' : ''}
                    onMouseEnter={() => auto.setActiveIndex(idx)}
                    onMouseDown={e => {
                      e.preventDefault();
                      auto.accept(target);
                    }}
                  >
                    <span
                      className="composer-mention-picker-avatar"
                      style={{borderColor: hueColor}}
                    >
                      {isPerson ? initial : glyph}
                    </span>
                    <span className="composer-mention-picker-name">{target.name}</span>
                    <span className="composer-mention-picker-type">{typeLabel}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {reply && (
          <div className="composer-reply-preview" role="status">
            <CornerDownRight size={14} className="composer-reply-icon" />
            <div className="composer-reply-text">
              <div className="composer-reply-author">
                {tx('ui.composer.replying_to', 'Replying to')} {reply.author}
              </div>
              <div className="composer-reply-snippet">{reply.text}</div>
            </div>
            <button
              type="button"
              className="composer-reply-cancel"
              aria-label={tx('ui.composer.cancel_reply', 'Cancel reply')}
              onClick={cancelReply}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <textarea
          className="composer-input"
          rows={1}
          ref={composerRef}
          value={visibleValue}
          onChange={event => {
            const next = event.target.value;
            if (reply) setDraft(reply.prefix + next);
            else setDraft(next);
          }}
          onKeyDown={onKeyDown}
          placeholder={busy ? t('ui.action_dock.placeholder_busy') : t('ui.action_dock.placeholder_idle')}
        />
        {/* No submit button — Enter sends, Shift+Enter newline. The form
            still has onSubmit so a hidden synthetic submit works. */}
      </form>
    </footer>
  );
}
