/**
 * M-5 static smoke test.
 *
 * Verifies that the active runtime SQL strings in
 *   - src/locationPresence.ts
 *   - src/dialogueParticipants.ts
 *   - src/turnContext/questContext.ts
 *   - src/scripts/location-linkage-audit.ts
 * no longer rely on `value ~ '^[0-9]+$'` followed by `value::bigint`
 * or `(profile->>'<field>')::bigint`.  These patterns silently let
 * PostgreSQL bigint overflow abort the whole query when a cartridge
 * or runtime emits a numeric string >= 2^63.  `safe_to_bigint`
 * (migration 0105) is now the only sanctioned way to read a bigint
 * out of profile/JSON text in these hot paths.
 *
 * Excluded from this sweep on purpose:
 *   - Applied historical migrations (0091/0092/0093/0094 etc.) are
 *     immutable.
 *   - `__tests__/migrations/invariants.test.ts` validates the
 *     fixture topology with assertions; it reads controlled fixture
 *     data and does not need the runtime hardening.
 *   - `locationGraph.ts` uses `::int` (not `::bigint`) for a
 *     non-id sort priority; bigint overflow is not the concern
 *     there.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..');

const HOT_PATHS = [
  'locationPresence.ts',
  'dialogueParticipants.ts',
  'turnContext/questContext.ts',
  'scripts/location-linkage-audit.ts',
];

const FORBIDDEN_PATTERNS: Array<{ description: string; pattern: RegExp }> = [
  {
    description: "regex guard `value ~ '^[0-9]+$'`",
    pattern: /~\s*'\^\[0-9\]\+\$'/,
  },
  {
    description: 'bare `value::bigint` cast in a SELECT projection',
    pattern: /\bvalue::bigint\b/,
  },
  {
    description: "bare `giver.value::bigint` cast",
    pattern: /\bgiver\.value::bigint\b/,
  },
  {
    description: "`(profile->>'<field>')::bigint` cast on profile JSON",
    pattern: /\([a-z_]+\.profile->>'[a-z_]+'\)\s*::\s*bigint/,
  },
  {
    description: "`(profile->>'<field>')::bigint` cast without table alias",
    pattern: /\(profile->>'[a-z_]+'\)\s*::\s*bigint/,
  },
];

describe('M-5: active runtime SQL uses safe_to_bigint', () => {
  for (const relative of HOT_PATHS) {
    it(`${relative} contains no unsafe regex+::bigint patterns`, async () => {
      const source = await readFile(path.join(SRC_DIR, relative), 'utf8');
      for (const { description, pattern } of FORBIDDEN_PATTERNS) {
        expect(
          pattern.test(source),
          `${relative} still contains ${description} (matches /${pattern.source}/)`,
        ).toBe(false);
      }
      expect(source).toContain('safe_to_bigint(');
    });
  }
});
