// Spec 37 §A.2 — player echo: rounded muted right-aligned.

import type {ReactNode} from 'react';

export interface PlayerEchoBubbleProps {
  children: ReactNode;
}

export function PlayerEchoBubble({children}: PlayerEchoBubbleProps) {
  return <article className="bubble bubble-player-echo player">{children}</article>;
}
