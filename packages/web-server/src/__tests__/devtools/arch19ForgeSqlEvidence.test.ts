/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 Phase 4 forge-SQL evidence parser. Pure, no fs IO at this
// layer (`parseForgeSqlForRetiredKeys` takes raw SQL text; the
// `deriveForgeSqlEvidence` wrapper accepts a `readSql` override so
// these tests don't have to mkdtemp). The parser must agree with the
// cartridge-forge test "forge SQL omits retired ARCH-19 JSONB keys
// from emitted profiles": slice from the entity INSERT header to the
// `ON CONFLICT` tail, pull every `'<json>'::jsonb` literal, unescape
// the doubled single quotes, JSON.parse, then check for the retired
// keys.

import {describe, expect, it} from 'vitest';
import {
  ARCH19_RETIRED_PROFILE_KEYS,
  deriveForgeSqlEvidence,
  parseForgeSqlForRetiredKeys,
} from '../../devtools/arch19ForgeSqlEvidence.js';

const ENTITY_INSERT_HEADER =
  'INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id, dynamic_origin) VALUES';

function wrap(rows: string): string {
  return `${ENTITY_INSERT_HEADER}\n${rows}\nON CONFLICT (id) DO UPDATE SET ...\n`;
}

describe('parseForgeSqlForRetiredKeys', () => {
  it('reports clean=true when every profile literal omits retired keys', () => {
    const sql = wrap(
      [
        "(1, 'location', 'X', NULL, '{\"source_slug\":\"x\",\"home_id\":2}'::jsonb, ARRAY['location'], 'grinhaven-full', FALSE),",
        "(2, 'person', 'Y', NULL, '{\"source_slug\":\"y\",\"source\":{\"faction\":\"copper-court\"}}'::jsonb, ARRAY['person'], 'grinhaven-full', FALSE)",
      ].join('\n'),
    );
    const out = parseForgeSqlForRetiredKeys(sql);
    expect(out).toEqual({
      profile_literal_count: 2,
      retired_key_hits: {cartridge_id: 0, topology_parent_id: 0, origin: 0},
      parse_errors: [],
      forge_export_clean: true,
    });
  });

  it('reports clean=false and increments cartridge_id hits when the retired key is present inside a profile literal', () => {
    const sql = wrap(
      "(1, 'faction', 'Copper Court', NULL, '{\"cartridge_id\":\"grinhaven-full\",\"source_slug\":\"copper-court\"}'::jsonb, ARRAY['faction'], 'grinhaven-full', FALSE)",
    );
    const out = parseForgeSqlForRetiredKeys(sql);
    expect(out.profile_literal_count).toBe(1);
    expect(out.retired_key_hits).toEqual({
      cartridge_id: 1,
      topology_parent_id: 0,
      origin: 0,
    });
    expect(out.forge_export_clean).toBe(false);
  });

  it('does NOT count comments, column names, or topology UPDATE SQL outside the entity VALUES block as failures', () => {
    // The exporter emits a topology UPDATE that references the
    // legacy JSONB key in an EXPLANATORY comment after the entity
    // INSERT block. The parser must slice only the entity-VALUES
    // span — i.e., stop at `ON CONFLICT ...` — so comment text
    // never inflates retired-key hits.
    const sql =
      `${ENTITY_INSERT_HEADER}\n` +
      "(1, 'location', 'X', NULL, '{\"source_slug\":\"x\"}'::jsonb, ARRAY['location'], 'grinhaven-full', FALSE)\n" +
      'ON CONFLICT (id) DO UPDATE SET\n' +
      '  -- normalized columns mirrored; the dropped JSONB keys (e.g. profile->>\'topology_parent_id\') ride the column path now.\n' +
      "  cartridge_id = EXCLUDED.cartridge_id,\n" +
      "  topology_parent_id = EXCLUDED.topology_parent_id;\n" +
      "-- topology map (post-INSERT) uses entities.topology_parent_id column, NOT profile->>'topology_parent_id'\n";
    const out = parseForgeSqlForRetiredKeys(sql);
    expect(out.profile_literal_count).toBe(1);
    expect(out.retired_key_hits).toEqual({
      cartridge_id: 0,
      topology_parent_id: 0,
      origin: 0,
    });
    expect(out.forge_export_clean).toBe(true);
  });

  it('records parse errors for malformed literals and stays not-clean', () => {
    // Doubled single quotes in SQL escape to a single quote in JSON
    // payload, but the INNER content "broken: {malformed" is not
    // valid JSON. `JSON.parse` rejects, hit count stays zero, but
    // `parse_errors` is non-empty so the gate stays closed.
    const sql = wrap(
      "(1, 'location', 'X', NULL, '{broken:malformed}'::jsonb, ARRAY['location'], 'grinhaven-full', FALSE)",
    );
    const out = parseForgeSqlForRetiredKeys(sql);
    expect(out.profile_literal_count).toBe(1);
    expect(out.retired_key_hits).toEqual({
      cartridge_id: 0,
      topology_parent_id: 0,
      origin: 0,
    });
    expect(out.parse_errors.length).toBe(1);
    expect(out.parse_errors[0]).toMatch(/literal_0_parse_failed/);
    expect(out.forge_export_clean).toBe(false);
  });

  it('reports entity_insert_block_not_found when the header is missing', () => {
    const out = parseForgeSqlForRetiredKeys(
      "-- Some unrelated SQL that does not contain the entity INSERT header\nCREATE TABLE foo (id INTEGER);\n",
    );
    expect(out).toEqual({
      profile_literal_count: 0,
      retired_key_hits: {cartridge_id: 0, topology_parent_id: 0, origin: 0},
      parse_errors: ['entity_insert_block_not_found'],
      forge_export_clean: false,
    });
  });

  it('reports no_profile_literals_found_in_entity_block when the header is present but the block has no JSON literals', () => {
    // Pathological: the entity INSERT header appears but the VALUES
    // block has no `'<json>'::jsonb` literals. Treat as evidence
    // failure — the artifact does not match the exporter contract.
    const sql =
      `${ENTITY_INSERT_HEADER}\n  -- placeholder; no values yet\n` +
      'ON CONFLICT (id) DO UPDATE SET ...\n';
    const out = parseForgeSqlForRetiredKeys(sql);
    expect(out.profile_literal_count).toBe(0);
    expect(out.parse_errors).toEqual(['no_profile_literals_found_in_entity_block']);
    expect(out.forge_export_clean).toBe(false);
  });

  it('correctly unescapes doubled single quotes inside a literal', () => {
    // `'It''s clean'` in SQL → `It's clean` in JSON. The parser
    // must apply the `''` → `'` unescape before `JSON.parse`.
    const sql = wrap(
      "(1, 'location', 'X', NULL, '{\"narrator_brief\":\"It''s clean\"}'::jsonb, ARRAY['location'], 'grinhaven-full', FALSE)",
    );
    const out = parseForgeSqlForRetiredKeys(sql);
    expect(out.profile_literal_count).toBe(1);
    expect(out.parse_errors).toEqual([]);
    expect(out.forge_export_clean).toBe(true);
  });

  it('counts hits per retired key independently across multiple literals', () => {
    const sql = wrap(
      [
        "(1, 'a', 'A', NULL, '{\"cartridge_id\":\"x\"}'::jsonb, ARRAY['a'], 'x', FALSE),",
        "(2, 'b', 'B', NULL, '{\"topology_parent_id\":\"1\"}'::jsonb, ARRAY['b'], 'x', FALSE),",
        "(3, 'c', 'C', NULL, '{\"origin\":\"dynamic\"}'::jsonb, ARRAY['c'], 'x', TRUE),",
        "(4, 'd', 'D', NULL, '{\"cartridge_id\":\"x\",\"origin\":\"dynamic\"}'::jsonb, ARRAY['d'], 'x', TRUE)",
      ].join('\n'),
    );
    const out = parseForgeSqlForRetiredKeys(sql);
    expect(out.profile_literal_count).toBe(4);
    expect(out.retired_key_hits).toEqual({
      cartridge_id: 2,
      topology_parent_id: 1,
      origin: 2,
    });
    expect(out.forge_export_clean).toBe(false);
  });

  it('exposes the retired-key list for consumers that want to introspect it', () => {
    // Pin the canonical list so any future widening of the ARCH-19
    // drop fails this test loudly.
    expect(ARCH19_RETIRED_PROFILE_KEYS).toEqual([
      'cartridge_id',
      'topology_parent_id',
      'origin',
    ]);
  });
});

