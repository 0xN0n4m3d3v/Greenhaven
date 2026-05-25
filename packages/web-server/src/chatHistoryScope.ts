/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared SQL fragments for prompt-facing chat history.
//
// New chat rows should carry chat_messages.player_id. Older migrated rows may
// have player_id=NULL, so prompt context may keep those only when the author is
// not a different player entity. This keeps legacy NPC/narrator rows usable
// while preventing repaired placeholder-player text from leaking back into a
// current player's prompt.

export function chatAlias(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed) return '';
  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

export function playerScopedChatPredicate(
  alias: string,
  playerParamIndex: number,
): string {
  const a = chatAlias(alias);
  const playerParam = `$${playerParamIndex}`;
  return `(${a}player_id = ${playerParam} OR (${a}player_id IS NULL AND NOT EXISTS (SELECT 1 FROM players gh_scope_player WHERE gh_scope_player.entity_id = ${a}author_entity_id AND gh_scope_player.entity_id <> ${playerParam})))`;
}

export function sessionPlayerScopedChatPredicate(
  alias: string,
  sessionParamIndex: number,
  playerParamIndex: number,
): string {
  const a = chatAlias(alias);
  return `${a}session_id = $${sessionParamIndex} AND ${playerScopedChatPredicate(alias, playerParamIndex)}`;
}
