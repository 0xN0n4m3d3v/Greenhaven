// Inspiration tokens (BG3 style).
//
// Visible HUD chip in the top-right showing N/CAP pips. It stays hidden until
// the player first gains inspiration so fresh heroes do not see an unexplained
// empty resource.

import {useEffect, useState} from 'react';
import {motion, AnimatePresence} from 'motion/react';
import {EventsOn} from '../../bridge/platform';
import {useRuntimeField} from '../../hooks/useRuntimeFields';
import {useTranslation} from '../../i18n';

const CAP = 3;

export function InspirationBadge({playerId}: {playerId: number}) {
  const {language} = useTranslation();
  const stored = useRuntimeField<number>(playerId, 'inspiration');
  const [count, setCount] = useState<number>(typeof stored === 'number' ? stored : 0);
  const [pulseAt, setPulseAt] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<boolean>(
    typeof stored === 'number' && stored > 0,
  );
  const label = language === 'ru' ? 'Вдохновение' : 'Inspiration';
  const title = `${label} ${count}/${CAP}`;

  useEffect(() => {
    if (typeof stored === 'number') {
      setCount(stored);
      if (stored > 0) setRevealed(true);
    }
  }, [stored]);

  useEffect(() => {
    const offGained = EventsOn('inspiration:gained', () => {
      setCount(prev => Math.min(CAP, prev + 1));
      setPulseAt(Date.now());
      setRevealed(true);
    });
    const offSpent = EventsOn('inspiration:spent', () => {
      setCount(prev => Math.max(0, prev - 1));
    });
    return () => {
      offGained();
      offSpent();
    };
  }, []);

  if (playerId <= 0 || !revealed) return null;

  return (
    <div
      className="gh-panel inspiration-badge"
      title={title}
      aria-label={title}
    >
      <span className="inspiration-badge__label">{label}</span>
      <span className="inspiration-badge__pips">
        {Array.from({length: CAP}, (_, i) => {
          const lit = i < count;
          return (
            <motion.span
              key={i}
              className={`inspiration-badge__pip${lit ? ' is-lit' : ''}`}
              animate={
                lit && pulseAt && i === count - 1
                  ? {scale: [1, 1.4, 1]}
                  : {scale: 1}
              }
              transition={{duration: 0.45, ease: 'easeOut'}}
            />
          );
        })}
      </span>
      <AnimatePresence>
        {pulseAt && (
          <motion.span
            key={pulseAt}
            className="inspiration-badge__burst"
            initial={{opacity: 1, y: 0, scale: 1}}
            animate={{opacity: 0, y: -20, scale: 1.4}}
            exit={{opacity: 0}}
            transition={{duration: 0.9, ease: 'easeOut'}}
            onAnimationComplete={() => setPulseAt(null)}
          >
            *
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
