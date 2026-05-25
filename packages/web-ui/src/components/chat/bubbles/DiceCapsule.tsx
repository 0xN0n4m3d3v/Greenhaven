// Spec 37 §A.2 — dice capsule: capsule with d20 glyph + tabular nums.

import type {ReactNode} from 'react';

export interface DiceCapsuleProps {
  children: ReactNode;
  crit?: 'success' | 'fail';
}

export function DiceCapsule({children, crit}: DiceCapsuleProps) {
  return (
    <article className={`bubble bubble-dice-capsule dice ${crit ? `crit-${crit}` : ''}`}>
      <span className="d20-glyph" aria-hidden>
        d20
      </span>
      <span className="dice-body">{children}</span>
    </article>
  );
}
