/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  runSpecialist,
  z,
  type SpecialistContext,
  type SpecialistDef,
} from './base.js';
import {buildProtagonistActionRendererPrompt} from './protagonistActionRendererPrompt.js';
import {getAllMentionEntities} from '../tools/runtimeContext.js';

export interface ProtagonistActionRendererInput {
  rawText: string;
  contextStatic?: string | null;
  contextDynamic?: string | null;
  language?: string;
  knownMentionNames?: string[];
}

export interface ProtagonistRenderMeta {
  enabled: boolean;
  changed: boolean;
  skipped_reason: string | null;
  confidence: number | null;
  model_id: string;
}

export interface ProtagonistRenderDecision {
  rawText: string;
  visibleText: string;
  meta: ProtagonistRenderMeta;
}

const PreservedElementsSchema = z.object({
  actor: z.string(),
  targets: z.array(z.string()),
  actions: z.array(z.string()),
  direct_speech: z.array(z.string()),
  mechanical_tokens: z.array(z.string()),
});

export const ProtagonistActionRendererOutputSchema = z.object({
  mode: z.enum(['render', 'skip']),
  changed: z.boolean(),
  rendered_text: z.string(),
  intent_summary: z.string().nullable(),
  meaning_delta: z.enum(['none', 'possible', 'changed']),
  preserved_elements: PreservedElementsSchema,
  confidence: z.number().min(0).max(1),
  skipped_reason: z.string().nullable(),
});

export type ProtagonistActionRendererOutput = z.infer<
  typeof ProtagonistActionRendererOutputSchema
>;

const protagonistActionRendererDef: SpecialistDef<
  ProtagonistActionRendererInput,
  ProtagonistActionRendererOutput
> = {
  name: 'protagonist_action_renderer',
  mode: 'blocking',
  buildPrompt: buildProtagonistActionRendererPrompt,
  outputSchema: ProtagonistActionRendererOutputSchema,
  timeoutMs: 2500,
  temperature: 0.2,
  maxOutputTokens: 320,
};

const PROTAGONIST_RENDERER_TIMEOUT_MS =
  protagonistActionRendererDef.timeoutMs ?? 2500;

export function isProtagonistRendererEnabled(): boolean {
  return false;
}

export async function renderProtagonistAction(
  input: ProtagonistActionRendererInput,
  ctx: SpecialistContext,
  options: {forceEnabled?: boolean} = {},
): Promise<ProtagonistRenderDecision> {
  const rawText = input.rawText;
  const enabled = options.forceEnabled === true || isProtagonistRendererEnabled();
  if (!enabled) {
    return skipDecision(rawText, 'disabled', false, null, 'disabled');
  }

  const localSkip = skipReasonForRawText(rawText);
  if (localSkip) {
    return skipDecision(rawText, localSkip, true, null, 'local-rules');
  }

  const knownMentionNames =
    input.knownMentionNames ??
    (await loadKnownMentionNames(rawText, ctx.playerId));
  let failOpenReason: string | null = null;
  const result = await runSpecialist(
    {
      ...protagonistActionRendererDef,
      onFailure: failure => {
        failOpenReason = failure.reason;
      },
    },
    {...input, knownMentionNames},
    ctx,
  );
  if (!result) {
    return skipDecision(
      rawText,
      failOpenReason === 'timeout'
        ? `timeout_${PROTAGONIST_RENDERER_TIMEOUT_MS}ms`
        : failOpenReason
          ? `specialist_${failOpenReason}`
          : 'specialist_fail_open',
      true,
      null,
      'unavailable',
    );
  }
  if (result.mode === 'skip' || !result.changed) {
    return skipDecision(
      rawText,
      result.skipped_reason ?? 'specialist_skipped',
      true,
      result.confidence,
      'default-specialist-model',
    );
  }

  const validation = validateProtagonistRenderCandidate(
    rawText,
    result,
    knownMentionNames,
  );
  if (!validation.ok) {
    return skipDecision(
      rawText,
      validation.reason,
      true,
      result.confidence,
      'default-specialist-model',
    );
  }

  const visibleText = result.rendered_text.trim();
  return {
    rawText,
    visibleText,
    meta: {
      enabled: true,
      changed: visibleText !== rawText,
      skipped_reason: null,
      confidence: result.confidence,
      model_id: 'default-specialist-model',
    },
  };
}

