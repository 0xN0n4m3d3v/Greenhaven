// Square HP meter. The active Greenhaven UI contract forbids circular chrome.

import type {CSSProperties} from 'react';
import {motion} from 'motion/react';

interface Props {
  current: number;
  max: number;
  concentration?: boolean;
  size?: number;
}

export function HpRing({current, max, concentration, size = 56}: Props) {
  const pct = Math.max(0, Math.min(1, max > 0 ? current / max : 0));
  const color = pct > 0.6 ? 'var(--moss)' : pct > 0.25 ? 'var(--ember)' : 'var(--rust)';
  const vars = {
    '--hp-meter-size': `${size}px`,
    '--hp-meter-color': `hsl(${color})`,
    '--hp-meter-color-soft': `hsl(${color} / 0.38)`,
  } as CSSProperties;

  return (
    <div className="hp-ring gh-control" style={vars}>
      <motion.div
        aria-hidden
        className="hp-ring__fill"
        initial={{height: 0}}
        animate={{height: `${pct * 100}%`}}
        transition={{duration: 0.4, ease: 'easeOut'}}
      />
      {concentration && <div aria-hidden className="hp-ring__focus" />}
      <div className="hp-ring__text">
        <span>{current}</span>
        <span className="hp-ring__sep">/</span>
        <span className="hp-ring__max">{max}</span>
      </div>
    </div>
  );
}
