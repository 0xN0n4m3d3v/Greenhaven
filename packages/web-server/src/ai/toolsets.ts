/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Explicit role toolsets. The registry remains flat, but each agent receives a
// role-filtered view so prompt scope and executable tool scope stay aligned.

import type {ProfileHint} from './classifier.js';
import type { ToolDefinition } from '../tools/base.js';

export type AgentToolRole = 'broker' | 'narrator' | 'scene_painter';
export type BrokerToolProfile =
  | 'adventure_accept'
  | 'adventure_ignore'
  | 'commerce_bargain'
  | 'commerce_social'
  | 'default'
  | 'environment_probe'
  | 'intimacy_social'
  | 'quest_detail'
  | 'quest_seed'
  | 'scene_trade'
  | 'state_recap'
  | 'movement_social';

export function toolsForRole(
  tools: ReadonlyMap<string, ToolDefinition>,
  role: AgentToolRole,
): Map<string, ToolDefinition> {
  if (role === 'narrator' || role === 'scene_painter') {
    return pickTools(tools, ['narrate']);
  }

  return pickTools(tools, [
    'add_memory',
    'apply_intimacy_trigger',
    'apply_runtime_field_patch',
    'choose_authored_scene_option',
    'close_authored_scene',
    'apply_surface',
    'award_inspiration',
    'award_xp',
    'batch_mutate_world',
    'bump_memory_salience',
    'change_stat',
    'complete_quest',
    'create_entity',
    'create_quest',
    'damage',
    'death_save',
    'dice_check',
    'equip_item',
    'evaluate_social_standing',
    'get_recent_history',
    'get_runtime_field',
    'give_to_npc',
    'heal',
    'inventory_transfer',
    'mark_downed',
    'move_player',
    'narrate',
    'open_authored_scene',
    'predict_consequence',
    'query_entity',
    'query_inventory',
    'query_memory',
    'recall_partner_history',
    'query_player_profile',
    'query_player_state',
    'record_location_memory',
    'remove',
    'search_entities',
    'set_actor_status',
    'set_companion',
    'set_runtime_field',
    'spend_inspiration',
    'stabilize',
    'start_quest',
    'advance_quest',
    'string_award',
    'string_spend',
    'summarize_relationships',
    'switch_dialogue_partner',
    'unlock_skill',
    'update_entity',
    'use_item',
  ]);
}