export function composePlayerTextForBroker(
  rawText: string,
  visibleText: string,
): string {
  if (normalizeWhitespace(rawText) === normalizeWhitespace(visibleText)) {
    return rawText;
  }
  return [
    '[Player raw command - canonical intent]',
    rawText,
    '',
    '[Player bubble - visible player performance]',
    visibleText,
  ].join('\n');
}

export function validateProtagonistRenderCandidate(
  rawText: string,
  candidate: ProtagonistActionRendererOutput,
  knownMentionNames: string[] = [],
): {ok: true; reason: null} | {ok: false; reason: string} {
  const raw = rawText.trim();
  const rendered = candidate.rendered_text.trim();

  if (candidate.mode !== 'render' || !candidate.changed) {
    return {ok: true, reason: null};
  }
  if (rendered.length < 1 || rendered.length > 700) {
    return {ok: false, reason: 'invalid_length'};
  }
  if (normalizeWhitespace(rendered) === normalizeWhitespace(raw)) {
    return {ok: false, reason: 'no_visible_change'};
  }
  if (candidate.meaning_delta !== 'none') {
    return {ok: false, reason: 'meaning_delta_not_none'};
  }
  if (candidate.confidence < 0.65) {
    return {ok: false, reason: 'low_confidence'};
  }
  if (looksLikeControlOrToolText(rendered)) {
    return {ok: false, reason: 'control_or_tool_text'};
  }
  const exactTokens = [
    ...collectMentionTokens(raw, knownMentionNames),
    ...collectMechanicalTokens(raw),
    ...collectQuotedSegments(raw),
  ];
  const missingExact = exactTokens.find(
    token => !containsNormalized(rendered, token),
  );
  if (missingExact) {
    return {ok: false, reason: `missing_exact_token:${missingExact}`};
  }

  const namedTargets = collectNamedTargets(raw);
  const missingTarget = namedTargets.find(
    target => !containsNormalized(rendered, target),
  );
  if (missingTarget) {
    return {ok: false, reason: `missing_named_target:${missingTarget}`};
  }

  const lexical = lexicalPreservation(raw, rendered);
  if (lexical.total >= 6 && lexical.ratio < 0.35) {
    return {ok: false, reason: 'low_lexical_preservation'};
  }

  return {ok: true, reason: null};
}

function skipDecision(
  rawText: string,
  skippedReason: string,
  enabled: boolean,
  confidence: number | null,
  modelId: string,
): ProtagonistRenderDecision {
  return {
    rawText,
    visibleText: rawText,
    meta: {
      enabled,
      changed: false,
      skipped_reason: skippedReason,
      confidence,
      model_id: modelId,
    },
  };
}

function skipReasonForRawText(rawText: string): string | null {
  const text = rawText.trim();
  if (!text) return 'empty';
  if (text.length > 1000) return 'too_long';
  if (text.startsWith('/') || text.startsWith('\\')) return 'slash_or_debug_command';
  // LANGUAGE-REGEX-OK: OOC ("out of character") protocol prefix tokens — wire convention that lives in player-facing UX docs; matching the exact tokens is part of the OOC control-text contract, not natural-language intent classification.
  if (/^(ooc:|out of character:|\[ooc\]|\/\/)/i.test(text)) {
    return 'out_of_character';
  }
  if (/^\[[a-z0-9_:-]+[^\]]*\]/i.test(text)) {
    return 'mechanical_bracket_command';
  }
  if (isTopLevelJson(text)) return 'json_input';
  return null;
}

