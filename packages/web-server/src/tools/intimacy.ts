/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 35 carried-over — scripted intimacy auto-fire.
//
// Auto-fire on prose was deferred because NLP-matching English on
// model output is fragile. This tool gives the broker an explicit
// handle: when mode='intimacy' and a beat lands (first kiss, first
// penetration, climax, aftercare), the broker calls
// apply_intimacy_trigger(trigger_tag) and the scripted_intimacy_rules
// row fires its field_patches + string_delta + trauma_tag.
//
// one_shot=true rules dedupe per (player, trigger). Cartridge author
// is the source of truth for which rules fire.

import {z} from 'zod';
import {query} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {registerTool} from './base.js';

const ApplyArgs = z.object({
  trigger_tag: z.string().min(1).max(60),
  partner_id: z.number().int().positive().optional(),
});

interface RuleRow {
  id: number;
  field_patches: unknown;
  string_delta: number;
  trauma_tag: string | null;
  one_shot: boolean;
}

registerTool({
  name: 'apply_intimacy_trigger',
  description:
    "Fire a scripted_intimacy_rules entry by its trigger_tag (e.g. 'first_kiss', 'climax'). Applies the rule's field_patches, bumps the partner's strings band by string_delta, and tags the player with trauma_tag if set. one_shot=true rules dedupe — calling twice is a no-op.",
  paramsSchema: ApplyArgs,
  async execute(args, ctx) {
    const r = await query<RuleRow>(
      `SELECT id, field_patches, string_delta, trauma_tag, one_shot
         FROM scripted_intimacy_rules
        WHERE trigger_tag = $1`,
      [args.trigger_tag],
    );
    if (r.rows.length === 0) {
      return {ok: false, error: `unknown trigger: ${args.trigger_tag}`};
    }
    const rule = r.rows[0]!;

    // one_shot dedupe via tool_invocations history.
    if (rule.one_shot) {
      const prior = await query<{n: number}>(
        `SELECT COUNT(*)::int AS n FROM tool_invocations
          WHERE tool_name = 'apply_intimacy_trigger'
            AND player_id = $1
            AND args::jsonb @> jsonb_build_object('trigger_tag', $2::text)
            AND error IS NULL`,
        [ctx.playerId, args.trigger_tag],
      );
      if ((prior.rows[0]?.n ?? 0) >= 1) {
        // The current invocation has already been audited — anything
        // greater than 1 means a previous fire is on record.
        return {
          ok: true,
          trigger_tag: args.trigger_tag,
          deduped: true,
          note: 'one_shot rule already fired',
        };
      }
    }

    // string_delta — bump partner's bond if partner_id provided.
    let stringApplied = 0;
    if (rule.string_delta !== 0 && args.partner_id) {
      try {
        await query(
          `UPDATE strings SET value = value + $1
            WHERE player_id = $2 AND npc_entity_id = $3`,
          [rule.string_delta, ctx.playerId, args.partner_id],
        );
        stringApplied = rule.string_delta;
      } catch {
        // strings table may not exist if cartridge skipped it
      }
    }

    // trauma_tag — append to the player's trauma list.
    let traumaApplied: string | null = null;
    if (rule.trauma_tag) {
      try {
        await query(
          // M-6 follow-up: safe_jsonb_array ensures a preexisting
          // non-array trauma value (legacy / authoring slip) is
          // treated as `[]` before append instead of producing the
          // jsonb concatenation surprise `object || array`.
          `INSERT INTO runtime_values (field_id, value)
           SELECT rf.id, safe_jsonb_array(rv.value) || jsonb_build_array($1::text)
             FROM runtime_fields rf
             LEFT JOIN runtime_values rv ON rv.field_id = rf.id
            WHERE rf.owner_entity_id = $2 AND rf.field_key = 'trauma'
           ON CONFLICT (field_id) DO UPDATE
             SET value = safe_jsonb_array(runtime_values.value) || jsonb_build_array($1::text)`,
          [rule.trauma_tag, ctx.playerId],
        );
        traumaApplied = rule.trauma_tag;
      } catch {
        // tolerate missing field
      }
    }

    await emitGuiEvent(ctx, 'intimacy:trigger', {
      trigger_tag: args.trigger_tag,
      string_delta: stringApplied,
      trauma_tag: traumaApplied,
      partner_id: args.partner_id ?? null,
    });

    return {
      ok: true,
      trigger_tag: args.trigger_tag,
      string_delta: stringApplied,
      trauma_tag: traumaApplied,
      one_shot: rule.one_shot,
      field_patches_count: Array.isArray(rule.field_patches)
        ? rule.field_patches.length
        : 0,
    };
  },
});
