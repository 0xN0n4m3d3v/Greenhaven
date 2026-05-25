/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 48 — Cartridge Steward (MVP — deterministic gatekeeper).
//
// Pre-tool synchronous validator on `create_entity` and
// `create_quest`. Rejects spawns that fail one of these checks:
//
//   1. Language script mismatch — display_name / title in Latin
//      script when conversation is dominantly Cyrillic, or vice
//      versa. Suggests a localized name from the cartridge i18n
//      when available.
//   2. Near-certain duplicate — same-kind entity exists with
//      similarity score ≥ 0.92 (using the same hybrid Levenshtein +
//      Jaccard score from spec 42 Catalogue Scout). Suggests
//      reusing the existing entity by name.
//   3. Required-field absence — missing `display_name`, missing
//      `summary` on create_entity (kind=location/scene). `goal_text`
//      on create_quest is optional since spec 64.
//
// Ambiguous duplicates (0.7..0.92 confidence) and tone mismatches
// pass through here; they're caught async by Catalogue Scout.
//
// On reject: returns { ok: false, reason, suggestion: {...} } so
// the broker sees a structured error, fixes the args, and retries.
// Telemetry row written manually with role='agent:cartridge_steward'
// for cost / activity audit.

import {playerScopedChatPredicate} from '../chatHistoryScope.js';
import {query} from '../db.js';
import type {ToolContext} from '../tools/base.js';
import {registerPreToolValidatorSpecialist} from '../specialists/registry.js';
import {sessionManager} from '../sessionManager.js';
import {
  validateDynamicWorldFactSpawn,
  type DynamicWorldFactSpawn,
} from '../worldFactGuard.js';
import {similarityScore} from './catalogueScout.js';
import {detectScripts, type ScriptTag} from './scriptUtil.js';

const NEAR_DUPE_THRESHOLD = 0.92;

interface ScriptPolicy {
  allowed: readonly ScriptTag[];
  label: string;
  source: string;
  toString(): string;
}

interface CreateEntitySpawn extends DynamicWorldFactSpawn {
  kind: string;
  display_name: string;
  summary?: string;
}

// ── Validators ─────────────────────────────────────────────────────────

async function validateCreateEntity(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
): Promise<{ok: true} | {ok: false; reason: string; suggestion?: Record<string, unknown>}> {
  const startedAt = Date.now();
  const a = args as Partial<CreateEntitySpawn>;
  const conversationScript = await detectConversationScriptPolicy(ctx);
  const verdict = await runChecks([{
    kind: a.kind ?? '',
    display_name: a.display_name ?? '',
    summary: a.summary,
    profile: (a as Record<string, unknown>)['profile'],
    hidden_until_stage: (a as Record<string, unknown>)['hidden_until_stage'] as string | undefined,
    tags: (a as Record<string, unknown>)['tags'] as string[] | undefined,
  }], conversationScript, ctx);
  await writeTelemetry(ctx, toolName, Date.now() - startedAt, !verdict.ok);
  return verdict;
}

async function validateCreateQuest(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
): Promise<{ok: true} | {ok: false; reason: string; suggestion?: Record<string, unknown>}> {
  const startedAt = Date.now();
  const a = args as Record<string, unknown>;
  const conversationScript = await detectConversationScriptPolicy(ctx);

  // Quest-level checks: title, summary, optional goal_text language;
  // required fields. Missing goal_text is allowed since create_quest
  // derives a deterministic fallback after validation.
  const title = String(a['title'] ?? '');
  const summary = String(a['summary'] ?? '');
  const goalText = String(a['goal_text'] ?? '').trim();
  if (!title) {
    await writeTelemetry(ctx, toolName, Date.now() - startedAt, true);
    return {ok: false, reason: 'create_quest requires title'};
  }
  const titleScriptVerdict = checkScript(title, conversationScript, 'title');
  if (!titleScriptVerdict.ok) {
    await writeTelemetry(ctx, toolName, Date.now() - startedAt, true);
    return titleScriptVerdict;
  }
  const summaryScriptVerdict = checkScript(summary, conversationScript, 'summary');
  if (!summaryScriptVerdict.ok) {
    await writeTelemetry(ctx, toolName, Date.now() - startedAt, true);
    return summaryScriptVerdict;
  }
  const goalScriptVerdict = goalText
    ? checkScript(goalText, conversationScript, 'goal_text')
    : {ok: true as const};
  if (!goalScriptVerdict.ok) {
    await writeTelemetry(ctx, toolName, Date.now() - startedAt, true);
    return goalScriptVerdict;
  }

  // spawn_entities[]: each gets the same checks as create_entity.
  const spawnArr = (a['spawn_entities'] ?? []) as Array<Partial<CreateEntitySpawn>>;
  if (Array.isArray(spawnArr) && spawnArr.length > 0) {
    const spawns = spawnArr.map(s => ({
      kind: s.kind ?? '',
      display_name: s.display_name ?? '',
      summary: s.summary,
      profile: (s as Record<string, unknown>)['profile'],
      hidden_until_stage: (s as Record<string, unknown>)['hidden_until_stage'] as string | undefined,
      tags: (s as Record<string, unknown>)['tags'] as string[] | undefined,
    }));
    const verdict = await runChecks(spawns, conversationScript, ctx, {
      allowExactDuplicate: true,
    });
    if (!verdict.ok) {
      await writeTelemetry(ctx, toolName, Date.now() - startedAt, true);
      return verdict;
    }
  }

  await writeTelemetry(ctx, toolName, Date.now() - startedAt, false);
  return {ok: true};
}

