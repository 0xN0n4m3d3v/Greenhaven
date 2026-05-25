// @-mention helpers: rich-message rendering with clickable mention triggers.

import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {engine} from '../bridge/platform';
import type {AffordanceAction} from '../types/affordance';
import type {GameState, MentionMatch, MentionTarget} from '../types/app';
import {
  localizedItemLookMessage,
  localizedTravelMessage,
} from './actionText';
import {mentionTypeClass, safeArray} from './state';

export function travelMessage(
  target: Pick<MentionTarget, 'name' | 'type'>,
  language?: string | null,
) {
  return localizedTravelMessage(target, language);
}

export function resolveBubbleNpc(
  message: any,
  mentionTargets: MentionTarget[],
  isNpcBubble: boolean,
): {id: number; name: string} | null {
  if (isNpcBubble && message.authorId > 0) {
    return {id: message.authorId, name: message.author};
  }
  const persons = mentionTargets.filter(m => (m.type ?? '').toLowerCase() === 'person');
  const text = String(message.text ?? '');
  const found = persons.find(m => text.includes('@' + m.name));
  if (found) return {id: found.id, name: found.name};
  return null;
}

export function entityMentionTarget(
  entity: engine.EntityCard | null | undefined,
  language?: string | null,
): MentionTarget | null {
  if (!entity?.name || entity.id <= 0) return null;
  const type = (entity.type || 'entity').toLowerCase();
  const target: MentionTarget = {id: entity.id, name: entity.name, type};
  if (type === 'location' || type === 'district') {
    target.actionId = `location:${entity.id}`;
    target.actionMessage = travelMessage(target, language);
  }
  if (type === 'scene') {
    target.actionId = `scene:${entity.id}`;
    target.actionMessage = travelMessage(target, language);
  }
  if (type === 'item') {
    target.actionId = `item:${entity.id}`;
    target.actionMessage = localizedItemLookMessage(entity, language);
  }
  return target;
}

