// Spec 31 chat scroll hook. The legacy mode keeps bottom-stick
// behavior for generic callers. The chat timeline mode is stricter:
// after a player turn starts, scroll once to the first new non-player
// timeline item, then stop until the player acts again.

import {useEffect, useLayoutEffect, useRef} from 'react';

interface TimelineItem {
  key: string;
  kind: string;
  node: HTMLElement;
}

export function useAutoScroll<T extends HTMLElement>(
  deps: ReadonlyArray<unknown>,
  opts: {smooth?: boolean; turnKey?: string | null} = {},
) {
  const ref = useRef<T | null>(null);
  const userScrolledUp = useRef(false);
  const mounted = useRef(false);
  const lastTurnKey = useRef<string | null>(null);
  const baselineItemKeys = useRef<Set<string>>(new Set());
  const awaitingFirstPostPlayerItem = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = distanceFromBottom > 80;
    };
    el.addEventListener('scroll', onScroll, {passive: true});
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const turnKey = opts.turnKey ?? null;
    const timelineMode = turnKey !== null;
    const behavior = opts.smooth ? 'smooth' : 'auto';

    if (!timelineMode) {
      if (userScrolledUp.current) return;
      el.scrollTo({top: el.scrollHeight, behavior});
      return;
    }

    const items = timelineItems(el);
    const keySet = new Set(items.map(item => item.key));

    if (!mounted.current) {
      mounted.current = true;
      lastTurnKey.current = turnKey;
      baselineItemKeys.current = keySet;
      el.scrollTo({top: el.scrollHeight, behavior: 'auto'});
      return;
    }

    const turnChanged = turnKey !== lastTurnKey.current;
    if (turnChanged) {
      const previousKeys = baselineItemKeys.current;
      lastTurnKey.current = turnKey;
      baselineItemKeys.current = keySet;
      const target = firstNewNonPlayerItem(items, previousKeys);
      if (target) {
        scrollTimelineItemIntoView(el, target, behavior);
        awaitingFirstPostPlayerItem.current = false;
        return;
      }
      el.scrollTo({top: el.scrollHeight, behavior});
      awaitingFirstPostPlayerItem.current = true;
      return;
    }

    if (awaitingFirstPostPlayerItem.current) {
      const target = firstNewNonPlayerItem(items, baselineItemKeys.current);
      baselineItemKeys.current = keySet;
      if (target) {
        scrollTimelineItemIntoView(el, target, behavior);
        awaitingFirstPostPlayerItem.current = false;
      }
      return;
    }

    baselineItemKeys.current = keySet;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

function timelineItems(el: HTMLElement): TimelineItem[] {
  return Array.from(el.querySelectorAll<HTMLElement>('[data-flow-item-key]'))
    .map(node => ({
      key: node.dataset.flowItemKey ?? '',
      kind: node.dataset.flowItemKind ?? 'message',
      node,
    }))
    .filter(item => item.key.length > 0);
}

function firstNewNonPlayerItem(
  items: TimelineItem[],
  baseline: Set<string>,
): TimelineItem | null {
  return (
    items.find(item => !baseline.has(item.key) && item.kind !== 'player') ??
    null
  );
}

function scrollTimelineItemIntoView(
  el: HTMLElement,
  item: TimelineItem,
  behavior: ScrollBehavior,
): void {
  const containerRect = el.getBoundingClientRect();
  const targetRect = item.node.getBoundingClientRect();
  const top = el.scrollTop + targetRect.top - containerRect.top - 12;
  el.scrollTo({
    top: Math.max(0, top),
    behavior,
  });
}