// ── Check pipeline (deterministic) ────────────────────────────────────

async function runChecks(
  spawns: CreateEntitySpawn[],
  _conversationScript: ScriptPolicy,
  ctx: ToolContext,
  opts: {allowExactDuplicate?: boolean} = {},
): Promise<
  {ok: true} | {ok: false; reason: string; suggestion?: Record<string, unknown>}
> {
  for (const s of spawns) {
    if (!s.kind) {
      return {ok: false, reason: 'spawn requires kind'};
    }
    if (!s.display_name) {
      return {ok: false, reason: 'spawn requires display_name'};
    }
    if ((s.kind === 'location' || s.kind === 'scene') && !s.summary) {
      return {
        ok: false,
        reason: `spawn kind=${s.kind} requires summary (player-facing description)`,
        suggestion: {add_field: 'summary'},
      };
    }
    // Script check on display_name skipped — display_names are
    // canonical identifiers (often Latin in any conversation
    // language; that's fine — see greenhaven.md §@-mentions).
    // Near-dupe check
    const dupeVerdict = await checkNearDupe(s);
    if (!dupeVerdict.ok) {
      if (
        opts.allowExactDuplicate === true &&
        isExactDuplicateReason(dupeVerdict.reason)
      ) {
        continue;
      }
      return dupeVerdict;
    }
    const worldFactVerdict = await validateDynamicWorldFactSpawn(s, {
      playerId: ctx.playerId,
    });
    if (!worldFactVerdict.ok) return worldFactVerdict;
  }
  return {ok: true};
}

function isExactDuplicateReason(reason: string): boolean {
  // LANGUAGE-REGEX-OK: structural reason-string match against the catalog-scout duplicate verdict ("near-duplicate of existing @<name> score=1.00)"). Wire-format parse of an internal reason code, not natural-language player text.
  return /near-duplicate of existing @.+score=1\.00\)/i.test(reason);
}

/**
 * Universal script-pair check — works for ANY language pair.
 *
 * Compares the dominant Unicode script of `text` against the
 * conversation's dominant script. If they differ AND the text
 * has 4+ chars in its dominant script (avoids false positives on
 * tiny names), flag a likely language mismatch.
 *
 * No hardcoded language pairs. Hebrew prose in a Russian session
 * is rejected; Russian prose in a Hebrew session is rejected;
 * English prose in a Japanese session is rejected; etc.
 */
function checkScript(
  _text: string,
  _conversationScript: ScriptPolicy,
  _fieldName: string,
):
  | {ok: true}
  | {ok: false; reason: string; suggestion?: Record<string, unknown>} {
  // Script check disabled by operator request: accept ANY script for
  // entity / quest / adventure titles and prose — latin, cyrillic,
  // CJK ideographs, Hebrew, Arabic, magical runes, mixed. Cartridge
  // proper nouns (e.g. "Grinhaven Main Market Square") often stay in
  // their canonical Latin form regardless of the player's language,
  // which used to make adventure-accept fail with 409 because the
  // generated title was "dominantly Latin" inside a cyrillic session.
  // We trust the cartridge author + the LLM to keep prose readable;
  // we no longer gate on script majority.
  return {ok: true};
}

