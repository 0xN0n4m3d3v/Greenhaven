import {
  AlertTriangle,
  BookOpen,
  Brain,
  CheckCircle2,
  Compass,
  Dice5,
  Eye,
  Flame,
  Flag,
  Footprints,
  Heart,
  HelpCircle,
  KeyRound,
  MessageSquare,
  Moon,
  ScrollText,
  Sparkles,
  Star,
  Sword,
  TrendingUp,
  Users,
} from 'lucide-react';
import type {ReactNode} from 'react';
import type {SystemEventType, Translator} from './EventCardTypes';

function eventHeaderKey(type: SystemEventType): string {
  return `ui.event_card.header.${type.replace(':', '.')}`;
}

export function modeLabel(mode: string, tr: Translator): string {
  const key = `ui.event_card.mode.${mode}`;
  const localized = tr(key);
  return localized === key ? mode : localized;
}

export function pickHeader(type: SystemEventType, tr: Translator): string {
  const key = eventHeaderKey(type);
  return tr(key);
}

export function eventIcon(t: SystemEventType, mode?: string): ReactNode {
  const sz = 13;
  switch (t) {
    case 'memory:added':
    case 'memory:enriched':
      return <Brain size={sz} />;
    case 'quest:created':
    case 'quest:started':
      return <ScrollText size={sz} />;
    case 'quest:advanced':
    case 'quest:auto_advanced':
      return <TrendingUp size={sz} />;
    case 'quest:completed':
      return <CheckCircle2 size={sz} />;
    case 'quest:choice_required':
      return <HelpCircle size={sz} />;
    case 'scene:opened':
    case 'scene:choice_selected':
    case 'scene:closed':
      return <MessageSquare size={sz} />;
    case 'materializer:applied':
    case 'materializer:auto_applied':
      return <Sparkles size={sz} />;
    case 'string:changed':
      return <Heart size={sz} />;
    case 'damage:dealt':
      return <Sword size={sz} />;
    case 'xp:awarded':
      return <Star size={sz} />;
    case 'xp:levelup':
      return <Sparkles size={sz} />;
    case 'inspiration:gained':
    case 'inspiration:spent':
      return <BookOpen size={sz} />;
    case 'mode:changed':
      switch (mode) {
        case 'combat':
          return <Sword size={sz} />;
        case 'intimacy':
          return <Heart size={sz} />;
        case 'dialogue':
          return <MessageSquare size={sz} />;
        case 'travel':
          return <Footprints size={sz} />;
        case 'rest':
          return <Moon size={sz} />;
        case 'exploration':
        default:
          return <Compass size={sz} />;
      }
    case 'dialogue:engaged':
      return <MessageSquare size={sz} />;
    case 'dialogue:noticed':
      return <Eye size={sz} />;
    case 'dialogue:partner_switched':
      return <Users size={sz} />;
    case 'dice:rolled':
      return <Dice5 size={sz} />;
    case 'sex_move:fired':
      return <Heart size={sz} />;
    case 'entity:revealed':
      return <KeyRound size={sz} />;
    case 'location:first_entry':
      return <Compass size={sz} />;
    case 'location:memory_added':
      return <Brain size={sz} />;
    case 'actor:status_changed':
      return <Users size={sz} />;
    case 'media:shown':
      return <Eye size={sz} />;
    case 'entity:duplicate_warning':
    case 'movement:teleport_detected':
      return <AlertTriangle size={sz} />;
    case 'companion:added':
    case 'companion:removed':
    case 'companion:auto_departed':
    case 'npc:moved_with_player':
      return <Footprints size={sz} />;
    case 'quest_pacer:overload':
    case 'quest_pacer:stale':
    case 'quest_pacer:dead_npc_arc':
      return <ScrollText size={sz} />;
    case 'adventure:oracle_rolled':
      return <Dice5 size={sz} />;
    case 'adventure:hook':
      return <Compass size={sz} />;
    case 'adventure:accepted':
      return <CheckCircle2 size={sz} />;
    case 'adventure:ignored':
    case 'adventure:expired':
      return <AlertTriangle size={sz} />;
    case 'npc:initiative':
      return <Flag size={sz} />;
    case 'intimacy:trigger':
      return <Flame size={sz} />;
    case 'narrate:quarantined':
    case 'post_turn:slot_failed':
      return <AlertTriangle size={sz} />;
    default:
      return <Sparkles size={sz} />;
  }
}

export function variantClass(t: SystemEventType, mode?: string): string {
  if (t.startsWith('quest:')) return 'quest';
  if (t.startsWith('scene:')) return 'dialogue';
  if (t.startsWith('materializer:')) return 'reveal';
  if (t === 'memory:added') return 'memory';
  if (t === 'memory:enriched') return 'memory';
  if (t === 'string:changed') return 'string';
  if (t === 'damage:dealt') return 'damage';
  if (t.startsWith('xp:')) return 'xp';
  if (t.startsWith('inspiration:')) return 'inspiration';
  if (
    t === 'dialogue:engaged' ||
    t === 'dialogue:noticed' ||
    t === 'dialogue:partner_switched'
  ) {
    return 'dialogue';
  }
  if (t === 'dice:rolled') return 'dice';
  if (t === 'sex_move:fired' || t === 'intimacy:trigger') return 'string';
  if (t === 'entity:revealed') return 'reveal';
  if (t === 'location:first_entry') return 'mode-exploration';
  if (t === 'location:memory_added') return 'memory';
  if (t === 'actor:status_changed') return 'string';
  if (t === 'media:shown') return 'reveal';
  if (t === 'entity:duplicate_warning') return 'neutral';
  if (t === 'movement:teleport_detected') return 'damage';
  if (
    t === 'companion:added' ||
    t === 'companion:removed' ||
    t === 'companion:auto_departed' ||
    t === 'npc:moved_with_player'
  ) {
    return 'string';
  }
  if (
    t === 'quest_pacer:overload' ||
    t === 'quest_pacer:stale' ||
    t === 'quest_pacer:dead_npc_arc'
  ) {
    return 'quest';
  }
  if (t.startsWith('adventure:')) return 'adventure';
  if (t === 'npc:initiative') return 'damage';
  if (t === 'narrate:quarantined') return 'neutral';
  if (t === 'post_turn:slot_failed') return 'neutral';
  if (t === 'mode:changed') {
    switch (mode) {
      case 'combat':
        return 'damage';
      case 'intimacy':
        return 'string';
      case 'dialogue':
        return 'dialogue';
      case 'travel':
        return 'mode-travel';
      case 'rest':
        return 'mode-rest';
      case 'exploration':
      default:
        return 'mode-exploration';
    }
  }
  return 'neutral';
}
