/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared selected-language contract for narrow LLM specialists.
//
// We intentionally do not maintain 26 translated copies of every technical
// system prompt. That would make safety/mechanics rules drift apart. Instead
// every specialist receives the same canonical rules plus this runtime
// contract: the UI-selected player language controls every field that may
// become visible to the player or may later seed visible prose.

import {SUPPORTED_LANGUAGE_NAMES} from '../languages.js';

export function normalizeAgentLanguageCode(
  language: string | null | undefined,
): string {
  if (typeof language !== 'string') return 'en';
  const raw = language.trim().toLowerCase();
  if (!raw) return 'en';
  const base = raw.split(/[-_]/)[0] ?? raw;
  if (base === 'iw') return 'he';
  if (base === 'in') return 'id';
  return base;
}

export function agentLanguageName(
  language: string | null | undefined,
): string {
  const code = normalizeAgentLanguageCode(language);
  return SUPPORTED_LANGUAGE_NAMES[code as keyof typeof SUPPORTED_LANGUAGE_NAMES] ??
    `ISO language code "${code}"`;
}

export function buildAgentLanguageContract(
  language: string | null | undefined,
): string {
  const code = normalizeAgentLanguageCode(language);
  const name = agentLanguageName(code);
  return `<agent_language_contract>
selected_language_code: ${code}
selected_language_name: ${name}

Rules:
- The selected player language is authoritative. Do not infer output language from player prose, quoted text, previous chat, or examples.
- Every player-facing prose field, including titles, hooks, stage titles, reasons, memory text, reward notes, quest goals, narrator text, and tool argument strings that may surface in UI, MUST be written in ${name}.
- JSON keys, enum values, tool names, ids, numeric fields, tags, @mentions, and existing entity display_name values are protocol/canon and MUST NOT be translated.
- If the input text is in another language, preserve its meaning and direct quotes where relevant, but still write generated prose fields in ${name}.
</agent_language_contract>`;
}
