/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// CLI surface for `arch19-phase4-readiness.ts`. Pins the argv
// contract, the source-sweep helper's allowlist behavior, and the
// `buildReadinessInput` glue that stitches sweep output + DB counts
// into the typed `evaluateArch19Phase4Readiness` shape.
//
// The CLI script itself does not need a live database for these
// tests — the DB path is gated behind `--no-db` and the helper takes
// a `dbCounts` parameter, so the suite stays under one second.

import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  ARCH19_PHASE3_SHIPPED_DEFAULT,
  evaluateArch19Phase4Readiness,
  type Arch19Phase4ReadinessInput,
} from '../../devtools/arch19Phase4Readiness.js';
import {
  ARCH19_READER_SWEEP_ALLOWLIST,
  scanArch19LegacyReaders,
} from '../../devtools/arch19SourceSweep.js';
import {
  buildReadinessInput,
  parseCliArgs,
} from '../../scripts/arch19-phase4-readiness.js';
import {deriveForgeSqlEvidence} from '../../devtools/arch19ForgeSqlEvidence.js';

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, {recursive: true, force: true});
    tmpDir = null;
  }
});

describe('parseCliArgs', () => {
  it('reads each flag and supports `--key=value` and `--key value` forms', () => {
    const args = parseCliArgs([
      '--as-of=2026-05-17',
      '--phase3-shipped',
      '2026-05-15',
      '--min-dev-soak-days',
      '14',
      '--prod-release-confirmed',
      '--forge-export-clean',
      '--no-db',
    ]);
    expect(args).toEqual({
      asOf: '2026-05-17',
      phase3Shipped: '2026-05-15',
      minDevSoakDays: 14,
      prodReleaseConfirmed: true,
      forgeExportClean: true,
      forgeSqlPath: null,
      noDb: true,
      localDevOverride: false,
    });
  });

  it('reads --local-dev-override as a boolean flag', () => {
    const args = parseCliArgs(['--local-dev-override']);
    expect(args.localDevOverride).toBe(true);
  });

  it('reads --forge-sql in both `--flag=value` and `--flag value` forms', () => {
    const a = parseCliArgs(['--forge-sql', '/abs/path/preview.sql']);
    expect(a.forgeSqlPath).toBe('/abs/path/preview.sql');
    const b = parseCliArgs(['--forge-sql=C:\\Greenhaven\\preview.sql']);
    expect(b.forgeSqlPath).toBe('C:\\Greenhaven\\preview.sql');
  });

  it('rejects empty --forge-sql values', () => {
    expect(() => parseCliArgs(['--forge-sql='])).toThrow(/non-empty path/);
  });

  it('defaults: today / 2026-05-15 / 14 days / no confirmations / no forge sql', () => {
    const args = parseCliArgs([]);
    expect(args.phase3Shipped).toBe(ARCH19_PHASE3_SHIPPED_DEFAULT);
    expect(args.minDevSoakDays).toBe(14);
    expect(args.prodReleaseConfirmed).toBe(false);
    expect(args.forgeExportClean).toBe(false);
    expect(args.forgeSqlPath).toBeNull();
    expect(args.noDb).toBe(false);
    expect(args.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects unknown flags / missing values / non-numeric soak days', () => {
    expect(() => parseCliArgs(['--unknown', 'x'])).toThrow(/unknown flag/);
    expect(() => parseCliArgs(['--as-of'])).toThrow(/missing value/);
    expect(() => parseCliArgs(['--min-dev-soak-days', 'abc'])).toThrow(
      /invalid --min-dev-soak-days/,
    );
  });
});

describe('scanArch19LegacyReaders', () => {
  it('reports offenders that touch profile->>\'cartridge_id\' outside the allowlist', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'arch19-sweep-'));
    const offFile = path.join(tmpDir, 'offender.ts');
    const allowFile = path.join(tmpDir, 'allowed.ts');
    await writeFile(
      offFile,
      "export const sql = `SELECT profile->>'cartridge_id' FROM entities`;\n",
    );
    await writeFile(
      allowFile,
      "export const ok = `profile->>'cartridge_id'`;\n",
    );
    const offenders = scanArch19LegacyReaders({
      srcRoot: tmpDir,
      allowlist: ['allowed.ts'],
    });
    expect(offenders).toEqual([
      {file: 'offender.ts', sample: "profile->>'cartridge_id'"},
    ]);
  });

  it('also catches profile[\'origin\'] bracket access', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'arch19-sweep-'));
    const offFile = path.join(tmpDir, 'bracket.ts');
    await writeFile(
      offFile,
      "const o = entity.profile['origin'];\n",
    );
    const offenders = scanArch19LegacyReaders({srcRoot: tmpDir, allowlist: []});
    expect(offenders).toEqual([
      {file: 'bracket.ts', sample: "profile['origin']"},
    ]);
  });

  it('skips __tests__ subdirectories and non-ts files', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'arch19-sweep-'));
    await mkdir(path.join(tmpDir, '__tests__'), {recursive: true});
    await writeFile(
      path.join(tmpDir, '__tests__', 'spec.ts'),
      "const x = `profile->>'cartridge_id'`;\n",
    );
    await writeFile(
      path.join(tmpDir, 'readme.md'),
      "profile->>'cartridge_id'\n",
    );
    const offenders = scanArch19LegacyReaders({srcRoot: tmpDir, allowlist: []});
    expect(offenders).toEqual([]);
  });

  it('exposes the canonical allowlist (matches arch19ReaderSweep.test.ts)', () => {
    expect(ARCH19_READER_SWEEP_ALLOWLIST).toEqual([
      'entities/profileProjection.ts',
      'tools/entity.ts',
      'worldFactGuard.ts',
      'quest/dynamicQuestPlan.ts',
      'devtools/generateMigrationSnippet.ts',
      'scripts/entity-card-io.ts',
      'devtools/arch19SourceSweep.ts',
      'devtools/arch19Phase4Readiness.ts',
      'devtools/arch19ForgeSqlEvidence.ts',
      'scripts/arch19-phase4-readiness.ts',
    ]);
  });
});

