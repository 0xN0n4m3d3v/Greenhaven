// Spec 37 §A.2 — narrator parchment block. Centered, drop-cap,
// max-w 70ch.

import type {ReactNode} from 'react';

export interface NarratorBlockProps {
  children: ReactNode;
}

export function NarratorBlock({children}: NarratorBlockProps) {
  return (
    <article className="bubble bubble-parchment narrator">
      {children}
    </article>
  );
}
