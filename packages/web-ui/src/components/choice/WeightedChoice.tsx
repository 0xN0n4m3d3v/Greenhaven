// Spec 37 §4 carried-over — weighted click for irreversible commits.
//
// Used around Devil's Bargain Accept, trauma award confirm, character
// retire, save-slot delete, etc. Hover delay → glow buildup → 80ms
// screen darken → fade non-chosen options.
//
// data-weight attribute is what MagneticCursor reads to decide pull.

import {motion} from 'motion/react';
import type {ReactNode} from 'react';
import {useState} from 'react';

export interface WeightedChoiceProps {
  children: ReactNode;
  onCommit: () => void;
  weight?: 'light' | 'heavy';
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function WeightedChoice({
  children,
  onCommit,
  weight = 'heavy',
  disabled,
  className,
  ariaLabel,
}: WeightedChoiceProps) {
  const [hovered, setHovered] = useState(false);
  const [committing, setCommitting] = useState(false);

  const handleClick = () => {
    if (committing || disabled) return;
    setCommitting(true);
    setTimeout(onCommit, weight === 'heavy' ? 280 : 160);
  };

  return (
    <>
      <motion.button
        type="button"
        data-weight={weight}
        aria-label={ariaLabel}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={handleClick}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
        animate={committing ? {opacity: 0, scale: 0.98} : {opacity: 1, scale: 1}}
        transition={{duration: weight === 'heavy' ? 0.28 : 0.16}}
        className={`weighted-choice ${weight} ${hovered ? 'hovered' : ''} ${className ?? ''}`}
      >
        {children}
      </motion.button>
      {committing && weight === 'heavy' && (
        <motion.div
          initial={{opacity: 0}}
        animate={{opacity: 0.6}}
        exit={{opacity: 0}}
        transition={{duration: 0.08}}
          className="weighted-choice-commit-flash"
        />
      )}
    </>
  );
}
