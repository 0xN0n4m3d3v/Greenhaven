// Player-state panels for the left rail. Subscribes to runtime:field
// SSE events for the player's own conditions + trauma. Shows up only
// when there's something to show (no empty headers).
//
// Spec 30 (conditions list) + spec 20 (trauma display).
//
// Tooltip wrapping (2026-05) — every chip exposes its structured
// info on hover so players don't have to learn the chip-format
// vocabulary.
//
// Compact mode (2026-05-06) — collapsed rail renders a sigil button
// (Sparkles for OK, AlertOctagon for severe) that opens a Radix
// popover with the existing chips.

import {AlertOctagon, Sparkles} from 'lucide-react';
import {useConditionsFor, useTrauma} from '../../hooks/useRuntimeFields';
import {ConditionChip} from '../ui/condition-chip';
import {Popover, PopoverContent, PopoverTrigger} from '../ui/popover';

export function PlayerStateRail({
  playerId,
  collapsed = false,
}: {
  playerId: number;
  collapsed?: boolean;
}) {
  const conditions = useConditionsFor(playerId);
  const trauma = useTrauma(playerId);

  const traumaTone =
    trauma.length >= 3 ? 'destructive'
      : trauma.length >= 2 ? 'warn'
      : 'neutral';

  if (conditions.length === 0 && trauma.length === 0) return null;

  const total = conditions.length + trauma.length;
  const severe = trauma.length >= 3;

  const body = (
    <>
      {conditions.length > 0 && (
        <>
          <div className="section-title">Conditions</div>
          <div className="player-state-chip-row">
            {conditions.map((c, i) => {
              const details = [];
              if ((c.severity ?? 1) > 1) {
                details.push({label: 'severity', value: `×${c.severity}`});
              }
              if (c.expires_turn != null) {
                details.push({label: 'expires', value: `T${c.expires_turn}`});
              }
              return (
                <ConditionChip
                  key={`${c.tag}-${i}`}
                  label={
                    c.tag +
                    ((c.severity ?? 1) > 1 ? ` ×${c.severity}` : '') +
                    (c.expires_turn != null ? ` →T${c.expires_turn}` : '')
                  }
                  details={details}
                  description="An active condition affecting this character."
                  tone="neutral"
                />
              );
            })}
          </div>
        </>
      )}
      {trauma.length > 0 && (
        <>
          <div className="section-title">
            Trauma{' '}
            <span className="player-state-count">
              · {trauma.length}/4
            </span>
          </div>
          <div className="player-state-chip-row">
            {trauma.map((t, i) => (
              <ConditionChip
                key={`${t}-${i}`}
                label={String(t)}
                tone={traumaTone}
                description="Persistent psychic injury. Four traumas retire the character."
              />
            ))}
          </div>
          {trauma.length >= 4 && (
            <p className="player-state-retirement-warning">
              Your character is at the edge of retirement.
            </p>
          )}
        </>
      )}
    </>
  );

  if (collapsed) {
    const Icon = severe ? AlertOctagon : Sparkles;
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`rail-icon ${severe ? 'severe' : ''}`}
            aria-label="conditions and trauma"
          >
            <Icon size={18} />
            {total > 0 && (
              <span className="rail-icon-badge" aria-hidden>
                {total}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent side="right" className="rail-popover">
          <div className="rail-popover-inner">{body}</div>
        </PopoverContent>
      </Popover>
    );
  }

  return body;
}