async function loadKnownMentionNames(
  rawText: string,
  playerId: number,
): Promise<string[]> {
  if (!rawText.includes('@')) return [];
  try {
    const entities = await getAllMentionEntities(playerId);
    return entities.map(e => e.display_name);
  } catch (err) {
    // CATCH-WARN-OK: mention-name load is a best-effort enrichment for mention rewriting; the renderer continues with an empty list, and the underlying `getAllMentionEntities` failure is recorded through its own tools/runtimeContext SQL telemetry.
    console.warn(
      '[protagonist-action-renderer] mention-name load failed:',
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

function looksLikeControlOrToolText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes('```')) return true;
  // LANGUAGE-REGEX-OK: literal control-text markers used by the broker pipeline. `narrate(` matches the function-call wire prefix; `Broker stage complete` matches the internal stage-marker string emitted by the broker handoff. Wire format, not natural-language.
  if (/narrate\s*\(/i.test(trimmed)) return true;
  // LANGUAGE-REGEX-OK: see comment above — `Broker stage complete` is the canonical broker handoff marker.
  if (/Broker stage complete/i.test(trimmed)) return true;
  if (isTopLevelJson(trimmed)) return true;
  return false;
}

// DEEP-15 — bound the JSON parse the top-level detector performs. A
// streamed broker payload that legitimately starts with `{` and ends
// with `}` but is megabytes long would otherwise pin the event loop
// inside `JSON.parse` on every probe (this helper is called from both
// `detectControlText` and `looksLikeControlOrToolText`). Anything
// past the cap is treated as not-JSON, which falls through to the
// normal prose path — the renderer never depends on the parse result
// here, only on the boolean.
const MAX_TOP_LEVEL_JSON_DETECTION_CHARS = 64 * 1024;

function isTopLevelJson(text: string): boolean {
  const trimmed = text.trim();
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    return false;
  }
  if (trimmed.length > MAX_TOP_LEVEL_JSON_DETECTION_CHARS) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * DEEP-15 internals export — exposes the bounded JSON detector so a
 * focused regression can spy on `JSON.parse` without driving the full
 * renderer pipeline.
 */
export const protagonistActionRendererInternals = {
  isTopLevelJson,
  MAX_TOP_LEVEL_JSON_DETECTION_CHARS,
};

function collectMentionTokens(rawText: string, knownMentionNames: string[]): string[] {
  const out = new Set<string>();
  const sortedNames = [...new Set(knownMentionNames)]
    .filter(name => name.trim())
    .sort((a, b) => b.length - a.length);
  for (const name of sortedNames) {
    const token = `@${name}`;
    if (rawText.includes(token)) out.add(token);
  }
  for (const match of rawText.matchAll(/@[^\s,.;:!?()[\]{}"']+/gu)) {
    out.add(match[0]);
  }
  return [...out];
}

function collectMechanicalTokens(rawText: string): string[] {
  const out = new Set<string>();
  for (const match of rawText.matchAll(/\[\[[\s\S]{1,120}?\]\]/g)) {
    out.add(match[0]);
  }
  for (const match of rawText.matchAll(/\[[^\[\]\r\n]{1,160}\]/g)) {
    out.add(match[0]);
  }
  return [...out];
}

function collectQuotedSegments(rawText: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /"[^"\r\n]{1,500}"/g,
    /“[^”\r\n]{1,500}”/g,
    /«[^»\r\n]{1,500}»/g,
  ];
  for (const pattern of patterns) {
    for (const match of rawText.matchAll(pattern)) out.add(match[0]);
  }
  return [...out];
}

function collectNamedTargets(rawText: string): string[] {
  const out = new Set<string>();
  // LANGUAGE-REGEX-OK: Title-Case proper-noun harvester over Unicode letter+number classes. The leading character class includes both Latin uppercase (A-Z) and Cyrillic uppercase (А-ЯЁ) anchors so the same regex covers both authoring languages; everything after that is generic Unicode (`\p{L}\p{N}`). Not a natural-language intent classifier — picks out display-name candidates for the protagonist-action mention rewriter.
  const pattern =
    /[A-ZА-ЯЁ][\p{L}\p{N}'’-]{2,}(?:\s+[A-ZА-ЯЁ][\p{L}\p{N}'’-]{2,})*/gu;
  for (const match of rawText.matchAll(pattern)) {
    const phrase = match[0];
    const index = match.index ?? 0;
    if (index === 0 && !phrase.includes(' ')) continue;
    if (phrase.startsWith('Player ')) continue;
    out.add(phrase);
  }
  return [...out];
}

function lexicalPreservation(
  rawText: string,
  renderedText: string,
): {preserved: number; total: number; ratio: number} {
  const rawTokens = meaningfulTokens(rawText);
  const rendered = renderedText.toLocaleLowerCase();
  const preserved = rawTokens.filter(token => rendered.includes(token)).length;
  const total = rawTokens.length;
  return {preserved, total, ratio: total > 0 ? preserved / total : 1};
}

function meaningfulTokens(text: string): string[] {
  const matches = text.toLocaleLowerCase().match(/[\p{L}\p{N}'’-]{4,}/gu) ?? [];
  return [...new Set(matches)];
}

function containsNormalized(haystack: string, needle: string): boolean {
  return normalizeWhitespace(haystack).includes(normalizeWhitespace(needle));
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
