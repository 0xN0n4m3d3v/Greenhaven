import type {ReactNode} from 'react';
import {MediaAsset} from '../media/MediaAsset';
import {modeLabel} from './EventCardChrome';
import type {SystemEvent, Translator} from './EventCardTypes';

export function renderWorldBody(
  event: SystemEvent,
  t: Translator,
): ReactNode | undefined {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'mode:changed': {
      const mode = (p['mode'] as string) ?? 'exploration';
      const prev = (p['prev'] as string) ?? null;
      return (
        <>
          <span className="event-card-title">{modeLabel(mode, t)}</span>
          {prev && prev !== mode && (
            <span className="event-card-meta">
              {' '}
              ({t('ui.event_card.body.mode.was')}: {modeLabel(prev, t)})
            </span>
          )}
        </>
      );
    }
    case 'dialogue:engaged': {
      const npc = (p['npcName'] as string) ?? (p['npc_name'] as string) ?? '?';
      return (
        <>
          <span className="event-card-meta">
            {t('ui.event_card.body.dialogue.with')}{' '}
          </span>
          <span className="event-card-actor">{npc}</span>
        </>
      );
    }
    case 'dialogue:noticed': {
      const npc =
        (p['npcName'] as string) ?? (p['npc_name'] as string) ?? '?';
      const reason = (p['reason'] as string) ?? null;
      return (
        <>
          <span className="event-card-actor">{npc}</span>{' '}
          <span className="event-card-verb">
            {t('ui.event_card.body.dialogue.noticed')}
          </span>
          {reason && <p className="event-card-quote">{reason}</p>}
        </>
      );
    }
    case 'entity:revealed': {
      const name = (p['entityName'] as string) ?? '?';
      const stage = (p['stageId'] as string) ?? null;
      return (
        <>
          <span className="event-card-title">@{name}</span>
          {stage && (
            <span className="event-card-meta">
              {' '}
              ({t('ui.event_card.body.quest.stage')}: {stage})
            </span>
          )}
        </>
      );
    }
    case 'location:first_entry': {
      const location =
        (p['locationName'] as string) ?? (p['locationId'] as string) ?? '?';
      const intro = (p['introBubble'] as string | null) ?? null;
      const imageUrl =
        typeof p['locationImageUrl'] === 'string'
          ? (p['locationImageUrl'] as string)
          : null;
      const visitCount = Number(p['visitCount'] ?? 0);
      const firstVisit = p['firstVisit'] === true;
      return (
        <>
          <span className="event-card-title">@{location}</span>{' '}
          <span className="event-card-meta">
            {firstVisit
              ? t('ui.event_card.body.location.first_visit')
              : `${t('ui.event_card.body.location.visit')} #${visitCount || '?'}`}
          </span>
          {imageUrl && (
            <MediaAsset className="event-card-media" src={imageUrl} alt="" />
          )}
          {intro && <p className="event-card-quote">{intro}</p>}
        </>
      );
    }
    case 'location:memory_added': {
      const location =
        (p['locationName'] as string) ?? (p['locationId'] as string) ?? '?';
      const text = (p['text'] as string) ?? '';
      const kind = (p['kind'] as string) ?? (p['family'] as string) ?? null;
      return (
        <>
          <span className="event-card-title">@{location}</span>{' '}
          <span className="event-card-meta">
            {t('ui.event_card.body.location.remembered')}
            {kind ? ` (${kind})` : ''}
          </span>
          {text && <p className="event-card-quote">{text}</p>}
        </>
      );
    }
    case 'actor:status_changed': {
      const actor =
        (p['actorName'] as string) ?? (p['actorId'] as string) ?? '?';
      const statusKind = (p['statusKind'] as string) ?? 'status';
      const statusValue = (p['statusValue'] as string) ?? '';
      const reason = (p['reason'] as string | null) ?? null;
      const intensity =
        typeof p['intensity'] === 'number'
          ? (p['intensity'] as number)
          : Number.NaN;
      return (
        <>
          <span className="event-card-actor">@{actor}</span>{' '}
          <span className="event-card-meta">
            {t('ui.event_card.body.actor.status')}: {statusKind}
            {statusValue ? `=${statusValue}` : ''}
            {Number.isFinite(intensity)
              ? ` (${t('ui.event_card.body.actor.intensity')} ${intensity.toFixed(2)})`
              : ''}
          </span>
          {reason && <p className="event-card-quote">{reason}</p>}
        </>
      );
    }
    case 'entity:duplicate_warning': {
      const newName = (p['new_name'] as string) ?? '?';
      const matchName = (p['best_match_name'] as string) ?? '?';
      const score = Number(p['score'] ?? 0);
      const verdict = (p['verdict'] as string) ?? '';
      const reason = (p['reason'] as string) ?? null;
      return (
        <>
          <span className="event-card-title">@{newName}</span>{' '}
          <span className="event-card-meta">
            {t('ui.event_card.body.entity.looks_like')}
          </span>{' '}
          <span className="event-card-actor">@{matchName}</span>{' '}
          <span className="event-card-meta">
            (score={score.toFixed(2)}; verdict={verdict})
          </span>
          {reason && <p className="event-card-quote">{reason}</p>}
        </>
      );
    }
    case 'media:shown': {
      const title = (p['title'] as string) ?? (p['role'] as string) ?? 'Media';
      const caption = (p['caption'] as string | null) ?? null;
      const url = typeof p['url'] === 'string' ? (p['url'] as string) : null;
      const alt =
        (p['alt'] as string | null) ??
        (caption || title || (p['sourceName'] as string | undefined) || '');
      return (
        <>
          <span className="event-card-title">{title}</span>
          {url && <MediaAsset className="event-card-media" src={url} alt={alt} />}
          {caption && <p className="event-card-quote">{caption}</p>}
        </>
      );
    }
    case 'movement:teleport_detected': {
      const currName = (p['currentLocationName'] as string | null) ?? '?';
      const mentName = (p['mentionedLocationName'] as string) ?? '?';
      const excerpt = (p['narrateExcerpt'] as string) ?? '';
      const reason = (p['reason'] as string) ?? null;
      return (
        <>
          <span className="event-card-title">@{mentName}</span>{' '}
          <span className="event-card-meta">
            {t('ui.event_card.body.movement.no_move_player')}:
          </span>{' '}
          <span className="event-card-actor">@{currName}</span>
          {excerpt && <p className="event-card-quote">«{excerpt}»</p>}
          {reason && (
            <p className="event-card-meta event-card-meta--compact-stacked">
              {reason}
            </p>
          )}
        </>
      );
    }
    case 'companion:added':
    case 'companion:removed': {
      const npc = (p['npcName'] as string) ?? '?';
      const reason = (p['reason'] as string | null) ?? null;
      const total = p['total'] as number | undefined;
      return (
        <>
          <span className="event-card-actor">@{npc}</span>{' '}
          <span className="event-card-meta">
            {event.type === 'companion:added'
              ? t('ui.event_card.body.companion.added')
              : t('ui.event_card.body.companion.removed')}
          </span>
          {typeof total === 'number' && (
            <span className="event-card-meta">
              {' - '}{t('ui.event_card.body.companion.count')}: {total}
            </span>
          )}
          {reason && <p className="event-card-quote">{reason}</p>}
        </>
      );
    }
    case 'companion:auto_departed': {
      const npc = (p['npcName'] as string) ?? '?';
      const predicateKind = (p['predicate_kind'] as string) ?? '';
      const reason = (p['reason'] as string | null) ?? null;
      return (
        <>
          <span className="event-card-actor">@{npc}</span>{' '}
          <span className="event-card-meta">
            {t('ui.event_card.body.companion.auto_departed')}
            {predicateKind && (
              <>
                {' '}
                ({predicateKind})
              </>
            )}
          </span>
          {reason && <p className="event-card-quote">{reason}</p>}
        </>
      );
    }
    case 'npc:moved_with_player': {
      const npc = (p['npcName'] as string) ?? '?';
      const toName = (p['toName'] as string) ?? '?';
      return (
        <>
          <span className="event-card-actor">@{npc}</span>{' '}
          <span className="event-card-meta">
            {t('ui.event_card.body.companion.moved_with_player')}
          </span>{' '}
          <span className="event-card-title">@{toName}</span>
        </>
      );
    }
    case 'dialogue:partner_switched': {
      const fromName = (p['fromName'] as string) ?? null;
      const toName =
        (p['toName'] as string) ?? (p['partner_name'] as string) ?? (p['name'] as string) ?? (p['npcName'] as string) ?? (
          p['reason'] === 'player_moved' ? '—' : 
          p['partner_id'] === null ? '—' : 
          '—'
        );
      return (
        <>
          {fromName && (
            <>
              <span className="event-card-meta">{fromName}</span>{' '}
              <span className="event-card-meta">→</span>{' '}
            </>
          )}
          <span className="event-card-actor">{toName}</span>
        </>
      );
    }
    default:
      return undefined;
  }
}
