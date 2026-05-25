/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 35 §2 — scripted intimacy actions.
//
// When classifyMode returns 'intimacy' for a turn, the broker prompt
// gets an injection that DEMANDS specific tool calls if the prose
// depicts a trigger event. Determinism floor: prose can be brief,
// but the mechanic MUST persist (trauma tag, string bump, runtime
// field flip).
//
// scripted_intimacy_rules (migration 0039) is the cartridge-side
// truth: each row is a {trigger_tag, field_patches, string_delta,
// trauma_tag, one_shot}. We render them into a system-prompt
// addendum + skip rules already fired for this (player, partner)
// pair when one_shot=true.

import {query} from '../db.js';

interface ScriptedRule {
  id: number;
  trigger_tag: string;
  field_patches: Array<{field_id: number; op: string; value: unknown}>;
  string_delta: number;
  trauma_tag: string | null;
  one_shot: boolean;
}

export async function buildIntimacyRules(args: {
  playerId: number;
  partnerId: number | null;
}): Promise<string | null> {
  const rows = await query<ScriptedRule>(
    `SELECT id, trigger_tag, field_patches, string_delta, trauma_tag, one_shot
       FROM scripted_intimacy_rules`,
  );
  if (rows.rows.length === 0) return null;

  const fired = await getFiredTriggers(args.playerId, args.partnerId);

  const lines: string[] = [
    'INTIMACY MODE ACTIVE. Required mechanical persistence — these rules fire ALONGSIDE prose, not instead of:',
  ];
  lines.push(
    'Prefer apply_intimacy_trigger(trigger_tag=...) for matching rules; it resolves scripted field_patches/string_delta/trauma_tag without inventing field ids. If applying manually, use only listed field_id patches and runtime fields visible in context.',
  );
  let any = false;
  for (const r of rows.rows) {
    if (r.one_shot && fired.has(r.trigger_tag)) continue;
    const parts: string[] = [
      `call apply_intimacy_trigger(trigger_tag="${r.trigger_tag}"${args.partnerId != null ? `, partner_id=${args.partnerId}` : ''})`,
    ];
    if (Array.isArray(r.field_patches) && r.field_patches.length > 0) {
      parts.push(`or manually call apply_runtime_field_patch with exactly these patches=${JSON.stringify(r.field_patches)}`);
    }
    if (r.string_delta !== 0 && args.partnerId != null) {
      parts.push(
        `call string_award npc=<partner_name> delta=${r.string_delta > 0 ? '+' : ''}${r.string_delta}`,
      );
    }
    if (r.trauma_tag) {
      parts.push(`apply_intimacy_trigger appends trauma tag "${r.trauma_tag}" if the trauma field exists`);
    }
    if (parts.length > 0) {
      lines.push(`- IF "${r.trigger_tag}" depicted this turn: MUST ${parts.join('; ')}.`);
      any = true;
    }
  }
  if (!any) return null;
  lines.push(
    'Tools fire EVEN IF the prose is brief. Mechanic > prose: every intimate beat MUST persist a runtime change. Do not invent arousal/satisfaction fields; if a rule lists no field_patches, the trigger/string/memory/quest state is the persistence.',
  );
  return lines.join('\n');
}

async function getFiredTriggers(playerId: number, partnerId: number | null): Promise<Set<string>> {
  // Check the player's trauma list for any one-shot tags + the per-pair
  // intimacy state on the partner. Conservative — we use trauma list
  // as the source of truth for "first_time" type one-shots.
  const fired = new Set<string>();
  const trauma = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'trauma'`,
    [playerId],
  );
  const tags = Array.isArray(trauma.rows[0]?.value)
    ? (trauma.rows[0]!.value as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  for (const t of tags) fired.add(t);
  if (partnerId != null) {
    // Partner-pair fired tags — stored on partner.profile.intimacy_history (jsonb array)
    const p = await query<{profile: unknown}>(
      `SELECT profile FROM entities WHERE id = $1`,
      [partnerId],
    );
    const profile = p.rows[0]?.profile as Record<string, unknown> | undefined;
    const history = profile?.intimacy_history as unknown[] | undefined;
    if (Array.isArray(history)) {
      for (const h of history) if (typeof h === 'string') fired.add(h);
    }
  }
  return fired;
}
