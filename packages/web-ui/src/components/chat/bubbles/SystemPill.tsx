// Spec 37 §A.2 — system pill: hairline-divider, small-caps, mono.

import type {ReactNode} from 'react';

export interface SystemPillProps {
  children: ReactNode;
}

export function SystemPill({children}: SystemPillProps) {
  return <article className="bubble bubble-system-pill system">{children}</article>;
}
