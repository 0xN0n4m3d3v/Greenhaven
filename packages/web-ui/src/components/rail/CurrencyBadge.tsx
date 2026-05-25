// Currency glance badge for the rail. Reads the same player_inventory
// currency source as query_inventory and refreshes on currency SSE events.

import {Coins} from 'lucide-react';
import {motion, AnimatePresence} from 'motion/react';
import {useEffect, useState} from 'react';
import {fetchPlayerCurrency} from '../../bridge/currency';
import {EventsOn} from '../../bridge/platform';
import {Tooltip, TooltipContent, TooltipTrigger} from '../ui/tooltip';

interface CurrencyResponse {
  playerId: number;
  count: number;
}

export function CurrencyBadge({
  playerId,
  collapsed = false,
}: {
  playerId: number;
  collapsed?: boolean;
}) {
  const [count, setCount] = useState(0);
  const [pulse, setPulse] = useState(false);
  const [prev, setPrev] = useState(0);

  useEffect(() => {
    if (!playerId) return;
    const ctrl = new AbortController();
    void fetchPlayerCurrency({playerId, signal: ctrl.signal})
      .then(next => {
        if (typeof next === 'number') setCount(next);
      })
      .catch(() => {
        // Badge is optional; gameplay must not fail if the glance fetch fails.
      });
    return () => ctrl.abort();
  }, [playerId]);

  useEffect(() => {
    const off = EventsOn('currency:changed', (raw: unknown) => {
      const data = raw as Partial<CurrencyResponse>;
      if (data.playerId !== playerId || typeof data.count !== 'number') return;
      setCount(data.count);
    });
    return off;
  }, [playerId]);

  useEffect(() => {
    if (count !== prev) {
      setPulse(true);
      const t = window.setTimeout(() => setPulse(false), 600);
      setPrev(count);
      return () => window.clearTimeout(t);
    }
  }, [count, prev]);

  if (count === 0 && !pulse && !collapsed) return null;

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="rail-icon currency-icon"
            aria-label={`${count} gold`}
          >
            <Coins size={18} />
            {count > 0 && (
              <span className="rail-icon-badge" aria-hidden>
                {count}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span className="currency-tooltip">{count} gold</span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="gh-control currency-badge" title={`${count} gold`}>
      <motion.span
        animate={pulse ? {rotateY: [0, 360], scale: [1, 1.3, 1]} : undefined}
        transition={{duration: 0.6}}
        className="currency-badge__icon"
      >
        <Coins size={14} />
      </motion.span>
      <AnimatePresence mode="popLayout">
        <motion.span
          key={count}
          initial={{y: -6, opacity: 0}}
          animate={{y: 0, opacity: 1}}
          exit={{y: 6, opacity: 0}}
          transition={{duration: 0.25}}
          className="currency-badge__count"
        >
          {count}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
