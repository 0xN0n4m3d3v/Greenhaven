// Character State block in the left rail. Pulls live HP/XP/level out of
// state.hero (bridge refreshes these after every turn.end). Extracted
// from App.tsx (spec 29 decomposition).
//
// Adds a `collapsed` icon-mode (compact rail) that renders a single
// Heart with a thin overlay HP bar; tooltip exposes the numbers.

import {Heart, Shield, Sparkles, Swords} from 'lucide-react';
import {safeArray} from '../../lib/state';
import type {GameState} from '../../types/app';
import {Tooltip, TooltipContent, TooltipTrigger} from '../ui/tooltip';

interface Props {
  hero: GameState['hero'] | null | undefined;
  /** i18n translator. Caller passes the resolved t fn so we don't reach for the hook here. */
  t: (key: string) => string;
  /** Compact rail mode. Renders the icon-only variant when true. */
  collapsed?: boolean;
}

export function HeroVitals({hero, t, collapsed = false}: Props) {
  const lvl = (safeArray(hero?.statuses)[0] ?? '').replace('lvl ', '') || '?';
  const xpStr = safeArray(hero?.statuses)[1] ?? '';
  const hpStr = safeArray(hero?.states)[0] ?? '';
  const hpMatch = /hp\s+(\d+)\/(\d+)/.exec(hpStr);
  const cur = hpMatch ? Number(hpMatch[1]) : null;
  const max = hpMatch ? Number(hpMatch[2]) : null;
  const pct =
    cur != null && max != null && max > 0
      ? Math.max(0, Math.min(100, (cur / max) * 100))
      : 0;
  const lowHp = cur != null && max != null && cur / max < 0.34;
  const dead = cur === 0;

  if (collapsed) {
    const hpState = dead ? 'crit' : lowHp ? 'warn' : 'ok';
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="rail-icon hero-vitals-icon"
            data-hp={hpState}
            aria-label={`${t('ui.hud.hp')} ${cur ?? '?'}/${max ?? '?'}`}
          >
            <Heart size={18} />
            <span className="rail-icon-bar" aria-hidden>
              <span className="rail-icon-bar-fill" style={{height: `${pct}%`}} />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <div className="hero-vitals-tooltip">
            <strong>{hero?.name || t('ui.hero.name')}</strong>
            <div>
              {t('ui.hud.level')} {lvl} · {t('ui.hud.xp')} {xpStr || '0'}
            </div>
            <div>
              {t('ui.hud.hp')} {cur ?? '?'}/{max ?? '?'}
              {dead && ` · ${t('ui.hud.defeated')}`}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <div className="section-title">Character State</div>
      <div className="hero-vitals">
        <div className="hero-vitals-row">
          <Shield size={14} />
          <span className="hero-vitals-label">{t('ui.hud.level')}</span>
          <strong>{lvl}</strong>
        </div>
        <div className="hero-vitals-row">
          <Sparkles size={14} />
          <span className="hero-vitals-label">{t('ui.hud.xp')}</span>
          <strong>{xpStr || '0'}</strong>
        </div>
        <div className={`hero-vitals-row hp ${lowHp ? 'low' : ''} ${dead ? 'dead' : ''}`}>
          <Swords size={14} />
          <span className="hero-vitals-label">{t('ui.hud.hp')}</span>
          <strong>
            {cur ?? '?'}/{max ?? '?'}
          </strong>
          <div className="hp-bar">
            <div className="hp-bar-fill" style={{width: `${pct}%`}} />
          </div>
        </div>
        {dead && <div className="hero-vitals-dead-line">{t('ui.hud.defeated')}</div>}
      </div>
    </>
  );
}
