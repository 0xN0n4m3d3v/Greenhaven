/**
 * Scripted action router.
 *
 * Button actions are resolved by specialist modules before the LLM turn:
 * social/item checks in checks.ts, combat rounds in combat.ts. This file
 * only decodes action ids and routes to the right deterministic resolver.
 *
 * ARCH-13 — wire-format parsing for `social:<npcId>:<checkKind>`,
 * `item-check:<itemId>:<checkKind>`, and `attack:<npcId>` lives in
 * `scriptedActions/actionIds.ts`. This router consumes the typed
 * `ParsedScriptedAction` discriminated union and only dispatches.
 */

import type {Session} from './sessionManager.js';
import {parseScriptedActionId} from './scriptedActions/actionIds.js';
import {scriptAttack} from './scriptedActions/combat.js';
import {
  scriptItemCheck,
  scriptSocialCheck,
} from './scriptedActions/checks.js';
import type {ScriptResult} from './scriptedActions/common.js';
import {dispatch} from './tools/base.js';

/**
 * Detect if the input actionId is a scripted-action prefix and resolve
 * the mechanic server-side. Returns null for free-text turns and
 * non-scripted action ids.
 */
export async function maybeScriptAction(
  session: Session,
  playerId: number,
  actionId: string | undefined,
  turnId: string,
): Promise<ScriptResult | null> {
  const parsed = parseScriptedActionId(actionId);
  if (parsed === null) return null;
  switch (parsed.kind) {
    case 'social':
      return scriptSocialCheck(
        session,
        playerId,
        parsed.npcId,
        parsed.checkKind,
        turnId,
      );
    case 'item-check':
      return scriptItemCheck(
        session,
        playerId,
        parsed.itemId,
        parsed.checkKind,
        turnId,
      );
    case 'attack':
      return scriptAttack(session, playerId, parsed.npcId, turnId);
    case 'scene-choice':
      return scriptAuthoredSceneChoice(
        session,
        playerId,
        parsed.sceneSlug,
        parsed.choiceNumber,
        turnId,
      );
  }
}

async function scriptAuthoredSceneChoice(
  session: Session,
  playerId: number,
  sceneSlug: string,
  choiceNumber: number,
  turnId: string,
): Promise<ScriptResult> {
  const result = await dispatch(
    'choose_authored_scene_option',
    {
      scene_slug: sceneSlug,
      choice_number: choiceNumber,
      evidence: `Player selected scene option ${choiceNumber} from the UI.`,
    },
    {
      sessionId: session.id,
      playerId,
      turnId,
      toolHistorySource: 'direct',
      turnInputKind: 'player_action',
    },
  );
  if (!result.ok) {
    return {
      contextInjection: [
        '<authored_scene_choice>',
        `The player selected option ${choiceNumber} for authored scene "${sceneSlug}", but the deterministic scene-choice tool rejected it.`,
        `Tool error: ${result.error ?? 'unknown error'}`,
        'Narrate the failed attempt in-world and ask the player to choose an available scene option.',
        '</authored_scene_choice>',
      ].join('\n'),
    };
  }
  return {
    contextInjection: [
      '<authored_scene_choice>',
      `The player selected option ${choiceNumber} for authored scene "${sceneSlug}".`,
      'The server has already recorded the authored-scene choice through choose_authored_scene_option. Do not call choose_authored_scene_option again for this same click. Continue by narrating the immediate authored-scene consequence and the next concrete situation.',
      JSON.stringify(result.data ?? null),
      '</authored_scene_choice>',
    ].join('\n'),
  };
}
