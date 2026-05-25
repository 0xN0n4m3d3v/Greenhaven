/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 acceptance criterion (c) — every `Phase.run()` body must fit
// inside 80 physical source lines, so that a phase's behaviour can be
// understood without paging through helpers. The check walks every
// `*Phase.ts` file under `src/turn/phases/`, locates `async run(`
// inside an exported `Phase`-shaped object, finds the matching
// closing brace of that method body, and asserts the line count
// (exclusive of the opening and closing brace lines) is ≤ 80.
//
// The check is intentionally textual, not AST-based: the phase files
// are simple object literals with one `run(...)` method, and a brace
// scanner that ignores string/template/comment content is enough.
// Pulling in `typescript`/`@babel/parser` for a one-shot byte-budget
// check would be heavier than the failure it prevents.

import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const PHASES_DIR = fileURLToPath(
  new URL('../../turn/phases/', import.meta.url),
);
const MAX_RUN_LOC = 80;

interface RunReport {
  file: string;
  loc: number;
}

describe('ARCH-1 — Phase.run() body LOC budget', () => {
  it('every phase exposes one run(context) method', () => {
    const phaseFiles = listPhaseFiles();
    expect(phaseFiles.length).toBeGreaterThan(0);
    for (const phaseFile of phaseFiles) {
      const source = readFileSync(join(PHASES_DIR, phaseFile), 'utf8');
      const occurrences = countRunDeclarations(source);
      expect(
        occurrences,
        `${phaseFile}: must declare exactly one Phase.run(context) method, found ${occurrences}`,
      ).toBe(1);
    }
  });

  it('every phase run() body is at most 80 physical source lines', () => {
    const offenders: RunReport[] = [];
    for (const phaseFile of listPhaseFiles()) {
      const source = readFileSync(join(PHASES_DIR, phaseFile), 'utf8');
      const loc = measureRunBodyLoc(source, phaseFile);
      if (loc > MAX_RUN_LOC) {
        offenders.push({file: phaseFile, loc});
      }
    }
    expect(
      offenders,
      `Phases over ${MAX_RUN_LOC}-LOC run() body:\n  ${offenders
        .map((o) => `${o.file} (${o.loc} LOC)`)
        .join('\n  ')}`,
    ).toEqual([]);
  });
});

function listPhaseFiles(): string[] {
  return readdirSync(PHASES_DIR)
    .filter((name) => /Phase\.ts$/.test(name))
    .sort();
}

function countRunDeclarations(source: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = findRunDeclaration(source, index);
    if (found < 0) break;
    count += 1;
    index = found + 1;
  }
  return count;
}

function findRunDeclaration(source: string, from: number): number {
  const pattern = /async\s+run\s*\(/g;
  pattern.lastIndex = from;
  const match = pattern.exec(source);
  return match ? match.index : -1;
}

function measureRunBodyLoc(source: string, phaseFile: string): number {
  const declStart = findRunDeclaration(source, 0);
  if (declStart < 0) {
    throw new Error(`${phaseFile}: no \`async run(\` declaration`);
  }
  const openParen = source.indexOf('(', declStart);
  const closeParen = matchClosingDelimiter(source, openParen, '(', ')');
  // Method body starts at the `{` after the parameter list and any
  // `:` return-type annotation.
  const openBrace = source.indexOf('{', closeParen);
  if (openBrace < 0) {
    throw new Error(`${phaseFile}: no \`{\` after run(...)`);
  }
  const closeBrace = matchClosingDelimiter(source, openBrace, '{', '}');
  const openLine = lineNumberAt(source, openBrace);
  const closeLine = lineNumberAt(source, closeBrace);
  // Count lines BETWEEN the braces, exclusive of the brace lines
  // themselves, so a method whose body is empty (`{\n}`) is 0 LOC and a
  // method whose body is one statement on one line (`{ statement }`) is
  // 0 LOC on the open/close line plus the inner line.
  return Math.max(0, closeLine - openLine - 1);
}

function matchClosingDelimiter(
  source: string,
  openIndex: number,
  openChar: '{' | '(',
  closeChar: '}' | ')',
): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) i = source.length;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = scanStringLiteral(source, i, ch);
      continue;
    }
    if (ch === '`') {
      i = scanTemplateLiteral(source, i);
      continue;
    }
    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error(
    `unterminated ${openChar}…${closeChar} starting at offset ${openIndex}`,
  );
}

function scanStringLiteral(
  source: string,
  start: number,
  quote: string,
): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return i + 1; // bail on raw newline — not valid JS but avoids infinite loop
    i += 1;
  }
  return source.length;
}

function scanTemplateLiteral(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && source[i + 1] === '{') {
      const inner = matchClosingDelimiter(source, i + 1, '{', '}');
      i = inner + 1;
      continue;
    }
    i += 1;
  }
  return source.length;
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}
