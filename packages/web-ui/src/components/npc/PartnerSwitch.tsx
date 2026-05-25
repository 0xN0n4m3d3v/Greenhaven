// Spec 36 §5 carried-over — partner-picker chip.
//
// Surfaces a popover with the list of NPCs in the current scene; click
// → POST /api/session/:id/dialogue/start (or our switch_dialogue_partner
// tool route). The DialogueBanner in the chat header already handles
// the "End/Resume" affordance; this chip is the explicit "switch from
// Mikka to Borek mid-scene" UX without typing @Borek.
//
// Current shell note: GameScreen now uses ChatList rows and NPCProfileModal
// for NPC selection, and manual end-dialogue controls are intentionally absent.

import {Popover, PopoverContent, PopoverTrigger} from '../ui/popover';

export interface PartnerSwitchProps {
  /** All NPCs the player can switch to (typically state.nearby). */
  candidates: Array<{id: number; name: string}>;
  /** Currently engaged partner id, if any. */
  activeId: number | null;
  /** Click handler — start dialogue with the given NPC. */
  onPick: (npcId: number, npcName: string) => void;
  /** Optional disable while a turn is in flight. */
  disabled?: boolean;
}

export function PartnerSwitch({
  candidates,
  activeId,
  onPick,
  disabled,
}: PartnerSwitchProps) {
  if (!candidates || candidates.length < 2) return null;
  const active = candidates.find(c => c.id === activeId);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="partner-switch-chip"
          disabled={disabled}
          title="Switch dialogue partner"
        >
          ↻ {active?.name ?? 'Pick partner'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="partner-switch-pop">
        <ul className="partner-switch-list">
          {candidates.map(c => (
            <li key={c.id}>
              <button
                type="button"
                className={`partner-switch-option${c.id === activeId ? ' active' : ''}`}
                onClick={() => onPick(c.id, c.name)}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