async function checkNearDupe(
  spawn: CreateEntitySpawn,
): Promise<
  {ok: true} | {ok: false; reason: string; suggestion?: Record<string, unknown>}
> {
  const r = await query<{id: number; display_name: string}>(
    `SELECT id, display_name FROM entities WHERE kind = $1`,
    [spawn.kind],
  );
  let bestId = -1;
  let bestName = '';
  let bestScore = 0;
  for (const row of r.rows) {
    const sc = similarityScore(spawn.display_name, row.display_name);
    if (sc > bestScore) {
      bestScore = sc;
      bestId = row.id;
      bestName = row.display_name;
    }
  }
  if (bestScore >= NEAR_DUPE_THRESHOLD) {
    return {
      ok: false,
      reason: `near-duplicate of existing @${bestName} (id ${bestId}, score=${bestScore.toFixed(2)}). Use the existing entity by name; do not spawn a duplicate. See greenhaven.md §Reuse before spawn.`,
      suggestion: {
        use_existing_id: bestId,
        use_existing_name: bestName,
        action: 'reference @' + bestName + ' instead of spawning',
      },
    };
  }
  return {ok: true};
}

async function detectConversationScriptPolicy(ctx: ToolContext): Promise<ScriptPolicy> {
  const activeLanguage = sessionManager.get(ctx.sessionId)?.activeTurn?.language;
  const activePolicy = scriptPolicyFromLanguage(activeLanguage, 'active_turn_language');
  if (activePolicy) return activePolicy;

  const turnPolicy = scriptPolicyFromLanguage(
    await loadTurnLanguage(ctx),
    'turn_language',
  );
  if (turnPolicy) return turnPolicy;

  const adventurePolicy = scriptPolicyFromLanguage(
    await loadAdventureLanguage(ctx),
    'adventure_context_language',
  );
  if (adventurePolicy) return adventurePolicy;

  const playerPolicy = scriptPolicyFromLanguage(
    await loadPlayerLanguage(ctx),
    'player_preferred_language',
  );
  if (playerPolicy) return playerPolicy;

  try {
    const r = await query<{text: string}>(
      `SELECT cm.text
         FROM chat_messages cm
        WHERE cm.session_id = $1
          AND cm.tone = 'player'
          AND ${playerScopedChatPredicate('cm', 2)}
        ORDER BY cm.id DESC
        LIMIT 3`,
      [ctx.sessionId, ctx.playerId],
    );
    const joined = r.rows.map(row => row.text).join(' ');
    if (joined.length === 0) return unknownScriptPolicy('player_text_empty');
    const detected = detectScripts(joined).dominantScript;
    return detected === 'unknown'
      ? unknownScriptPolicy('player_text_unknown')
      : makeScriptPolicy([detected], detected, 'player_text');
  } catch {
    return unknownScriptPolicy('player_text_query_failed');
  }
}

async function loadTurnLanguage(ctx: ToolContext): Promise<string | null> {
  if (!ctx.turnId) return null;
  try {
    const r = await query<{language: string | null}>(
      `SELECT language
         FROM turn_ingress_queue
        WHERE session_id = $1
          AND player_id = $2
          AND turn_id = $3
        ORDER BY id DESC
        LIMIT 1`,
      [ctx.sessionId, ctx.playerId, ctx.turnId],
    );
    return r.rows[0]?.language ?? null;
  } catch {
    return null;
  }
}

async function loadAdventureLanguage(ctx: ToolContext): Promise<string | null> {
  if (!ctx.turnId) return null;
  try {
    const r = await query<{language: string | null}>(
      `SELECT context_snapshot->>'language' AS language
         FROM adventure_queue
        WHERE session_id = $1
          AND player_id = $2
          AND turn_id = $3
          AND context_snapshot ? 'language'
        ORDER BY id DESC
        LIMIT 1`,
      [ctx.sessionId, ctx.playerId, ctx.turnId],
    );
    return r.rows[0]?.language ?? null;
  } catch {
    return null;
  }
}

