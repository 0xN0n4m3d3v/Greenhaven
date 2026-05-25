// NearbyNPCsRail — sidebar panel that renders an NPCCard for every
// NPC in state.nearby. Conditions + Strings update live via the
// runtime:field SSE channel (spec 30 hooks). HP comes from the
// bridge's nearby snapshot when available; falls back to hidden
// HP-ring when max_hp is 0.

import {Users} from 'lucide-react';
import {NPCCard, type NPCSummary} from './NPCCard';
import {Portrait} from './Portrait';
import {useRuntimeField} from '../../hooks/useRuntimeFields';
import {Popover, PopoverContent, PopoverTrigger} from '../ui/popover';

interface NearbyEntity {
  id: number;
  name: string;
  status?: string;
  // Optional richer fields if the bridge populates them.
  current_hp?: number;
  max_hp?: number;
  summary?: string;
  /** entities.profile.portrait_set — passed through bridge. */
  portrait_set?: Record<string, string | null>;
}

function NPCCardWithPortrait({
  npc,
  playerId,
  onTalk,
}: {
  npc: NearbyEntity;
  playerId: number;
  onTalk?: (id: number, name: string) => void;
}) {
  // mood comes from runtime:field SSE; portrait_set is static cartridge data.
  const mood = useRuntimeField<string>(npc.id, 'mood') ?? 'default';
  const summary: NPCSummary = {
    id: npc.id,
    display_name: npc.name,
    subtitle: npc.status,
    current_hp: npc.current_hp ?? 0,
    max_hp: npc.max_hp ?? 0,
    summary: npc.summary,
    affordances: onTalk
      ? [{id: `talk:${npc.id}`, label: `Talk to ${npc.name}`}]
      : [],
  };
  return (
    <NPCCard
      npc={summary}
      playerId={playerId}
      portrait={
        <Portrait
          npcId={npc.id}
          name={npc.name}
          portraitSet={npc.portrait_set}
          mood={String(mood).replace(/^"|"$/g, '')}
          size="md"
        />
      }
      onAffordanceClick={() => onTalk?.(npc.id, npc.name)}
    />
  );
}

export function NearbyNPCsRail({
  nearby,
  playerId,
  onTalk,
  collapsed = false,
}: {
  nearby: NearbyEntity[];
  playerId: number;
  onTalk?: (id: number, name: string) => void;
  collapsed?: boolean;
}) {
  if (!nearby || nearby.length === 0) return null;
  const list = (
    <div className="nearby-npc-list">
      {nearby.map(npc => (
        <NPCCardWithPortrait key={npc.id} npc={npc} playerId={playerId} onTalk={onTalk} />
      ))}
    </div>
  );
  if (collapsed) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="rail-icon" aria-label="nearby">
            <Users size={18} />
            <span className="rail-icon-badge" aria-hidden>
              {nearby.length}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="right" className="rail-popover wide">
          <div className="rail-popover-inner">
            <div className="section-title">Nearby</div>
            {list}
          </div>
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <>
      <div className="section-title">Nearby</div>
      {list}
    </>
  );
}
