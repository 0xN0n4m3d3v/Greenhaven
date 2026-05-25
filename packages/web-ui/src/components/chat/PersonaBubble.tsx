// Spec 37 §A.2 — persona-keyed bubble dispatcher.
//
// Switches on `msg.persona_slug` (cartridge-author override on each
// entity, migration 0044) falling back to `msg.tone`. Each archetype
// applies its own bubble shape via the `bubble-${slug}` className so
// the existing CSS / motion entrance / click handlers continue to
// work — PersonaBubble is a thin DOM-class dispatcher, not a layout
// take-over.

import {motion} from 'motion/react';
import type {ComponentProps, ReactNode} from 'react';

export interface PersonaBubbleMessage {
  tone: string;
  author?: string;
  authorId?: number;
  persona_slug?: string | null;
  persona_hue?: string | null;
  crit?: 'success' | 'fail';
}

type ArticleProps = Omit<ComponentProps<typeof motion.article>, 'children'>;

export interface PersonaBubbleProps extends ArticleProps {
  msg: PersonaBubbleMessage;
  children: ReactNode;
  /** Side hint (self/other) so the existing layout stays untouched. */
  side?: 'self' | 'other';
}

/** Map tone → archetype slug when no explicit persona_slug is set. */
function toneToSlug(tone: string): string {
  switch (tone) {
    case 'narrator':
      return 'narrator_parchment';
    case 'player':
      return 'player_echo';
    case 'system':
      return 'system_pill';
    case 'dice':
      return 'dice_capsule';
    default:
      return 'npc_rounded_tail';
  }
}

const SLUG_TO_CLASS: Record<string, string> = {
  narrator_parchment: 'bubble-parchment',
  narrator_disco_prose: 'bubble-disco-prose',
  npc_rounded_tail: 'bubble-npc-voice',
  player_echo: 'bubble-player-echo',
  system_pill: 'bubble-system-pill',
  dice_capsule: 'bubble-dice-capsule',
  lore_torn_paper: 'bubble-lore-torn',
  message_letter: 'bubble-letter',
  terminal_holo: 'bubble-holo',
};

/** Spec 139 v2 — Visual ROLE of a bubble beyond its raw tone.
 *
 * Broker often emits messages with tone='narrator' but a concrete
 * authorId (e.g. Mikka speaking in third person about her own action).
 * For chrome purposes treat those as NPC speech — Mikka should look
 * like Mikka, not like a parchment-page world voice. World-voice
 * narration is reserved for tone='narrator' with NO author. */
type BubbleRole = 'player' | 'npc' | 'narrator' | 'system' | 'dice';
function bubbleRole(msg: PersonaBubbleMessage): BubbleRole {
  if (msg.tone === 'player') return 'player';
  if (msg.tone === 'system') return 'system';
  if (msg.tone === 'dice') return 'dice';
  if (msg.authorId && msg.authorId > 0) return 'npc';
  return 'narrator';
}

export function PersonaBubble({
  msg,
  children,
  side,
  className,
  style,
  ...rest
}: PersonaBubbleProps) {
  const slug = msg.persona_slug ?? toneToSlug(msg.tone);
  const archetypeClass = SLUG_TO_CLASS[slug] ?? SLUG_TO_CLASS.npc_rounded_tail;
  const role = bubbleRole(msg);
  const critClass =
    slug === 'dice_capsule' && msg.crit ? ` crit-${msg.crit}` : '';
  const personaHueStyle =
    msg.persona_hue
      ? ({...style, ['--persona-hue' as never]: msg.persona_hue} as never)
      : style;
  const initial = (msg.author ?? '').trim()[0]?.toUpperCase() ?? '?';
  return (
    <motion.article
      {...rest}
      className={`bubble ${msg.tone} ${side ?? ''} ${archetypeClass} role-${role}${critClass} ${className ?? ''}`.trim()}
      data-role={role}
      data-author-initial={initial}
      style={personaHueStyle}
    >
      {children}
    </motion.article>
  );
}
