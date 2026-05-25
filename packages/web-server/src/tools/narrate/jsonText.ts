/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — narrate JSON-text helpers. Extracted from the original
// `tools/narrate.ts` so the sanitiser/control-text/register modules
// can compose them without re-implementing the depth-balanced scan.
//
// The two top-level entry points are `unwrapNarrateArgsText` (used
// by the sanitiser to peel a stray `{"text": "..."}` wrapper off
// the raw narrator output) and `collectNarrateTextValues` (used by
// `isNarrateControlText` to detect pure-JSON dumps the broker
// should never let through). Every JSON parse runs through
// `tryParseJsonWithinCap` so the AI-1 / N-3 128 KiB cap stays
// enforced.

import {tryParseJsonWithinCap} from '../../jsonSalvage.js';

interface JsonCandidate {
  start: number;
  end: number;
  value: unknown;
}

export function unwrapNarrateArgsText(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const fencedTexts = collectFencedBodies(input).flatMap((body) =>
    collectNarrateTextValues(body),
  );
  if (fencedTexts.length > 0) {
    return fencedTexts[fencedTexts.length - 1]!;
  }

  // LANGUAGE-REGEX-OK: literal control-text marker emitted by the broker handoff machinery ("Broker stage complete"). Wire-format string, not natural language; matches the same marker used in `protagonistActionRenderer.ts` and `tools/narrate/controlText.ts`.
  if (/\bBroker stage complete\b/i.test(input)) {
    const texts = collectNarrateTextValues(input);
    return texts.length > 0 ? texts[texts.length - 1]! : null;
  }

  if (isPureJsonNarrateDump(trimmed)) {
    const texts = collectNarrateTextValues(trimmed);
    return texts.length > 0 ? texts[texts.length - 1]! : null;
  }

  return null;
}

function collectFencedBodies(input: string): string[] {
  const bodies: string[] = [];
  const re = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) != null) {
    bodies.push(match[1] ?? '');
  }
  return bodies;
}

export function collectNarrateTextValues(input: string): string[] {
  const values: string[] = [];
  for (const candidate of collectJsonCandidates(input)) {
    const textValue = textFromJsonValue(candidate.value);
    if (textValue != null && textValue.trim().length > 0) {
      values.push(textValue);
    }
  }
  return values;
}

export function isPureJsonNarrateDump(input: string): boolean {
  const candidates = collectJsonCandidates(input);
  if (candidates.length === 0) return false;
  if (!candidates.every((candidate) => textFromJsonValue(candidate.value) != null)) {
    return false;
  }
  let remainder = input;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    remainder =
      remainder.slice(0, candidate.start) + remainder.slice(candidate.end);
  }
  return remainder.trim().length === 0;
}

function textFromJsonValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const textValue = textFromJsonValue(value[i]);
      if (textValue != null) return textValue;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj['text'] === 'string') return obj['text'];
  const args = obj['args'];
  if (args && typeof args === 'object') {
    const textValue = (args as Record<string, unknown>)['text'];
    if (typeof textValue === 'string') return textValue;
  }
  return null;
}

function collectJsonCandidates(input: string): JsonCandidate[] {
  const candidates: JsonCandidate[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== '{' && ch !== '}') continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    depth--;
    if (depth !== 0 || start < 0) continue;
    const raw = input.slice(start, i + 1);
    // AI-1 / N-3 — skip embedded JSON candidates over the salvage
    // cap. Quarantine checks still catch control text that remains
    // visible after sanitisation.
    const result = tryParseJsonWithinCap(raw);
    if (result.ok) {
      candidates.push({start, end: i + 1, value: result.value});
    }
    start = -1;
  }

  return candidates;
}
