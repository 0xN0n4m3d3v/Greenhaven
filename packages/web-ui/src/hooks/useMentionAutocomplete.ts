import {useCallback, useEffect, useMemo, useState} from 'react';
import type {RefObject} from 'react';
import type {MentionTarget} from '../types/app';

export interface MentionTrigger {
  /** Cursor position where the `@` is. */
  start: number;
  /** Lowercase text typed after `@`. */
  query: string;
}

interface Options {
  draft: string;
  setDraft: (next: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  mentionTargets: MentionTarget[];
  maxResults?: number;
}

export interface MentionAutocompleteState {
  open: boolean;
  trigger: MentionTrigger | null;
  items: MentionTarget[];
  activeIndex: number;
  setActiveIndex: (idx: number) => void;
  accept: (target?: MentionTarget) => void;
  dismiss: () => void;
}

const DEFAULT_MAX = 8;

/**
 * Detects an `@` followed by name characters at the caret of a text
 * input and exposes a filtered list of matching mention targets plus
 * keyboard handlers. The consumer renders the dropdown UI itself —
 * this hook owns no markup.
 *
 * Behavior:
 *   - The trigger opens when the caret sits inside `@...` with no
 *     whitespace between the `@` and the caret. Whitespace dismisses.
 *   - Items are sorted: prefix match > word-prefix > substring > rest.
 *   - Arrow keys / Enter / Tab / Escape are intercepted on the input
 *     while the dropdown is open. Enter and Tab insert the active item;
 *     Escape dismisses without inserting.
 *   - Accepting replaces the `@<query>` fragment with `@<FullName> `
 *     (trailing space) and restores focus + caret position.
 */
export function useMentionAutocomplete({
  draft,
  setDraft,
  inputRef,
  mentionTargets,
  maxResults = DEFAULT_MAX,
}: Options): MentionAutocompleteState {
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Detect / refresh the trigger whenever draft, caret, or focus moves.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const update = () => {
      setTrigger(detectTrigger(draft, input.selectionStart ?? draft.length));
    };
    update();
    input.addEventListener('keyup', update);
    input.addEventListener('click', update);
    input.addEventListener('focus', update);
    return () => {
      input.removeEventListener('keyup', update);
      input.removeEventListener('click', update);
      input.removeEventListener('focus', update);
    };
  }, [draft, inputRef]);

  const items = useMemo<MentionTarget[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const tier = (target: MentionTarget) => {
      const name = target.name.toLowerCase();
      if (q === '') return 0;
      if (name.startsWith(q)) return 1;
      if (name.includes(' ' + q)) return 2;
      if (name.includes(q)) return 3;
      return 4;
    };
    return [...mentionTargets]
      .map(target => ({target, tier: tier(target)}))
      .filter(({tier}) => tier < 4 || trigger.query === '')
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return a.target.name.localeCompare(b.target.name);
      })
      .slice(0, maxResults)
      .map(({target}) => target);
  }, [trigger, mentionTargets, maxResults]);

  // Reset active index when results change.
  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.query, items.length]);

  const accept = useCallback(
    (target?: MentionTarget) => {
      const chosen = target ?? items[activeIndex];
      if (!trigger || !chosen) return;
      const before = draft.slice(0, trigger.start);
      const afterIndex = trigger.start + 1 + trigger.query.length;
      const after = draft.slice(afterIndex);
      const replacement = `@${chosen.name} `;
      const next = before + replacement + after;
      setDraft(next);
      const caret = before.length + replacement.length;
      const input = inputRef.current;
      window.setTimeout(() => {
        if (!input) return;
        input.focus();
        try {
          input.setSelectionRange(caret, caret);
        } catch {
          /* setSelectionRange unsupported on this input type */
        }
      }, 0);
      setTrigger(null);
    },
    [trigger, items, activeIndex, draft, setDraft, inputRef],
  );
  const dismiss = useCallback(() => setTrigger(null), []);

  return {
    open: !!trigger && items.length > 0,
    trigger,
    items,
    activeIndex,
    setActiveIndex,
    accept,
    dismiss,
  };
}

function detectTrigger(text: string, caret: number): MentionTrigger | null {
  if (caret < 1) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === undefined) return null;
    if (ch === '@') {
      const prev = i > 0 ? text[i - 1] ?? '' : '';
      if (i === 0 || /\s/.test(prev)) {
        const query = text.slice(i + 1, caret);
        if (/\s/.test(query)) return null;
        return {start: i, query: query.toLowerCase()};
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}