export function toolsForBrokerMode(
  tools: ReadonlyMap<string, ToolDefinition>,
  mode: string,
  profile: BrokerToolProfile = 'default',
): Map<string, ToolDefinition> {
  if (profile === 'commerce_social') {
    return pickTools(tools, [
      'add_memory',
      'dice_check',
      'evaluate_social_standing',
      'inventory_transfer',
      'narrate',
      'query_entity',
      'query_inventory',
      'query_memory',
      'recall_partner_history',
      'query_player_state',
      'set_actor_status',
      'string_award',
      'string_spend',
    ]);
  }

  if (profile === 'commerce_bargain') {
    return pickTools(tools, [
      'add_memory',
      'batch_mutate_world',
      'dice_check',
      'evaluate_social_standing',
      'inventory_transfer',
      'narrate',
      'query_entity',
      'query_player_state',
      'record_location_memory',
    ]);
  }

  if (profile === 'scene_trade') {
    return pickTools(tools, [
      'batch_mutate_world',
      'dice_check',
      'narrate',
      'query_inventory',
      'query_player_state',
    ]);
  }

  if (profile === 'quest_seed') {
    return pickTools(tools, [
      'add_memory',
      'create_quest',
      'dice_check',
      'narrate',
      'query_entity',
      'record_location_memory',
    ]);
  }

  if (profile === 'quest_detail') {
    return pickTools(tools, [
      'get_recent_history',
      'narrate',
      'query_entity',
      'query_inventory',
      'query_memory',
      'recall_partner_history',
      'query_player_state',
      'record_location_memory',
    ]);
  }

  if (profile === 'adventure_accept') {
    return pickTools(tools, [
      'add_memory',
      'advance_quest',
      'choose_authored_scene_option',
      'close_authored_scene',
      'create_quest',
      'dice_check',
      'move_player',
      'narrate',
      'open_authored_scene',
      'query_entity',
      'query_player_state',
      'record_location_memory',
      'start_quest',
    ]);
  }

  if (profile === 'adventure_ignore') {
    return pickTools(tools, [
      'add_memory',
      'evaluate_social_standing',
      'narrate',
      'query_entity',
      'query_memory',
      'query_player_state',
      'record_location_memory',
      'set_actor_status',
      'string_award',
      'string_spend',
    ]);
  }

  if (profile === 'intimacy_social') {
    return pickTools(tools, [
      'add_memory',
      'advance_quest',
      'apply_intimacy_trigger',
      'dice_check',
      'inventory_transfer',
      'narrate',
      'query_entity',
      'query_player_state',
      'record_location_memory',
      'set_actor_status',
      'start_quest',
      'string_award',
    ]);
  }

  if (profile === 'state_recap') {
    return pickTools(tools, [
      'add_memory',
      'advance_quest',
      'complete_quest',
      'dice_check',
      'get_recent_history',
      'narrate',
      'query_entity',
      'query_inventory',
      'query_memory',
      'recall_partner_history',
      'query_player_state',
      'record_location_memory',
      'set_actor_status',
    ]);
  }

  if (profile === 'environment_probe') {
    return pickTools(tools, [
      'add_memory',
      'apply_runtime_field_patch',
      'apply_surface',
      'dice_check',
      'get_runtime_field',
      'narrate',
      'query_entity',
      'query_player_state',
      'record_location_memory',
    ]);
  }

  if (profile === 'movement_social') {
    return pickTools(tools, [
      'add_memory',
      'apply_runtime_field_patch',
      'choose_authored_scene_option',
      'close_authored_scene',
      'dice_check',
      'get_runtime_field',
      'move_player',
      'narrate',
      'open_authored_scene',
      'query_entity',
      'query_memory',
      'recall_partner_history',
      'query_player_profile',
      'query_player_state',
      'record_location_memory',
      'set_actor_status',
      'set_companion',
      'set_runtime_field',
      'switch_dialogue_partner',
    ]);
  }

  const names = new Set<string>([
    'add_memory',
    'apply_runtime_field_patch',
    'choose_authored_scene_option',
    'close_authored_scene',
    'award_inspiration',
    'award_xp',
    'batch_mutate_world',
    'complete_quest',
    'create_entity',
    'create_quest',
    'dice_check',
    'equip_item',
    'get_recent_history',
    'get_runtime_field',
    'give_to_npc',
    'inventory_transfer',
    'move_player',
    'narrate',
    'open_authored_scene',
    'query_entity',
    'query_inventory',
    'query_memory',
    'recall_partner_history',
    'query_player_profile',
    'query_player_state',
    'record_location_memory',
    'search_entities',
    'set_actor_status',
    'set_companion',
    'set_runtime_field',
    'spend_inspiration',
    'start_quest',
    'advance_quest',
    'switch_dialogue_partner',
    'update_entity',
    'use_item',
  ]);

  if (mode === 'combat') {
    for (const name of [
      'apply_surface',
      'change_stat',
      'damage',
      'death_save',
      'heal',
      'mark_downed',
      'stabilize',
      'string_award',
      'string_spend',
    ]) {
      names.add(name);
    }
  } else if (mode === 'intimacy') {
    for (const name of [
      'apply_intimacy_trigger',
      'apply_surface',
      'bump_memory_salience',
      'evaluate_social_standing',
      'string_award',
      'string_spend',
      'summarize_relationships',
    ]) {
      names.add(name);
    }
  } else if (mode === 'dialogue') {
    for (const name of [
      'bump_memory_salience',
      'evaluate_social_standing',
      'string_award',
      'string_spend',
      'summarize_relationships',
    ]) {
      names.add(name);
    }
  } else {
    for (const name of ['apply_surface', 'heal', 'unlock_skill']) {
      names.add(name);
    }
  }

  return pickTools(tools, [...names]);
}

/**
 * X-3 classifier-hint refactor — pick the focused broker tool profile
 * for a turn from `(mode, profileHint)` only. The profile hint comes
 * from `classifyTurnRoute` (see `ai/classifier.ts`), which classifies
 * by INTENT in any language. We never read raw player text here, so
 * routing stays multilingual by construction. The intimacy fast-path
 * stays because the `intimacy_social` profile carries a mandatory
 * consent/state contract that must not be skipped even if the
 * classifier proposes a different focused profile.
 */
export function brokerToolProfileForTurn(
  mode: string,
  profileHint: ProfileHint = 'default',
): BrokerToolProfile {
  if (mode === 'intimacy') return 'intimacy_social';
  if (profileHint === 'state_recap') return 'state_recap';
  if (profileHint === 'scene_trade') return 'scene_trade';
  if (profileHint === 'commerce_bargain') return 'commerce_bargain';
  return 'default';
}

function pickTools(
  tools: ReadonlyMap<string, ToolDefinition>,
  names: readonly string[],
): Map<string, ToolDefinition> {
  const picked = new Map<string, ToolDefinition>();
  for (const name of names) {
    const def = tools.get(name);
    if (def) picked.set(name, def);
  }
  return picked;
}
