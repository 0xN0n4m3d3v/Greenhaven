/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared helpers for parsing free-form LLM text into structured payloads.
// Moved out of routes/profile.ts (ARCH-18) so non-route consumers like
// agents/base.ts and routes/examiner.ts can import without a route-to-route
// dependency.

export function safeJsonExtract(s: string): unknown {
  let text = s.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  if (!text.startsWith('{')) {
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i < 0 || j < i) return null;
    text = text.slice(i, j + 1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractPolishedText(s: string): string {
  const json = safeJsonExtract(s);
  if (json && typeof json === 'object') {
    const text = (json as Record<string, unknown>)['text'];
    if (typeof text === 'string') return text.trim();
  }
  return s
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}