describe('buildReadinessInput', () => {
  it('threads source-sweep offenders + DB counts into the policy decision', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'arch19-input-'));
    await writeFile(
      path.join(tmpDir, 'offender.ts'),
      "const sql = `profile->>'cartridge_id'`;\n",
    );
    const cliArgs = parseCliArgs([
      '--as-of=2026-05-17',
      '--phase3-shipped=2026-05-15',
      '--min-dev-soak-days=14',
      '--no-db',
    ]);
    const {input, offenders} = buildReadinessInput({
      args: cliArgs,
      srcRoot: tmpDir,
      dbCounts: {
        cartridge_id_parity_mismatches: 0,
        topology_parent_id_parity_mismatches: 0,
        dynamic_origin_parity_mismatches: 0,
        null_cartridge_id_rows: 0,
        legacy_key_counts: {
          profile_cartridge_id: 0,
          profile_topology_parent_id: 0,
          profile_origin: 0,
        },
        legacy_tag_counts: {dynamic_tag: 0, support_smoke_tag: 0},
      },
      databaseSafetyChecked: false,
      forgeEvidence: deriveForgeSqlEvidence({
        forgeSqlPath: null,
        manualForgeExportClean: cliArgs.forgeExportClean,
      }),
    });
    expect(offenders.map((o) => o.file)).toEqual(['offender.ts']);
    expect(input.policy.min_dev_soak_days).toBe(14);
    const decision = evaluateArch19Phase4Readiness(input);
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        'dev_soak_window_not_elapsed:2/14_days',
        'prod_release_not_confirmed',
        'forge_export_still_writes_dropped_keys',
        'source_sweep_offender:offender.ts',
        'database_counts_not_checked',
      ]),
    );
  });

  it('source-only --no-db advisory after soak date still blocks on database_counts_not_checked', async () => {
    // Recreates the exact CLI invocation the spec requires to exit 1:
    //   --as-of 2026-06-01 --phase3-shipped 2026-05-15
    //   --min-dev-soak-days 14 --prod-release-confirmed
    //   --forge-export-clean --no-db
    // Even though every clause except DB evidence passes, the
    // evaluator must refuse to authorize the destructive drop.
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'arch19-input-'));
    const cliArgs = parseCliArgs([
      '--as-of=2026-06-01',
      '--phase3-shipped=2026-05-15',
      '--min-dev-soak-days=14',
      '--prod-release-confirmed',
      '--forge-export-clean',
      '--no-db',
    ]);
    const {input} = buildReadinessInput({
      args: cliArgs,
      srcRoot: tmpDir,
      dbCounts: {
        cartridge_id_parity_mismatches: 0,
        topology_parent_id_parity_mismatches: 0,
        dynamic_origin_parity_mismatches: 0,
        null_cartridge_id_rows: 0,
        legacy_key_counts: {
          profile_cartridge_id: 0,
          profile_topology_parent_id: 0,
          profile_origin: 0,
        },
        legacy_tag_counts: {dynamic_tag: 0, support_smoke_tag: 0},
      },
      databaseSafetyChecked: false,
      forgeEvidence: deriveForgeSqlEvidence({
        forgeSqlPath: null,
        manualForgeExportClean: cliArgs.forgeExportClean,
      }),
    });
    const decision = evaluateArch19Phase4Readiness(
      input satisfies Arch19Phase4ReadinessInput,
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toEqual(['database_counts_not_checked']);
    expect(decision.observed.database_safety_checked).toBe(false);
  });

  it('returns ready=true only when database_safety_checked is true (post-soak happy path with DB evidence)', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'arch19-input-'));
    const cliArgs = parseCliArgs([
      '--as-of=2026-06-01',
      '--phase3-shipped=2026-05-15',
      '--min-dev-soak-days=14',
      '--prod-release-confirmed',
      '--forge-export-clean',
    ]);
    const {input} = buildReadinessInput({
      args: cliArgs,
      srcRoot: tmpDir,
      dbCounts: {
        cartridge_id_parity_mismatches: 0,
        topology_parent_id_parity_mismatches: 0,
        dynamic_origin_parity_mismatches: 0,
        null_cartridge_id_rows: 0,
        legacy_key_counts: {
          profile_cartridge_id: 0,
          profile_topology_parent_id: 0,
          profile_origin: 0,
        },
        legacy_tag_counts: {dynamic_tag: 0, support_smoke_tag: 0},
      },
      databaseSafetyChecked: true,
      forgeEvidence: deriveForgeSqlEvidence({
        forgeSqlPath: null,
        manualForgeExportClean: cliArgs.forgeExportClean,
      }),
    });
    const decision = evaluateArch19Phase4Readiness(
      input satisfies Arch19Phase4ReadinessInput,
    );
    expect(decision.ready_for_phase4_drop).toBe(true);
    expect(decision.blockers).toEqual([]);
  });

  it('forge-SQL evidence wins over --forge-export-clean and sets forge_export_clean from parsed result', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'arch19-input-'));
    const cliArgs = parseCliArgs([
      '--as-of=2026-06-01',
      '--phase3-shipped=2026-05-15',
      '--min-dev-soak-days=14',
      '--prod-release-confirmed',
      '--forge-export-clean',
      '--forge-sql',
      '/abs/dirty.sql',
    ]);
    // Synthetic dirty SQL — operator passed --forge-export-clean but
    // the artifact STILL writes a retired key. The artifact must
    // win: forge_export_clean stays false, the blocker fires.
    const dirtySql =
      "INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id, dynamic_origin) VALUES\n" +
      "(1, 'location', 'X', NULL, '{\"cartridge_id\":\"grinhaven-full\",\"source_slug\":\"x\"}'::jsonb, ARRAY['location'], 'grinhaven-full', FALSE)\n" +
      'ON CONFLICT (id) DO UPDATE SET ...';
    const evidence = deriveForgeSqlEvidence({
      forgeSqlPath: cliArgs.forgeSqlPath,
      manualForgeExportClean: cliArgs.forgeExportClean,
      readSql: () => dirtySql,
    });
    expect(evidence.source).toBe('forge_sql');
    expect(evidence.forge_export_clean).toBe(false);
    expect(evidence.retired_key_hits.cartridge_id).toBe(1);
    const {input} = buildReadinessInput({
      args: cliArgs,
      srcRoot: tmpDir,
      dbCounts: {
        cartridge_id_parity_mismatches: 0,
        topology_parent_id_parity_mismatches: 0,
        dynamic_origin_parity_mismatches: 0,
        null_cartridge_id_rows: 0,
        legacy_key_counts: {
          profile_cartridge_id: 0,
          profile_topology_parent_id: 0,
          profile_origin: 0,
        },
        legacy_tag_counts: {dynamic_tag: 0, support_smoke_tag: 0},
      },
      databaseSafetyChecked: true,
      forgeEvidence: evidence,
    });
    const decision = evaluateArch19Phase4Readiness(
      input satisfies Arch19Phase4ReadinessInput,
    );
    expect(decision.ready_for_phase4_drop).toBe(false);
    expect(decision.blockers).toContain(
      'forge_export_still_writes_dropped_keys',
    );
    expect(decision.observed.forge_export_clean).toBe(false);
  });

  it('clean forge-SQL evidence unlocks forge_export_clean without --forge-export-clean', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'arch19-input-'));
    const cliArgs = parseCliArgs([
      '--as-of=2026-06-01',
      '--phase3-shipped=2026-05-15',
      '--min-dev-soak-days=14',
      '--prod-release-confirmed',
      '--forge-sql',
      '/abs/clean.sql',
    ]);
    const cleanSql =
      "INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id, dynamic_origin) VALUES\n" +
      "(1, 'location', 'Y', NULL, '{\"source_slug\":\"y\",\"home_id\":2}'::jsonb, ARRAY['location'], 'grinhaven-full', FALSE)\n" +
      'ON CONFLICT (id) DO UPDATE SET ...';
    const evidence = deriveForgeSqlEvidence({
      forgeSqlPath: cliArgs.forgeSqlPath,
      manualForgeExportClean: cliArgs.forgeExportClean,
      readSql: () => cleanSql,
    });
    expect(evidence.source).toBe('forge_sql');
    expect(evidence.forge_export_clean).toBe(true);
    expect(evidence.profile_literal_count).toBe(1);
    const {input} = buildReadinessInput({
      args: cliArgs,
      srcRoot: tmpDir,
      dbCounts: {
        cartridge_id_parity_mismatches: 0,
        topology_parent_id_parity_mismatches: 0,
        dynamic_origin_parity_mismatches: 0,
        null_cartridge_id_rows: 0,
        legacy_key_counts: {
          profile_cartridge_id: 0,
          profile_topology_parent_id: 0,
          profile_origin: 0,
        },
        legacy_tag_counts: {dynamic_tag: 0, support_smoke_tag: 0},
      },
      databaseSafetyChecked: true,
      forgeEvidence: evidence,
    });
    const decision = evaluateArch19Phase4Readiness(
      input satisfies Arch19Phase4ReadinessInput,
    );
    expect(decision.ready_for_phase4_drop).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.observed.forge_export_clean).toBe(true);
  });

  it('preserves manual --forge-export-clean as source="manual" when no --forge-sql is supplied', () => {
    const evidence = deriveForgeSqlEvidence({
      forgeSqlPath: null,
      manualForgeExportClean: true,
    });
    expect(evidence.source).toBe('manual');
    expect(evidence.path).toBeNull();
    expect(evidence.forge_export_clean).toBe(true);
  });

  it('reports source="none" when neither --forge-sql nor --forge-export-clean is supplied', () => {
    const evidence = deriveForgeSqlEvidence({
      forgeSqlPath: null,
      manualForgeExportClean: false,
    });
    expect(evidence.source).toBe('none');
    expect(evidence.forge_export_clean).toBe(false);
  });
});
