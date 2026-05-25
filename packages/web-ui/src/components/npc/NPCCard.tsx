// Primary NPC display surface.
//
// Named slots (portrait, band, combatState, partnerActions) let other
// gameplay features attach to the card without rewriting the structure.

import type {ReactNode} from 'react';
import {useConditionsFor, useStringsFor} from '../../hooks/useRuntimeFields';
import {HpRing} from './HpRing';
import {SurfacePip} from './SurfacePip';

export interface NPCSummary {
  id: number;
  display_name: string;
  subtitle?: string;
  summary?: string;
  current_hp: number;
  max_hp: number;
  concentrating?: boolean;
  standing_in?: string[];
  affordances?: Array<{id: string; label: string}>;
}

interface NPCCardProps {
  npc: NPCSummary;
  playerId: number;
  portrait?: ReactNode;
  band?: ReactNode;
  combatState?: ReactNode;
  partnerActions?: ReactNode;
  onAffordanceClick?: (id: string) => void;
}

export function NPCCard({
  npc,
  playerId,
  portrait,
  band,
  combatState,
  partnerActions,
  onAffordanceClick,
}: NPCCardProps) {
  const conditions = useConditionsFor(npc.id);
  const strings = useStringsFor(npc.id, playerId);

  return (
    <div className="npc-card">
      <header className="npc-card__header">
        {portrait}
        <div className="npc-card__identity">
          <h3>{npc.display_name}</h3>
          {npc.subtitle && (
            <p className="npc-card__subtitle">{npc.subtitle}</p>
          )}
          {band}
          {combatState}
        </div>
        {npc.max_hp > 0 && (
          <HpRing
            current={npc.current_hp}
            max={npc.max_hp}
            concentration={npc.concentrating}
          />
        )}
      </header>

      {npc.summary && <p className="npc-card__summary">{npc.summary}</p>}

      {npc.standing_in && npc.standing_in.length > 0 && (
        <div className="npc-card__surfaces">
          {npc.standing_in.map(s => (
            <SurfacePip key={s} type={s} title={`${npc.display_name} - ${s}`} />
          ))}
        </div>
      )}

      {conditions.length > 0 && (
        <div className="npc-card__conditions">
          <p className="npc-card__section-label">Conditions</p>
          <div className="npc-card__condition-list">
            {conditions.map((c, i) => (
              <span key={`${c.tag}-${i}`} className="npc-card__condition">
                {c.tag}
                {(c.severity ?? 1) > 1 ? ` x${c.severity}` : ''}
                {c.expires_turn != null ? ` -> T${c.expires_turn}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {strings > 0 && (
        <div className="npc-card__strings">
          <span>Strings on you</span>
          <strong>{strings}</strong>
        </div>
      )}

      {partnerActions}

      {npc.affordances && npc.affordances.length > 0 && (
        <div className="npc-card__actions">
          {npc.affordances.map(a => (
            <button key={a.id} onClick={() => onAffordanceClick?.(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
