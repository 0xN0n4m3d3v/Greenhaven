/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 139 v2 — quote-prefix parsing for messenger-style reply chains.
//
// When the player taps the Reply icon on an NPC bubble, GameScreen
// pre-fills the composer with a quote prefix:
//
//   > Mikka Quickgrin: «— Я тебе говорю — клад там есть.»
//   <blank line>
//   (player text here)
//
// This module recognises and strips that prefix from a string. The
// rendering layer can then show the quote as a styled card above the
// message body instead of plain `>` text.
//
// The prefix is intentionally a Markdown-blockquote-ish shape so the
// broker can also read player intent ("the player is replying to this
// line") without any new server contract.

const QUOTE_PREFIX_RE = /^> ([^:\n]{1,80}): «([\s\S]+?)»\r?\n\r?\n/;

export interface ParsedQuote {
  author: string;
  text: string;
  /** Full matched prefix including trailing blank line. */
  prefix: string;
  /** Message body with the prefix removed. */
  body: string;
}

/** Return parsed quote + body, or null if no quote prefix found. */
export function parseQuotePrefix(input: string | null | undefined): ParsedQuote | null {
  if (!input) return null;
  const m = input.match(QUOTE_PREFIX_RE);
  if (!m) return null;
  const [prefix, author, text] = m;
  return {
    author: author!.trim(),
    text: text!.trim(),
    prefix: prefix!,
    body: input.slice(prefix!.length),
  };
}

/** Compose a quote prefix in the canonical shape. */
export function buildQuotePrefix(author: string, text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  const ellipsis = text.length > 200 ? '…' : '';
  return `> ${author}: «${trimmed}${ellipsis}»\n\n`;
}
