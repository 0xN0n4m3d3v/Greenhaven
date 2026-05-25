/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — `## SCENE INSTRUCTIONS` preamble renderer.
//
// Pulls authored scene rows from `SceneInstructionBridgeService` and
// renders a compact, deterministic block the broker can read at the
// top of the static preamble. Each row is one indented bullet with
// the trigger, behavior, do-not, and voice fields trimmed to a
// shared cap so the section stays prompt-budget friendly.
//
// No mutations: this module is purely read + format. Missing or
// wrong-schema-version bridge meta resolves to an empty block and
// the section is skipped upstream.

import {
  listRelevantSceneInstructions,
  type SceneInstructionEntry,
} from '../services/SceneInstructionBridgeService.js';

interface RenderOpts {
  locationId: number | null;
  focusedNpcId: number | null;
  participantIds: readonly number[];
  /** Soft cap on how many scene rows render. Defaults to 4 so the
   *  block stays short across multi-NPC encounters. */
  limit?: number;
  /** Trim cap for each long-form field. Defaults to 320 chars. */
  fieldCharCap?: number;
  /** Active cartridge id — threaded through to
   *  `SceneInstructionBridgeService` so the catalog comes from the
   *  per-cartridge `cartridge_meta_scoped` row when available. */
  cartridgeId?: string | null;
}

const DEFAULT_LIMIT = 4;
const DEFAULT_FIELD_CAP = 320;

export async function renderSceneInstructions(opts: RenderOpts): Promise<string> {
  const limit = Math.max(0, opts.limit ?? DEFAULT_LIMIT);
  if (limit === 0) return '';
  const rows = await listRelevantSceneInstructions({
    locationId: opts.locationId,
    focusedNpcId: opts.focusedNpcId,
    participantIds: opts.participantIds,
    limit,
    cartridgeId: opts.cartridgeId ?? null,
  });
  if (rows.length === 0) return '';
  const cap = Math.max(80, opts.fieldCharCap ?? DEFAULT_FIELD_CAP);
  const lines: string[] = ['## SCENE INSTRUCTIONS'];
  for (const row of rows) {
    lines.push(renderRow(row, cap));
  }
  return lines.join('\n');
}

function renderRow(row: SceneInstructionEntry, cap: number): string {
  const anchor = describeAnchor(row);
  const out: string[] = [];
  out.push(
    `- ${row.sceneMention} (${row.sceneSlug}) — priority: ${row.priority}${
      anchor ? `; ${anchor}` : ''
    }`,
  );
  const trigger = trimField(row.trigger, cap);
  if (trigger) out.push(`  trigger: ${trigger}`);
  const hook = trimField(row.hook, cap);
  if (hook) out.push(`  hook: ${hook}`);
  const beats = trimField(row.beatByBeat, cap);
  if (beats) out.push(`  beat_by_beat: ${beats}`);
  const choices = trimField(row.playerChoices, cap);
  if (choices) out.push(`  player_choices: ${choices}`);
  const behavior = trimField(row.behavior, cap);
  if (behavior) out.push(`  behavior: ${behavior}`);
  const memory = trimField(row.memoryAndStringChanges, cap);
  if (memory) out.push(`  memory_and_string_changes: ${memory}`);
  const success = trimField(row.successResult, cap);
  if (success) out.push(`  success_result: ${success}`);
  const failure = trimField(row.failureResult, cap);
  if (failure) out.push(`  failure_result: ${failure}`);
  const doNot = trimField(row.doNot, cap);
  if (doNot) out.push(`  do_not: ${doNot}`);
  const voice = trimField(row.voice, cap);
  if (voice) out.push(`  voice: ${voice}`);
  const model = row.modelInstructions
    .map(s => trimField(s, cap))
    .filter((s): s is string => s.length > 0)
    .slice(0, 3);
  if (model.length > 0) out.push(`  model: ${model.join(' | ')}`);
  return out.join('\n');
}

function describeAnchor(row: SceneInstructionEntry): string {
  const parts: string[] = [];
  if (row.locationEntityId != null && row.locationSlug) {
    parts.push(`location ${row.locationSlug} (#${row.locationEntityId})`);
  } else if (row.locationSlug) {
    parts.push(`location ${row.locationSlug}`);
  }
  if (row.ownerNpcEntityId != null && row.ownerNpcSlug) {
    parts.push(`owner ${row.ownerNpcSlug} (#${row.ownerNpcEntityId})`);
  } else if (row.ownerNpcSlug) {
    parts.push(`owner ${row.ownerNpcSlug}`);
  }
  if (row.participantSlugs.length > 0) {
    parts.push(`participants: ${row.participantSlugs.join(', ')}`);
  }
  return parts.join(' · ');
}

function trimField(value: string, cap: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= cap) return collapsed;
  return `${collapsed.slice(0, cap - 1).trimEnd()}…`;
}
