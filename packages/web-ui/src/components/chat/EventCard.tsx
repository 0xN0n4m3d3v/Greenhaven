// LitRPG-style system event cards inserted inline into the chat flow.
//
// This component owns only the visual shell and body-renderer dispatch.
// Timeline ordering belongs to the bridge/outbox layer.

import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import {
  renderAdventureBody,
  renderAdventureEvent,
  type AdventureEventContext,
} from './EventCardAdventure';
import { renderCombatBody } from './EventCardCombat';
import { eventIcon, pickHeader, variantClass } from './EventCardChrome';
import { renderMemoryBody } from './EventCardMemory';
import { renderProgressBody } from './EventCardProgress';
import { renderQuestBody } from './EventCardQuest';
import { renderSceneBody, type SceneEventContext } from './EventCardScene';
import { renderSystemBody } from './EventCardSystem';
import type { SystemEvent, Translator } from './EventCardTypes';
import { renderWorldBody } from './EventCardWorld';

export type { SystemEvent, SystemEventType } from './EventCardTypes';

interface Props {
  event: SystemEvent;
  adventureContext?: AdventureEventContext;
  sceneContext?: SceneEventContext;
}

function formatBody(
  event: SystemEvent,
  t: Translator,
  sceneContext?: SceneEventContext,
): ReactNode {
  return (
    renderAdventureBody(event, t) ??
    renderQuestBody(event, t) ??
    renderSceneBody(event, t, sceneContext) ??
    renderMemoryBody(event, t) ??
    renderProgressBody(event, t) ??
    renderCombatBody(event, t) ??
    renderWorldBody(event, t) ??
    renderSystemBody(event, t) ??
    null
  );
}

// Spec 139 v2 — event types the player should NEVER see in chat. Mostly
// internal mechanical noise (oracle dice rolls, queue housekeeping).
const HIDDEN_EVENT_TYPES = new Set<string>(['adventure:oracle_rolled']);

export function EventCard({
  event,
  compact = true,
  adventureContext,
  sceneContext,
}: Props & { compact?: boolean }) {
  const { t } = useTranslation();
  if (HIDDEN_EVENT_TYPES.has(event.type)) return null;
  const customAdventureEvent = renderAdventureEvent(event, t, adventureContext);
  if (customAdventureEvent !== undefined) {
    return customAdventureEvent;
  }
  const mode = (event.payload['mode'] as string | undefined) ?? undefined;
  const variant = variantClass(event.type, mode);
  return (
    <div
      className={`event-card event-card-${variant} ${compact ? 'event-card-compact' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="event-card-strip" />
      <div className="event-card-body">
        <div className="event-card-header">
          {eventIcon(event.type, mode)}
          <span className="event-card-label">{pickHeader(event.type, t)}</span>
        </div>
        <div className="event-card-content">
          {formatBody(event, t, sceneContext)}
        </div>
      </div>
    </div>
  );
}
