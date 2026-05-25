import type {ReactNode} from 'react';
import {CheckCircle2} from 'lucide-react';
import {MediaAsset} from '../media/MediaAsset';
import type {SystemEvent, Translator} from './EventCardTypes';

export interface SceneEventContext {
  busy?: boolean;
  onChooseSceneOption?: (
    message: string,
    actionId: string,
  ) => void | Promise<void>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function choicesFromPayload(payload: Record<string, unknown>): string[] {
  const choices = payload['choices'];
  if (!Array.isArray(choices)) return [];
  return choices
    .map((choice) => text(choice))
    .filter((choice): choice is string => choice != null)
    .slice(0, 12);
}

function chooseMessage(choice: string): string {
  return choice;
}

export function renderSceneBody(
  event: SystemEvent,
  t: Translator,
  context?: SceneEventContext,
): ReactNode | undefined {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'scene:opened': {
      const scene =
        text(p['sceneMention']) ??
        text(p['sceneSlug']) ??
        text(p['scene_slug']) ??
        '?';
      const sceneSlug =
        text(p['sceneSlug']) ?? text(p['scene_slug']) ?? scene;
      const choices = choicesFromPayload(p);
      const scenePlateUrl = text(p['scenePlateUrl']);
      return (
        <>
          <span className="event-card-title">{scene}</span>
          {scenePlateUrl && (
            <MediaAsset className="event-card-media" src={scenePlateUrl} alt="" />
          )}
          {choices.length > 0 && (
            <div className="event-card-actions event-card-actions--stacked">
              {choices.map((choice, i) => {
                const n = i + 1;
                return (
                  <button
                    key={`${sceneSlug}-${n}`}
                    type="button"
                    disabled={context?.busy === true}
                    onClick={() =>
                      context?.onChooseSceneOption?.(
                        chooseMessage(choice),
                        `scene.choose:${sceneSlug}:${n}`,
                      )
                    }
                    title={choice}
                  >
                    <CheckCircle2 size={13} />
                    <span>{choice}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      );
    }
    case 'scene:choice_selected': {
      const scene =
        text(p['sceneMention']) ?? text(p['sceneSlug']) ?? '?';
      const n = number(p['choiceNumber']);
      const choice = text(p['choiceText']);
      return (
        <>
          <span className="event-card-title">{scene}</span>
          <span className="event-card-meta">
            {' - '}
            {t('ui.event_card.body.scene.choice_selected')}
            {n != null ? ` ${n}` : ''}
          </span>
          {choice && <p className="event-card-quote">{choice}</p>}
        </>
      );
    }
    case 'scene:closed': {
      const scene =
        text(p['sceneMention']) ?? text(p['sceneSlug']) ?? '?';
      const result = text(p['result']) ?? 'neutral';
      const summary = text(p['outcomeSummary']);
      return (
        <>
          <span className="event-card-title">{scene}</span>
          <span className="event-card-meta">
            {' - '}
            {t(`ui.event_card.body.scene.result.${result}`)}
          </span>
          {summary && <p className="event-card-quote">{summary}</p>}
        </>
      );
    }
    case 'materializer:applied': {
      const type = text(p['type']) ?? 'materializer';
      const created = p['target_entity_created'] === true;
      return (
        <>
          <span className="event-card-title">{type}</span>
          <span className="event-card-meta">
            {' - '}
            {created
              ? t('ui.event_card.body.materializer.created')
              : t('ui.event_card.body.materializer.applied')}
          </span>
        </>
      );
    }
    case 'materializer:auto_applied': {
      const applied = Array.isArray(p['applied']) ? p['applied'].length : 0;
      const rejected = Array.isArray(p['rejected']) ? p['rejected'].length : 0;
      return (
        <p className="event-card-meta">
          {t('ui.event_card.body.materializer.auto_applied', {n: applied})}
          {rejected > 0 ? ` / ${rejected} rejected` : ''}
        </p>
      );
    }
    default:
      return undefined;
  }
}
