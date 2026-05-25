/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 Phase 4 readiness: forge SQL evidence helper. Parses a
// generated Cartridge Forge SQL artifact (the `obsidian-world-
// preview.sql` shape) and reports whether every per-entity
// `profile` JSONB literal omits the retired ARCH-19 keys
// (`cartridge_id`, `topology_parent_id`, `origin`). Pure: takes
// SQL text, returns the typed evidence — no IO at this layer.
//
// The parser mirrors the slice the cartridge-forge test
// `packages/cartridge-forge/tests/project.test.ts` uses to assert
// the same invariant on freshly emitted SQL ("forge SQL omits
// retired ARCH-19 JSONB keys from emitted profiles"). Only
// per-entity profile JSON payloads are inspected; SQL comments,
// normalized column declarations, topology update SQL, or any
// explanatory text containing `profile->>'topology_parent_id'`
// outside the entity VALUES block are intentionally ignored.

import {readFileSync} from 'node:fs';

export const ARCH19_RETIRED_PROFILE_KEYS = [
  'cartridge_id',
  'topology_parent_id',
  'origin',
] as const;

export type ForgeSqlEvidenceSource = 'none' | 'manual' | 'forge_sql';

export interface ForgeSqlEvidence {
  /** Provenance of the `forge_export_clean` flag the readiness
   *  evaluator ultimately sees. `forge_sql` is evidence-driven;
   *  `manual` preserves the legacy operator override; `none`
   *  means neither was supplied. */
  source: ForgeSqlEvidenceSource;
  /** Absolute or repo-relative path the operator supplied, or
   *  `null` when no `--forge-sql` flag was passed. */
  path: string | null;
  /** Number of per-entity `'<json>'::jsonb` literals parsed out of
   *  the entity VALUES block. Zero when no INSERT block was found
   *  (recorded as a parse error so the gate stays closed). */
  profile_literal_count: number;
  /** Per-key count of literals that still carried a retired key.
   *  All three must be zero for `forge_export_clean: true`. */
  retired_key_hits: {
    cartridge_id: number;
    topology_parent_id: number;
    origin: number;
  };
  /** Per-literal parse errors (malformed JSON, etc). Non-empty
   *  forces the gate closed regardless of hit counts — silent
   *  parse failure must never authorize a destructive drop. */
  parse_errors: string[];
  /** Final derived boolean the readiness evaluator consumes. */
  forge_export_clean: boolean;
}

/** Entity INSERT marker the forge exporter emits. The slice goes
 *  from this header to the next `ON CONFLICT (id) DO UPDATE SET`
 *  (the start of the upsert tail, NOT a per-row clause). */
const ENTITY_INSERT_HEADER =
  'INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id, dynamic_origin) VALUES';
const ENTITY_INSERT_TAIL = 'ON CONFLICT (id) DO UPDATE SET';

