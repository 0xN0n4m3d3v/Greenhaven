/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 47 — Reward Calibrator.
//
// Blocking pre-broker advisory specialist. Computes reward bands
// (xp / strings / inspiration) for THIS turn based on:
//   - player level
//   - recent xp history (player_xp_log last 10 turns)
//   - scene scale hint (deterministic from mode + briefings)
//   - cartridge tier (tight / standard / generous)
//   - the player's input text (LLM may upshift on self-sacrifice etc.)
//
// Outputs `<reward_briefing>` block injected into broker user
// message. Broker is FREE to override any band — but must pass
// `calibrator_override_reason='<why>'` on the tool call so the
// override is auditable. Engine emits `reward:calibrator_override`
// SSE on those calls.
//
// Calibrator is ADVISORY — never a gatekeeper. Fail-open: any
// error returns null, broker uses prompt rules from greenhaven.md
// (which stay intact).

import {z} from 'zod';
import {query} from '../db.js';
import {
  runSpecialist,
  type PreBrokerHook,
  type SpecialistDef,
} from './base.js';
import {rewardCalibratorPrompt} from './rewardCalibratorPrompt.js';
import {languageHint} from './scriptUtil.js';
import {getCartridgeMeta, getMeta} from '../cartridge.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';

const Band = z.object({min: z.number().int(), max: z.number().int()});

const CalibratorOutput = z.object({
  xp_band: z.object({
    trivial: Band,
    scene: Band,
    arc_beat: Band,
    arc_end: Band,
  }),
  strings_max_per_beat: z.number().int().min(1).max(2),
  inspiration_per_scene: z.number().int().min(0).max(2),
  recent_inflation_warning: z.boolean(),
  recent_omission_warning: z.boolean(),
  scene_scale_final: z.enum(['trivial', 'scene_beat', 'arc_beat', 'arc_climax']),
  notes: z.string().max(300),
});

export type CalibratorBrief = z.infer<typeof CalibratorOutput>;

interface CalibratorInput {
  player_level: number;
  scene_scale_hint: 'trivial' | 'scene_beat' | 'arc_beat' | 'arc_climax';
  recent_xp_last_10_turns: number;
  recent_xp_total: number;
  player_text: string;
  cartridge_tier: 'tight' | 'standard' | 'generous';
  language: string;
}

const def: SpecialistDef<CalibratorInput, CalibratorBrief> = {
  name: 'reward_calibrator',
  mode: 'blocking',
  buildPrompt(input) {
    return {
      system: rewardCalibratorPrompt.system,
      user: rewardCalibratorPrompt.buildUser(input),
    };
  },
  outputSchema: CalibratorOutput,
  timeoutMs: 5000,
  temperature: 0.2,
  maxOutputTokens: 600,
};