describe('deriveForgeSqlEvidence', () => {
  it('returns source=forge_sql + parsed result when a path is supplied', () => {
    const sql = wrap(
      "(1, 'location', 'X', NULL, '{\"source_slug\":\"x\"}'::jsonb, ARRAY['location'], 'grinhaven-full', FALSE)",
    );
    const evidence = deriveForgeSqlEvidence({
      forgeSqlPath: '/abs/path/preview.sql',
      manualForgeExportClean: false,
      readSql: () => sql,
    });
    expect(evidence).toEqual({
      source: 'forge_sql',
      path: '/abs/path/preview.sql',
      profile_literal_count: 1,
      retired_key_hits: {cartridge_id: 0, topology_parent_id: 0, origin: 0},
      parse_errors: [],
      forge_export_clean: true,
    });
  });

  it('forge-sql wins over manual --forge-export-clean (dirty artifact stays not-clean)', () => {
    const dirtySql = wrap(
      "(1, 'a', 'A', NULL, '{\"cartridge_id\":\"x\"}'::jsonb, ARRAY['a'], 'x', FALSE)",
    );
    const evidence = deriveForgeSqlEvidence({
      forgeSqlPath: '/abs/dirty.sql',
      manualForgeExportClean: true,
      readSql: () => dirtySql,
    });
    expect(evidence.source).toBe('forge_sql');
    expect(evidence.forge_export_clean).toBe(false);
    expect(evidence.retired_key_hits.cartridge_id).toBe(1);
  });

  it('source=manual with forge_export_clean=true preserves the legacy operator-override path', () => {
    const evidence = deriveForgeSqlEvidence({
      forgeSqlPath: null,
      manualForgeExportClean: true,
    });
    expect(evidence.source).toBe('manual');
    expect(evidence.path).toBeNull();
    expect(evidence.forge_export_clean).toBe(true);
    expect(evidence.profile_literal_count).toBe(0);
    expect(evidence.parse_errors).toEqual([]);
  });

  it('source=none with forge_export_clean=false when neither flag is supplied', () => {
    const evidence = deriveForgeSqlEvidence({
      forgeSqlPath: null,
      manualForgeExportClean: false,
    });
    expect(evidence).toEqual({
      source: 'none',
      path: null,
      profile_literal_count: 0,
      retired_key_hits: {cartridge_id: 0, topology_parent_id: 0, origin: 0},
      parse_errors: [],
      forge_export_clean: false,
    });
  });

  it('captures fs read errors as a parse_errors entry, never silently authorizes the drop', () => {
    const evidence = deriveForgeSqlEvidence({
      forgeSqlPath: '/abs/missing.sql',
      manualForgeExportClean: true,
      readSql: () => {
        throw new Error('ENOENT: no such file');
      },
    });
    expect(evidence.source).toBe('forge_sql');
    expect(evidence.path).toBe('/abs/missing.sql');
    expect(evidence.forge_export_clean).toBe(false);
    expect(evidence.parse_errors.length).toBe(1);
    expect(evidence.parse_errors[0]).toMatch(/forge_sql_read_failed:ENOENT/);
  });
});
