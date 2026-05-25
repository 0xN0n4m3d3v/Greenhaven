/**
 * M-6 static smoke test.
 *
 * Verifies the active runtime files that were the focus of the
 * M-6 adoption sweep no longer carry the legacy
 *
 *   CASE WHEN jsonb_typeof(<expr>) = 'array' THEN <expr> ELSE '[]'::jsonb END
 *
 * pattern in their SQL strings. `safe_jsonb_array(<expr>)` is the
 * sanctioned single-call replacement and is asserted to appear in
 * each adopted file.
 *
 * Excluded from the sweep on purpose:
 *   - Applied historical migrations are immutable.
 *   - `src/__tests__/migrations/invariants.test.ts` is a test file
 *     that reads controlled fixture data and does not need the
 *     runtime hardening.
 *   - `transitionEngine.ts` and `tools/quest.ts` keep `WHERE
 *     jsonb_typeof(rv.value) = 'array'` as a row filter that
 *     skips non-array rows entirely; replacing it with
 *     `safe_jsonb_array(...)` would change the UPDATE row set
 *     (non-array rows would now be force-clamped to '[]').  The
 *     existing row filter is intentional and not an array-shape
 *     guard.
 *   - Devtool/audit files like `devtools/validateCartridge.ts`
 *     and `devtools/cartridgeI18nAuthoring.ts` operate on
 *     hand-authored fixtures; out of scope for the runtime
 *     hardening pass.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..');

const ADOPTED_PATHS = [
  'locationPresence.ts',
  'dialogueParticipants.ts',
  'turnContext/questContext.ts',
  'scripts/location-linkage-audit.ts',
  'scripts/entity-card-io.ts',
  'domain/adventure/runtime/adventureArbiter.ts',
  // ARCH-1 lifecycle slice — the companion-count `jsonb_array_length`
  // query that used to live inline in `turnRunnerV2.ts` now sits in
  // `turn/dispatchPrep.ts`. `turnRunnerV2.ts` itself is a thin phase
  // runner with no remaining SQL, so the M-6 adoption assertion follows
  // the SQL to its new owner.
  'turn/dispatchPrep.ts',
  'devtools/supportSmoke.ts',
  'quest/questEngine.ts',
  'tools/intimacy.ts',
  'tools/runtime.ts',
];

const FORBIDDEN_PATTERNS: Array<{ description: string; pattern: RegExp }> = [
  {
    description:
      "legacy `CASE WHEN jsonb_typeof(...) = 'array' THEN ... ELSE '[]'::jsonb END` block",
    pattern: /WHEN\s+jsonb_typeof\([^)]+\)\s*=\s*'array'[\s\S]{0,200}'\[\]'::jsonb/m,
  },
  {
    description:
      "legacy `COALESCE(..., '[]'::jsonb)` wrapped directly around `jsonb_array_elements*` / `jsonb_array_length` input",
    pattern:
      /jsonb_array_(?:elements|elements_text|length)\(\s*COALESCE\([^)]+,\s*'\[\]'::jsonb\)/,
  },
  {
    description:
      "legacy `COALESCE(<anything>.value, '[]'::jsonb) ||` append over an unhardened runtime value",
    pattern: /COALESCE\([a-zA-Z_.]+\.value,\s*'\[\]'::jsonb\)\s*\|\|/,
  },
];

describe('M-6: active runtime SQL uses safe_jsonb_array', () => {
  for (const relative of ADOPTED_PATHS) {
    it(`${relative} contains no legacy array-shape guard patterns`, async () => {
      const source = await readFile(path.join(SRC_DIR, relative), 'utf8');
      for (const { description, pattern } of FORBIDDEN_PATTERNS) {
        expect(
          pattern.test(source),
          `${relative} still contains ${description} (matches /${pattern.source}/)`,
        ).toBe(false);
      }
      expect(source).toContain('safe_jsonb_array(');
    });
  }
});