export const rewardCalibratorHook: PreBrokerHook = {
  name: 'reward_calibrator',
  async run(ctx, turnInput) {
    try {
      return await produceBriefing(ctx, turnInput);
    } catch (err) {
      // CATCH-WARN-OK: pre-broker hook that returns null on failure so the broker proceeds without the briefing; the inner `produceBriefing` LLM call's outcome is captured by the specialist `recordAgentTelemetry` in base.ts, so no separate telemetry write is needed here.
      console.warn(
        '[agent:reward_calibrator] failed (continuing):',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  },
};

async function produceBriefing(
  ctx: {
    playerId: number;
    sessionId: string;
    turnId: string;
    signal: AbortSignal;
    language?: string;
  },
  turnInput: {text: string; mode: string},
): Promise<string | null> {
  if (!shouldRunRewardCalibrator(turnInput)) return null;

  const player = await loadPlayerSnapshot(ctx.playerId);
  if (!player) return null;

  const sceneScale = classifySceneScale(turnInput);
  const recentXpLast10 = await loadRecentXp(ctx.playerId, 10);
  const cartridgeTier = await loadCartridgeTier(ctx.playerId);
  const language = ctx.language ?? languageHint(turnInput.text);

  const brief = await runSpecialist(
    def,
    {
      player_level: player.current_level,
      scene_scale_hint: sceneScale,
      recent_xp_last_10_turns: recentXpLast10,
      recent_xp_total: player.current_xp,
      player_text: turnInput.text,
      cartridge_tier: cartridgeTier,
      language,
    },
    ctx,
  );
  if (!brief) return null;

  return formatBrokerBriefing(brief);
}

function shouldRunRewardCalibrator(turnInput: {text: string; mode: string}): boolean {
  if (turnInput.mode === 'combat' || turnInput.mode === 'intimacy') return true;

  // Reward calibration is useful for high-stakes beats, but running an
  // LLM before every short look/ask/move adds ~3s to ordinary play. Length
  // is intentionally language-agnostic: long player prose may still signal
  // a scene beat, while short low-stakes turns use the broker's defaults.
  return turnInput.text.trim().length >= 220;
}

export function formatBrokerBriefing(b: CalibratorBrief): string {
  const xb = b.xp_band;
  const inflLine = b.recent_inflation_warning
    ? '\n⚠ INFLATION: recent xp accumulating fast — default to LOW in band.'
    : '';
  const omitLine = b.recent_omission_warning
    ? '\n⚠ OMISSION: this turn looks like an arc beat — do not skip award_xp.'
    : '';
  return `<reward_briefing>
scene_scale: ${b.scene_scale_final}
xp_band:
  trivial:  ${xb.trivial.min}..${xb.trivial.max}
  scene:    ${xb.scene.min}..${xb.scene.max}
  arc_beat: ${xb.arc_beat.min}..${xb.arc_beat.max}
  arc_end:  ${xb.arc_end.min}..${xb.arc_end.max}
strings_max_per_beat: ${b.strings_max_per_beat}
inspiration_per_scene: ${b.inspiration_per_scene}${inflLine}${omitLine}
notes: ${b.notes}

Default to bands above. If you award OUTSIDE a band, pass calibrator_override_reason="<short why>" on the tool call.
</reward_briefing>`;
}

// ── Deterministic scene-scale classifier ──────────────────────────────

function classifySceneScale(turnInput: {
  text: string;
  mode: string;
}): CalibratorInput['scene_scale_hint'] {
  // Deterministic HINT only — the LLM prompt's few-shot
  // upshifts to arc_climax / arc_beat based on semantic prose
  // analysis (works in any language). We don't try to guess
  // arc_climax from regex anymore — too many languages, too many
  // closing phrasings, regex-driven detection only "saw" two of
  // them and missed everything else.
  if (turnInput.mode === 'combat') return 'arc_beat';
  if (turnInput.mode === 'intimacy') return 'arc_beat';
  // Length-based proxy for trivial. Holds across scripts because
  // we measure in code units; 80 chars in any language is a short
  // utterance regardless of script density.
  if (turnInput.text.length < 80) return 'trivial';
  return 'scene_beat';
}

// ── DB helpers ─────────────────────────────────────────────────────────

interface PlayerSnap {
  current_level: number;
  current_xp: number;
}

async function loadPlayerSnapshot(playerId: number): Promise<PlayerSnap | null> {
  const r = await query<PlayerSnap>(
    `SELECT current_level, current_xp FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return r.rows[0] ?? null;
}

async function loadRecentXp(playerId: number, lastN: number): Promise<number> {
  const r = await query<{total: string | number | null}>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM (
         SELECT amount FROM player_xp_log
          WHERE player_id = $1
          ORDER BY id DESC
          LIMIT $2
       ) recent`,
    [playerId, lastN],
  );
  const v = r.rows[0]?.total;
  return Number(v ?? 0);
}

async function loadCartridgeTier(
  playerId: number,
): Promise<'tight' | 'standard' | 'generous'> {
  // World entity may carry profile.reward_tier. Default standard.
  let worldEntityId: number | null = null;
  try {
    const cartridgeId = await resolveActivePlayerCartridgeId(playerId);
    worldEntityId =
      (await getCartridgeMeta<number | null>(
        cartridgeId,
        'world_entity_id',
        null,
      )) ?? null;
  } catch {
    worldEntityId = null;
  }
  worldEntityId ??=
    (await getMeta<number | null>('world_entity_id', null)) ?? null;
  if (worldEntityId == null) return 'standard';
  const r = await query<{reward_tier: string | null}>(
    `SELECT (profile->>'reward_tier') AS reward_tier
       FROM entities
      WHERE id = $1
        AND kind = 'world'
      LIMIT 1`,
    [worldEntityId],
  );
  const v = r.rows[0]?.reward_tier;
  if (v === 'tight' || v === 'generous') return v;
  return 'standard';
}

// `languageHint` is imported from scriptUtil — universal script-
// based detector. The LLM prompt makes finer distinctions.
