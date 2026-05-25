// Spec 29 §A.3 — bubble context menu extracted from App.tsx.
//
// Opens on left-click (filtered to non-button targets) or right-click
// of any chat bubble; lists per-entity affordances + Reply / Close.
// Pure render; all callbacks are passed in.

import type {DiceRoll} from '../../DiceBubble';
import {localizedAffordanceMessage} from '../../lib/actionText';
import type {AffordanceAction} from '../../types/affordance';
import {ScrollArea} from '../ui/scroll-area';
import {Tooltip, TooltipContent, TooltipTrigger} from '../ui/tooltip';

export interface BubbleMenuState {
  messageId: number;
  npcId: number | null;
  npcName: string | null;
  author: string | null;
  dice: DiceRoll[];
  entityId?: number;
  entityName?: string;
  entityType?: string;
}

export interface BubbleMenuProps {
  menu: BubbleMenuState;
  affordances: AffordanceAction[];
  language?: string | null;
  t: (key: string, vars?: Record<string, string>) => string;
  onClose: () => void;
  onStartDialogue: (npcId: number, npcName: string) => void;
  onRunAction: (message: string, actionId: string) => void;
}

export function BubbleMenu({
  menu,
  affordances,
  language,
  t,
  onClose,
  onStartDialogue,
  onRunAction,
}: BubbleMenuProps) {
  const entityActions =
    menu.entityId != null
      ? affordances.filter(a => a?.entity_id === menu.entityId)
      : [];
  return (
    <div
      className="bubble-menu-backdrop gh-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bubble-menu-title"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bubble-menu gh-panel gh-bubble-menu">
        <h3 id="bubble-menu-title">
          {menu.entityName ??
            menu.npcName ??
            menu.author ??
            t('ui.bubble_menu.title_default')}
        </h3>
        {menu.dice.length > 0 && (
          <div className="bubble-menu-dice">
            <div className="bubble-menu-dice-title">
              {t('ui.bubble_menu.rolls', {n: String(menu.dice.length)})}
            </div>
            {menu.dice.map((d, i) => (
              <div
                key={i}
                className={`bubble-menu-dice-row ${d.roller === 'npc' ? 'npc' : 'player'} ${d.outcome ?? ''}`}
              >
                <span className="bubble-menu-dice-roll">{d.roll}</span>
                {d.dc != null && (
                  <span className="bubble-menu-dice-dc">
                    {t('dice.vs_dc')} {d.dc}
                  </span>
                )}
                {d.outcome && (
                  <span className={`bubble-menu-dice-outcome ${d.outcome}`}>
                    {d.outcome === 'success'
                      ? t('dice.success')
                      : t('dice.failure')}
                  </span>
                )}
                {d.description && (
                  <span className="bubble-menu-dice-label">{d.description}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {menu.npcId != null && menu.npcName && (
          <button
            type="button"
            className="bubble-menu-action primary gh-control"
            onClick={() => onStartDialogue(menu.npcId!, menu.npcName!)}
          >
            {t('ui.bubble_menu.reply')}
          </button>
        )}
        <ScrollArea className="bubble-menu-actions">
        {entityActions.map(a => {
          const messageVars =
            a.message_vars && typeof a.message_vars === 'object'
              ? (a.message_vars as Record<string, string | number>)
              : {};
          const ent =
            menu.entityName ??
            (typeof messageVars.name === 'string' ? messageVars.name : '');
          const actionMessage = localizedAffordanceMessage(
            {
              id: a.id,
              kind: a.kind,
              entityName: ent,
              fallbackLabel: a.label,
              messageKey: a.message_key,
              messageVars,
            },
            language,
          );
          let label = a.label;
          if (typeof a.kind === 'string' && a.kind.startsWith('social-')) {
            const key = `ui.actions.${a.kind.slice('social-'.length)}`;
            const trans = t(key, {name: ent});
            if (trans !== key) label = trans;
          } else if (a.kind === 'attack') {
            const trans = t('ui.actions.attack', {name: ent});
            if (trans !== 'ui.actions.attack') label = trans;
          } else if (a.kind === 'item-check') {
            label = actionMessage;
          } else if (
            a.kind === 'travel' ||
            a.kind === 'string-spend' ||
            a.kind === 'inspiration-spend'
          ) {
            label = actionMessage;
          }
          const dc = a.dice_check?.dc;
          const button = (
            <button
              key={a.id}
              type="button"
              className="bubble-menu-action has-dice gh-control"
              onClick={() => {
                onClose();
                onRunAction(actionMessage, a.id);
              }}
            >
              {dc != null && (
                <span className="dice-chip">
                  d20 · {a.ability ?? ''} {t('dice.vs_dc')} {dc}
                </span>
              )}
              <span className="bubble-menu-action-label">{label}</span>
            </button>
          );
          // Tooltip surfaces the literal cartridge label when the
          // translated label has been re-keyed to a verb-noun phrase
          // (e.g. "Seduce Mikka" replacing "social-seduce").
          if (label !== a.label) {
            return (
              <Tooltip key={a.id}>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent>{a.label}</TooltipContent>
              </Tooltip>
            );
          }
          return button;
        })}
        </ScrollArea>
        <button
          type="button"
          className="bubble-menu-action gh-control"
          onClick={onClose}
        >
          {t('ui.bubble_menu.close')}
        </button>
      </div>
    </div>
  );
}
