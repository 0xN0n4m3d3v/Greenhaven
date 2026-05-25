// Spec 37 §A.2 — NPC dialogue: rounded with persona-hue tail, avatar
// slot. Author markup goes in the leading slot; prose is children.

import type {ReactNode} from 'react';

export interface NpcDialogueBubbleProps {
  children: ReactNode;
  /** Optional avatar / portrait element. */
  avatar?: ReactNode;
  /** Author display name to render below or alongside the avatar. */
  authorName?: string;
  /** CSS hue token for voice rim — e.g. "240 60% 55%". */
  personaHue?: string;
}

export function NpcDialogueBubble({
  children,
  avatar,
  authorName,
  personaHue,
}: NpcDialogueBubbleProps) {
  return (
    <article
      className="bubble bubble-npc-voice npc"
      style={personaHue ? ({['--persona-hue' as never]: personaHue} as never) : undefined}
    >
      {avatar && <div className="bubble-avatar">{avatar}</div>}
      {authorName && <div className="bubble-author">{authorName}</div>}
      <div className="bubble-body">{children}</div>
    </article>
  );
}