const PROFILE_JSON_LITERAL_RE = /'(\{[^']*(?:''[^']*)*\})'::jsonb/g;

export interface ForgeSqlParseResult {
  profile_literal_count: number;
  retired_key_hits: ForgeSqlEvidence['retired_key_hits'];
  parse_errors: string[];
  forge_export_clean: boolean;
}

/**
 * Pure: parse a forge SQL text and report ARCH-19 cleanliness.
 *
 * Failure modes (each forces `forge_export_clean: false`):
 *   - the entity INSERT block is missing entirely (recorded as
 *     `entity_insert_block_not_found`);
 *   - the INSERT block contains zero JSON literals (recorded as
 *     `no_profile_literals_found_in_entity_block`);
 *   - any literal fails `JSON.parse` (recorded with the literal
 *     index and parser message);
 *   - any literal still owns one of the retired keys.
 *
 * Successful cleanliness requires `profile_literal_count > 0`,
 * every hit count `== 0`, and `parse_errors.length === 0`.
 */
export function parseForgeSqlForRetiredKeys(
  sqlText: string,
): ForgeSqlParseResult {
  const hits = {cartridge_id: 0, topology_parent_id: 0, origin: 0};
  const parseErrors: string[] = [];

  const insertIdx = sqlText.indexOf(ENTITY_INSERT_HEADER);
  if (insertIdx < 0) {
    return {
      profile_literal_count: 0,
      retired_key_hits: hits,
      parse_errors: ['entity_insert_block_not_found'],
      forge_export_clean: false,
    };
  }

  const onConflictIdx = sqlText.indexOf(ENTITY_INSERT_TAIL, insertIdx);
  // If the tail marker is missing, slice to EOF — better to over-
  // include than miss literals. The literal regex requires the
  // surrounding `'::jsonb`, so over-inclusion only adds false
  // positives if upstream SQL also writes profile literals inline,
  // which the exporter does not.
  const entityBlock =
    onConflictIdx > insertIdx
      ? sqlText.slice(insertIdx, onConflictIdx)
      : sqlText.slice(insertIdx);

  const literals: string[] = [];
  let match: RegExpExecArray | null;
  PROFILE_JSON_LITERAL_RE.lastIndex = 0;
  while ((match = PROFILE_JSON_LITERAL_RE.exec(entityBlock)) !== null) {
    literals.push(match[1]!);
  }
  if (literals.length === 0) {
    return {
      profile_literal_count: 0,
      retired_key_hits: hits,
      parse_errors: ['no_profile_literals_found_in_entity_block'],
      forge_export_clean: false,
    };
  }

  for (let i = 0; i < literals.length; i += 1) {
    const unescaped = literals[i]!.replace(/''/g, "'");
    let parsed: unknown;
    try {
      parsed = JSON.parse(unescaped);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parseErrors.push(`literal_${i}_parse_failed:${message}`);
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      parseErrors.push(`literal_${i}_not_a_json_object`);
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    for (const key of ARCH19_RETIRED_PROFILE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        hits[key] += 1;
      }
    }
  }

  const clean =
    parseErrors.length === 0 &&
    hits.cartridge_id === 0 &&
    hits.topology_parent_id === 0 &&
    hits.origin === 0;

  return {
    profile_literal_count: literals.length,
    retired_key_hits: hits,
    parse_errors: parseErrors,
    forge_export_clean: clean,
  };
}

export interface DeriveForgeEvidenceOptions {
  forgeSqlPath: string | null;
  manualForgeExportClean: boolean;
  /** Override for tests so we don't have to round-trip through
   *  `fs.readFileSync`. Production callers omit this and the helper
   *  reads from disk. */
  readSql?: (path: string) => string;
}

/**
 * Derive the typed `ForgeSqlEvidence` the CLI prints and the
 * readiness evaluator consumes. Source precedence:
 *
 *   - `--forge-sql <path>` always wins. The flag's whole point is
 *     to replace operator self-report with parsed evidence, so a
 *     simultaneous `--forge-export-clean` is recorded but does NOT
 *     override the SQL-derived verdict.
 *   - `--forge-export-clean` is the preserved legacy override.
 *     Source is `'manual'`; `forge_export_clean: true` only when
 *     the operator passed the flag.
 *   - Neither supplied → source `'none'`, `forge_export_clean:
 *     false`. The evaluator's
 *     `forge_export_still_writes_dropped_keys` blocker stays on.
 *
 * IO errors (file missing / unreadable) are pushed onto
 * `parse_errors` and force the gate closed; they never propagate
 * out as exit-code 2 because the caller already handles the outer
 * try/catch and we want a structured failure visible in the JSON.
 */
export function deriveForgeSqlEvidence(
  options: DeriveForgeEvidenceOptions,
): ForgeSqlEvidence {
  if (options.forgeSqlPath) {
    const reader = options.readSql ?? ((p: string) => readFileSync(p, 'utf8'));
    let text: string;
    try {
      text = reader(options.forgeSqlPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        source: 'forge_sql',
        path: options.forgeSqlPath,
        profile_literal_count: 0,
        retired_key_hits: {
          cartridge_id: 0,
          topology_parent_id: 0,
          origin: 0,
        },
        parse_errors: [`forge_sql_read_failed:${message}`],
        forge_export_clean: false,
      };
    }
    const parsed = parseForgeSqlForRetiredKeys(text);
    return {
      source: 'forge_sql',
      path: options.forgeSqlPath,
      profile_literal_count: parsed.profile_literal_count,
      retired_key_hits: parsed.retired_key_hits,
      parse_errors: parsed.parse_errors,
      forge_export_clean: parsed.forge_export_clean,
    };
  }
  if (options.manualForgeExportClean) {
    return {
      source: 'manual',
      path: null,
      profile_literal_count: 0,
      retired_key_hits: {
        cartridge_id: 0,
        topology_parent_id: 0,
        origin: 0,
      },
      parse_errors: [],
      forge_export_clean: true,
    };
  }
  return {
    source: 'none',
    path: null,
    profile_literal_count: 0,
    retired_key_hits: {
      cartridge_id: 0,
      topology_parent_id: 0,
      origin: 0,
    },
    parse_errors: [],
    forge_export_clean: false,
  };
}
