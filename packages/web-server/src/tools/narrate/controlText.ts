/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — narrate "control text" detectors. These guard rails reject
// narrator prose that is actually a dumped tool-call list, a pure
// JSON wrapper, or the broker "Broker stage complete" sentinel.
//
// `isToolFunctionDumpText` and `isNarrateControlText` were inlined
// in `tools/narrate.ts` before this slice; they now live next to
// the JSON-scan helpers they depend on (`collectNarrateTextValues`,
// `isPureJsonNarrateDump`).

import {collectNarrateTextValues, isPureJsonNarrateDump} from './jsonText.js';

const TOOL_FUNCTION_NAMES = [
  'add_memory',
  'advance_quest',
  'apply_intimacy_trigger',
  'apply_companion_rule_contract',
  'apply_relationship_trigger_rule',
  'apply_runtime_field_patch',
  'apply_surface',
  'award_inspiration',
  'award_progression_xp',
  'award_title',
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
  'equip_title',
  'evaluate_social_standing',
  'get_recent_history',
  'get_runtime_field',
  'give_to_npc',
  'heal',
  'inventory_transfer',
  'mark_downed',
  'move_player',
  'narrate',
  'predict_consequence',
  'query_entity',
  'query_inventory',
  'query_memory',
  'query_player_profile',
  'query_player_state',
  'search_entities',
  'set_companion',
  'set_runtime_field',
  'spend_inspiration',
  'spend_skill_point',
  'spend_stat_point',
  'stabilize',
  'start_quest',
  'string_award',
  'string_spend',
  'summarize_relationships',
  'switch_dialogue_partner',
  'unlock_skill',
  'update_entity',
  'use_item',
] as const;

const MUTATION_TOOL_FUNCTION_NAMES = TOOL_FUNCTION_NAMES.filter(
  (name) =>
    ![
      'evaluate_social_standing',
      'get_recent_history',
      'get_runtime_field',
      'predict_consequence',
      'query_entity',
      'query_inventory',
      'query_memory',
      'query_player_profile',
      'query_player_state',
      'search_entities',
      'summarize_relationships',
    ].includes(name),
);

const TOOL_FUNCTION_PATTERN = TOOL_FUNCTION_NAMES.join('|');
const MUTATION_TOOL_FUNCTION_PATTERN = MUTATION_TOOL_FUNCTION_NAMES.join('|');
const TOOL_FUNCTION_AT_START_RE = new RegExp(
  `^(?:[\\s>*_\`~.-]+)?(?:${TOOL_FUNCTION_PATTERN})\\s*\\(`,
  'i',
);
const TOOL_FUNCTION_ANY_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}_])(?:${TOOL_FUNCTION_PATTERN})\\s*\\(`,
  'giu',
);
const MUTATION_TOOL_FUNCTION_ANY_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}_])(?:${MUTATION_TOOL_FUNCTION_PATTERN})\\s*\\(`,
  'iu',
);

export function isToolFunctionDumpText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (TOOL_FUNCTION_AT_START_RE.test(t)) return true;
  if (MUTATION_TOOL_FUNCTION_ANY_RE.test(t)) return true;
  const calls = t.match(TOOL_FUNCTION_ANY_RE) ?? [];
  return calls.length >= 2;
}

export function isNarrateControlText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // LANGUAGE-REGEX-OK: literal control-text marker emitted by the broker handoff machinery ("Broker stage complete"). Wire-format string, not natural language; matches the same marker used in `protagonistActionRenderer.ts`.
  if (/\bBroker stage complete\b/i.test(t)) return true;
  if (isToolFunctionDumpText(t)) return true;
  if (/```(?:json)?/i.test(t) && collectNarrateTextValues(t).length > 0) {
    return true;
  }
  if (isPureJsonNarrateDump(t)) return true;
  return false;
}
