export type SystemEventType =
  | 'memory:added'
  | 'memory:enriched'
  | 'quest:created'
  | 'quest:started'
  | 'quest:advanced'
  | 'quest:completed'
  | 'quest:auto_advanced'
  | 'quest:choice_required'
  | 'scene:opened'
  | 'scene:choice_selected'
  | 'scene:closed'
  | 'materializer:applied'
  | 'materializer:auto_applied'
  | 'string:changed'
  | 'damage:dealt'
  | 'xp:awarded'
  | 'xp:levelup'
  | 'inspiration:gained'
  | 'inspiration:spent'
  | 'mode:changed'
  | 'dialogue:engaged'
  | 'dialogue:noticed'
  | 'dialogue:partner_switched'
  | 'dice:rolled'
  | 'sex_move:fired'
  | 'entity:revealed'
  | 'entity:duplicate_warning'
  | 'location:first_entry'
  | 'location:memory_added'
  | 'actor:status_changed'
  | 'media:shown'
  | 'movement:teleport_detected'
  | 'companion:added'
  | 'companion:removed'
  | 'companion:auto_departed'
  | 'npc:moved_with_player'
  | 'quest_pacer:overload'
  | 'quest_pacer:stale'
  | 'quest_pacer:dead_npc_arc'
  | 'npc:initiative'
  | 'intimacy:trigger'
  | 'adventure:oracle_rolled'
  | 'adventure:hook'
  | 'adventure:accepted'
  | 'adventure:ignored'
  | 'adventure:expired'
  | 'narrate:quarantined'
  | 'post_turn:slot_failed'
  // FEAT-STATE-1 Character State refresh channels. These are
  // server-side `gui_events` emitted by the new progression
  // mutation tools (`award_progression_xp`, `award_title`,
  // `equip_title`, `spend_stat_point`, `spend_skill_point`).
  // They surface here so the timeline replay + `system:event`
  // channel forwards them to `useCharacterState`. No event-card
  // body is rendered for them today; the surface refresh is the
  // intent.
  | 'character:stat_changed'
  | 'character:skill_unlocked'
  | 'character:skill_progressed'
  | 'character:title_awarded'
  | 'character:title_equipped';

export interface SystemEvent {
  id: string;
  eventId?: number;
  releaseSeq?: number | null;
  releasedAt?: string | null;
  messageId?: number | null;
  turnId?: string | null;
  type: SystemEventType;
  ts: number;
  payload: Record<string, unknown>;
  /**
   * Message id used only as a stable timeline ordering key. Event cards
   * remain standalone rows in the chat flow.
   */
}

export type Translator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;