export function buildMentionTargets(
  state: GameState,
  language?: string | null,
): MentionTarget[] {
  const targets: MentionTarget[] = [];
  for (const location of safeArray(state.locations)) {
    targets.push({
      id: location.id,
      name: location.name,
      type: 'location',
      actionId: `location:${location.id}`,
      actionMessage: travelMessage({name: location.name, type: 'location'}, language),
    });
  }
  for (const entity of [
    state.currentScene,
    state.focusEntity,
    ...safeArray(state.worldEntities),
  ]) {
    const target = entityMentionTarget(entity as engine.EntityCard, language);
    if (target) targets.push(target);
  }
  for (const npc of safeArray(state.nearby)) {
    targets.push({id: npc.id, name: npc.name, type: 'person'});
  }

  const seen = new Set<string>();
  return targets.filter(target => {
    const key = `${target.type || 'entity'}:${target.id}:${target.name}`;
    if (!target.name.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildMentionTargetsFromAffordances(
  affordances: AffordanceAction[],
  language?: string | null,
): MentionTarget[] {
  const byId = new Map<number, MentionTarget>();
  for (const a of affordances) {
    const id = typeof a?.entity_id === 'number' ? a.entity_id : null;
    if (id == null) continue;
    const label = String(a?.label || '');
    const idx = label.lastIndexOf('@');
    if (idx < 0) continue;
    const name = label.slice(idx + 1).trim();
    if (!name) continue;
    const kind = String(a?.kind || '');
    let type: MentionTarget['type'] = 'entity';
    if (kind === 'travel' || kind === 'location') type = 'location';
    else if (kind.startsWith('item')) type = 'item';
    else if (kind.startsWith('social') || kind === 'attack') type = 'person';
    if (byId.has(id)) continue;
    const target: MentionTarget = {id, name, type};
    if (type === 'location') {
      target.actionId = `location:${id}`;
      target.actionMessage = travelMessage(target, language);
    } else if (type === 'item') {
      target.actionMessage = localizedItemLookMessage(target, language);
    }
    byId.set(id, target);
  }
  return [...byId.values()];
}

export function mentionMatches(mentions: MentionTarget[]): MentionMatch[] {
  const firstNameCounts = new Map<string, number>();
  for (const mention of mentions) {
    const first = mention.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first) {
      firstNameCounts.set(first, (firstNameCounts.get(first) ?? 0) + 1);
    }
  }
  const matches: MentionMatch[] = [];
  for (const mention of mentions) {
    const name = mention.name.trim();
    if (!name) continue;
    matches.push({trigger: `@${name}`, target: mention});
    const first = name.split(/\s+/)[0];
    if (first && first.length > 2 && firstNameCounts.get(first.toLowerCase()) === 1) {
      matches.push({trigger: `@${first}`, target: mention});
    }
  }
  return matches.sort((a, b) => b.trigger.length - a.trigger.length);
}

export function isMentionBoundary(next: string | undefined) {
  return !next || !/[\p{L}\p{N}_]/u.test(next);
}

export function matchMentionAt(text: string, index: number, mentions: MentionMatch[]) {
  for (const mention of mentions) {
    if (
      text.startsWith(mention.trigger, index) &&
      isMentionBoundary(text[index + mention.trigger.length])
    ) {
      return mention;
    }
  }
  return null;
}

export function renderTextWithMentions(
  text: string,
  mentions: MentionMatch[],
  onMention: (target: MentionTarget) => void,
  keyPrefix: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let buffer = '';
  const flush = () => {
    if (buffer) {
      nodes.push(buffer);
      buffer = '';
    }
  };
  while (index < text.length) {
    const mention = matchMentionAt(text, index, mentions);
    if (mention) {
      flush();
      nodes.push(
        <button
          className={mentionTypeClass(mention.target.type)}
          key={`${keyPrefix}-mention-${index}`}
          onClick={() => onMention(mention.target)}
          title={
            mention.target.actionId ? `Open ${mention.target.name}` : `Mention ${mention.target.name}`
          }
          type="button"
        >
          {mention.trigger}
        </button>,
      );
      index += mention.trigger.length;
      continue;
    }
    buffer += text[index];
    index += 1;
  }
  flush();
  return nodes;
}

export function injectMentions(
  children: ReactNode,
  mentions: MentionMatch[],
  onMention: (target: MentionTarget) => void,
  keyPrefix: string,
): ReactNode {
  return Children.map(children, (child, idx) => {
    const childKey = `${keyPrefix}-${idx}`;
    if (typeof child === 'string') {
      return <span key={childKey}>{renderTextWithMentions(child, mentions, onMention, childKey)}</span>;
    }
    if (isValidElement(child)) {
      const props = child.props as {children?: ReactNode};
      if (props.children !== undefined) {
        return cloneElement(child as any, {
          key: childKey,
          children: injectMentions(props.children, mentions, onMention, childKey),
        });
      }
      return child;
    }
    return child;
  });
}

export function renderRichMessage(
  text: string,
  mentions: MentionTarget[],
  onMention: (target: MentionTarget) => void,
) {
  const matches = mentionMatches(mentions);
  const wrap = (tag: string) => {
    const Component = (props: any) => {
      const {children, node: _node, ...rest} = props ?? {};
      return createElement(tag, rest, injectMentions(children, matches, onMention, tag));
    };
    Component.displayName = `Markdown(${tag})`;
    return Component;
  };
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        p: wrap('p'),
        em: wrap('em'),
        strong: wrap('strong'),
        li: wrap('li'),
        blockquote: wrap('blockquote'),
        h1: wrap('h1'),
        h2: wrap('h2'),
        h3: wrap('h3'),
        h4: wrap('h4'),
        h5: wrap('h5'),
        h6: wrap('h6'),
        code: wrap('code'),
        del: wrap('del'),
        td: wrap('td'),
        th: wrap('th'),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
