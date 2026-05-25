// Floating dice overlay. It listens to dice:rolled SSE events and shows a
// physics-based d20 settling on the result.

import type {CSSProperties} from 'react';
import {useEffect, useState} from 'react';
import {motion, AnimatePresence} from 'motion/react';
import {EventsOn} from '../../bridge/platform';
import {DiceBox3D, type DiceRollPayload} from './DiceBox3D';

interface ActiveRoll extends DiceRollPayload {
  id: number;
  label?: string;
}

let nextId = 1;

export function LiveDiceOverlay() {
  const [active, setActive] = useState<ActiveRoll | null>(null);

  useEffect(() => {
    const off = EventsOn('dice:rolled', (...args: unknown[]) => {
      const data = args[0] as
        | {
            result?: number;
            d?: number;
            modifier?: number;
            dc?: number;
            success?: boolean;
            crit?: boolean;
            roller?: 'player' | 'npc';
            description?: string;
            category?: string;
          }
        | undefined;
      if (!data || typeof data.result !== 'number') return;

      const roll: ActiveRoll = {
        id: nextId++,
        total: data.result,
        d: data.d ?? 20,
        modifier: data.modifier,
        dc: data.dc,
        success: data.success,
        crit: data.crit,
        roller: data.roller,
        label: data.description ?? data.category,
      };
      setActive(roll);
      const t = window.setTimeout(() => {
        setActive(prev => (prev?.id === roll.id ? null : prev));
      }, 2800);
      return () => window.clearTimeout(t);
    });
    return () => {
      off();
    };
  }, []);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key={active.id}
          className="live-dice-overlay"
          initial={{opacity: 0, y: 32, scale: 0.92}}
          animate={{opacity: 1, y: 0, scale: 1}}
          exit={{opacity: 0, y: 16, scale: 0.95}}
          transition={{duration: 0.32, ease: [0.16, 1, 0.3, 1]}}
          aria-live="polite"
          aria-label={`dice ${active.total}${active.dc != null ? ` versus DC ${active.dc}` : ''}`}
        >
          <DiceBox3D roll={active} width={280} height={180} />
          <DiceCaption roll={active} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DiceCaption({roll}: {roll: ActiveRoll}) {
  const verdictHue =
    roll.crit && roll.success ? 45
      : roll.crit              ? 0
      : roll.success           ? 145
      : roll.success === false ? 12
      :                          220;
  const verdictText =
    roll.crit && roll.success ? 'CRIT'
      : roll.crit              ? 'FAIL'
      : roll.success           ? 'SUCCESS'
      : roll.success === false ? 'MISS'
      :                          '';
  const vars = {
    '--dice-caption-hue': verdictHue,
  } as CSSProperties;
  return (
    <div className="gh-panel live-dice-caption" style={vars}>
      <span className="live-dice-caption__total">
        {roll.total}
        {roll.modifier ? `${roll.modifier > 0 ? '+' : ''}${roll.modifier}` : ''}
      </span>
      {roll.dc != null && (
        <span className="live-dice-caption__dc">vs DC {roll.dc}</span>
      )}
      {verdictText && (
        <span className="live-dice-caption__verdict">{verdictText}</span>
      )}
      {roll.label && (
        <span className="live-dice-caption__label">- {roll.label}</span>
      )}
    </div>
  );
}