async function loadPlayerLanguage(ctx: ToolContext): Promise<string | null> {
  try {
    const r = await query<{preferred_language: string | null}>(
      `SELECT preferred_language
         FROM players
        WHERE entity_id = $1`,
      [ctx.playerId],
    );
    return r.rows[0]?.preferred_language ?? null;
  } catch {
    return null;
  }
}

function unknownScriptPolicy(source: string): ScriptPolicy {
  return makeScriptPolicy([], 'unknown', source);
}

function scriptPolicyFromLanguage(
  language: string | null | undefined,
  source: string,
): ScriptPolicy | null {
  const script = bcp47ScriptForLanguage(language);
  if (!script) return null;
  const allowed = scriptTagsForBcp47Script(script);
  if (allowed.length === 0) return null;
  return makeScriptPolicy(allowed, allowed.join('|'), source);
}

function makeScriptPolicy(
  allowed: readonly ScriptTag[],
  label: string,
  source: string,
): ScriptPolicy {
  return {
    allowed,
    label,
    source,
    toString() {
      return label;
    },
  };
}

function bcp47ScriptForLanguage(language: string | null | undefined): string | null {
  if (!language || language.trim().length < 2) return null;
  try {
    return new Intl.Locale(language.trim()).maximize().script ?? null;
  } catch {
    return null;
  }
}

function scriptTagsForBcp47Script(script: string): readonly ScriptTag[] {
  switch (script) {
    case 'Latn':
      return ['latin'];
    case 'Cyrl':
      return ['cyrillic'];
    case 'Hebr':
      return ['hebrew'];
    case 'Arab':
      return ['arabic'];
    case 'Deva':
      return ['devanagari'];
    case 'Beng':
      return ['bengali'];
    case 'Thai':
      return ['thai'];
    case 'Grek':
      return ['greek'];
    case 'Armn':
      return ['armenian'];
    case 'Geor':
      return ['georgian'];
    case 'Hang':
      return ['hangul'];
    case 'Hira':
      return ['hiragana'];
    case 'Kana':
      return ['katakana'];
    case 'Hani':
    case 'Hans':
    case 'Hant':
      return ['han'];
    case 'Jpan':
      return ['hiragana', 'katakana', 'han'];
    default:
      return [];
  }
}

async function writeTelemetry(
  ctx: ToolContext,
  toolName: string,
  durationMs: number,
  rejected: boolean,
): Promise<void> {
  // Manual telemetry row so /api/debug/cost shows agent:cartridge_steward
  // activity even though Steward is currently deterministic (no LLM call).
  try {
    await query(
      `INSERT INTO turn_telemetry
         (session_id, turn_id, role, model_id, thinking, input_tokens,
          output_tokens, cache_hit_tokens, cache_miss_tokens,
          duration_ms, cost_usd, player_id, tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        ctx.sessionId,
        ctx.turnId ?? null,
        'agent:cartridge_steward',
        'deterministic',
        false,
        0,
        0,
        0,
        0,
        durationMs,
        0,
        ctx.playerId ?? null,
        null,
      ],
    );
    // Emit SSE only on reject so frontend can show the card.
    if (rejected) {
      // SSE-OK: emit outside tx (reason: informational rejection
      // banner; no associated DB write — the steward decision is
      // logged via telemetry above, not via a state-changing row).
      sessionManager.get(ctx.sessionId)?.sse.emit('cartridge:steward_rejected', {
        toolName,
        durationMs,
      });
    }
  } catch (err) {
    // CATCH-WARN-OK: `writeTelemetry` IS the telemetry writer for this specialist (direct INSERT into turn_telemetry); re-entering telemetry.record() here would loop on the failing write path.
    console.warn(
      '[agent:cartridge_steward] telemetry write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Public registration ───────────────────────────────────────────────
//
// ARCH-5 — register validators into the SpecialistRegistry at module
// load. `tools/index.ts` reads `listPreToolValidatorSpecialists()`
// during its own load and wires each entry into `tools/base.js` via
// `registerPreToolValidator(toolName, validator)`.

registerPreToolValidatorSpecialist({
  name: 'cartridge_steward.create_entity',
  phase: 'preToolValidator',
  toolName: 'create_entity',
  validator: validateCreateEntity,
});

registerPreToolValidatorSpecialist({
  name: 'cartridge_steward.create_quest',
  phase: 'preToolValidator',
  toolName: 'create_quest',
  validator: validateCreateQuest,
});
