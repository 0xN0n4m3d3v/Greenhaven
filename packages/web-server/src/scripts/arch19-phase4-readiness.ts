/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-19 Phase 4 readiness CLI. Non-destructive — runs the static
// source-sweep over `packages/web-server/src/`, optionally counts
// normalized-column parity and null-cartridge-id rows against a
// PGlite dataset, then prints the typed decision from
// `evaluateArch19Phase4Readiness`.
//
// Usage:
//   tsx src/scripts/arch19-phase4-readiness.ts \
//     [--as-of 2026-05-17] \
//     [--phase3-shipped 2026-05-15] \
//     [--min-dev-soak-days 14] \
//     [--prod-release-confirmed] \
//     [--forge-export-clean] \
//     [--forge-sql <path>] \
//     [--pgdata <dir> | --fixture-mode temp] \
//     [--no-db]
//
// Exit codes:
//   0 ready_for_phase4_drop=true
//   1 ready_for_phase4_drop=false (any blocker)
//   2 parse/IO error
//
// On today's date (2026-05-17) against a fresh dev fixture this MUST
// exit 1 with at least the dev-soak-window and prod-release blockers
// — Phase 3 shipped 2026-05-15, so the 14-day soak has not elapsed.
//
// Forge export cleanliness can be proven from a generated SQL
// artifact via `--forge-sql <path>`. When supplied, the CLI parses
// every per-entity `profile` JSONB literal in the entity VALUES
// block and reports `forge_export_clean: true` only if none carry
// the retired ARCH-19 keys (`cartridge_id`, `topology_parent_id`,
// `origin`). `--forge-sql` wins over `--forge-export-clean`; the
// manual flag remains as the explicit operator override path when
// no SQL artifact is available.

import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {
  ARCH19_PHASE3_SHIPPED_DEFAULT,
  DEFAULT_ARCH19_PHASE4_POLICY,
  evaluateArch19Phase4Readiness,
  type Arch19Phase4ReadinessInput,
  type Arch19Phase4ReadinessPolicy,
} from '../devtools/arch19Phase4Readiness.js';
import {
  scanArch19LegacyReaders,
  type SourceSweepOffender,
} from '../devtools/arch19SourceSweep.js';
import {
  deriveForgeSqlEvidence,
  type ForgeSqlEvidence,
} from '../devtools/arch19ForgeSqlEvidence.js';
import {
  clearConfigEnv,
  rawConfigEnv,
  setConfigEnv,
} from '../config.js';
import {mkdir, mkdtemp} from 'node:fs/promises';

export interface CliArgs {
  asOf: string;
  phase3Shipped: string;
  minDevSoakDays: number;
  prodReleaseConfirmed: boolean;
  forgeExportClean: boolean;
  forgeSqlPath: string | null;
  pgdata?: string;
  fixtureMode?: 'temp';
  noDb: boolean;
  /** ARCH-19 local/dev override (2026-05-17): under the operator
   *  start-prompt override, local/dev pgdata is disposable and the
   *  calendar/prod gates are waived. DB counts, source sweep,
   *  forge-SQL evidence, and parity/null checks still apply. */
  localDevOverride: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = {
    asOf: new Date().toISOString().slice(0, 10),
    phase3Shipped: ARCH19_PHASE3_SHIPPED_DEFAULT,
    minDevSoakDays: DEFAULT_ARCH19_PHASE4_POLICY.min_dev_soak_days,
    prodReleaseConfirmed: false,
    forgeExportClean: false,
    forgeSqlPath: null,
    noDb: false,
    localDevOverride: false,
  };
  const arr = [...argv];
  for (let i = 0; i < arr.length; i += 1) {
    const arg = arr[i]!;
    if (arg === '--prod-release-confirmed') {
      out.prodReleaseConfirmed = true;
      continue;
    }
    if (arg === '--forge-export-clean') {
      out.forgeExportClean = true;
      continue;
    }
    if (arg === '--no-db') {
      out.noDb = true;
      continue;
    }
    if (arg === '--local-dev-override') {
      out.localDevOverride = true;
      continue;
    }
    const eqIdx = arg.indexOf('=');
    const isLongFlag = arg.startsWith('--');
    let key: string;
    let value: string | undefined;
    if (isLongFlag && eqIdx > 0) {
      key = arg.slice(0, eqIdx);
      value = arg.slice(eqIdx + 1);
    } else if (isLongFlag) {
      key = arg;
      value = arr[i + 1];
      if (value == null || value.startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      i += 1;
    } else {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    switch (key) {
      case '--as-of':
        out.asOf = value;
        break;
      case '--phase3-shipped':
        out.phase3Shipped = value;
        break;
      case '--min-dev-soak-days': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`invalid --min-dev-soak-days value: ${value}`);
        }
        out.minDevSoakDays = n;
        break;
      }
      case '--forge-sql':
        if (!value || value.trim().length === 0) {
          throw new Error('--forge-sql requires a non-empty path');
        }
        out.forgeSqlPath = value;
        break;
      case '--pgdata':
        out.pgdata = value;
        break;
      case '--fixture-mode':
        if (value !== 'temp') {
          throw new Error(`--fixture-mode must be 'temp' (got ${value})`);
        }
        out.fixtureMode = value;
        break;
      default:
        throw new Error(`unknown flag: ${key}`);
    }
  }
  return out;
}

async function maybeRedirectPglite(args: CliArgs): Promise<void> {
  if (args.noDb) return;
  if (args.pgdata) {
    clearConfigEnv('DATABASE_URL');
    setConfigEnv('PGLITE_DATA_DIR', path.resolve(args.pgdata));
    return;
  }
  if (args.fixtureMode === 'temp') {
    clearConfigEnv('DATABASE_URL');
    const base =
      rawConfigEnv('GREENHAVEN_DEVTOOLS_TMP') ??
      (process.platform === 'win32' ? 'C:\\tmp' : '/tmp');
    await mkdir(base, {recursive: true});
    const dir = await mkdtemp(
      path.join(base, 'greenhaven-arch19-phase4-readiness-'),
    );
    setConfigEnv('PGLITE_DATA_DIR', dir);
  }
}

export interface Arch19DbCounts {
  cartridge_id_parity_mismatches: number;
  topology_parent_id_parity_mismatches: number;
  dynamic_origin_parity_mismatches: number;
  null_cartridge_id_rows: number;
  legacy_key_counts: {
    profile_cartridge_id: number;
    profile_topology_parent_id: number;
    profile_origin: number;
  };
  legacy_tag_counts: {
    dynamic_tag: number;
    support_smoke_tag: number;
  };
}

const ZERO_DB_COUNTS: Arch19DbCounts = {
  cartridge_id_parity_mismatches: 0,
  topology_parent_id_parity_mismatches: 0,
  dynamic_origin_parity_mismatches: 0,
  null_cartridge_id_rows: 0,
  legacy_key_counts: {
    profile_cartridge_id: 0,
    profile_topology_parent_id: 0,
    profile_origin: 0,
  },
  legacy_tag_counts: {
    dynamic_tag: 0,
    support_smoke_tag: 0,
  },
};

async function loadDbCounts(): Promise<Arch19DbCounts> {
  const {runMigrations} = await import('../migrate.js');
  await runMigrations();
  const {query, closeDb} = await import('../db.js');
  try {
    const intOf = async (sql: string): Promise<number> => {
      const result = await query<{n: number}>(sql);
      return result.rows[0]?.n ?? 0;
    };
    const cartridgeIdParity = await intOf(
      `SELECT COUNT(*)::int AS n FROM entities
       WHERE NULLIF(TRIM(profile->>'cartridge_id'), '') IS NOT NULL
         AND (cartridge_id IS DISTINCT FROM NULLIF(TRIM(profile->>'cartridge_id'), ''))`,
    );
    const topologyParity = await intOf(
      `SELECT COUNT(*)::int AS n FROM entities
       WHERE profile ? 'topology_parent_id'
         AND safe_to_bigint(profile->>'topology_parent_id') IS NOT NULL
         AND (topology_parent_id IS DISTINCT FROM safe_to_bigint(profile->>'topology_parent_id'))`,
    );
    const dynamicParity = await intOf(
      `SELECT COUNT(*)::int AS n FROM entities
       WHERE (profile->>'origin' = 'dynamic' OR 'dynamic' = ANY(tags))
         AND dynamic_origin = FALSE`,
    );
    // ARCH-19 Phase 4 (migration 0124) — `support-smoke` is now a
    // cartridge id, not a tag-based carve-out. Every non-player
    // non-dynamic row MUST carry a normalized `cartridge_id`; the
    // CHECK constraint enforces this on every INSERT/UPDATE.
    const nullCartridge = await intOf(
      `SELECT COUNT(*)::int AS n FROM entities
       WHERE cartridge_id IS NULL
         AND kind <> 'player'
         AND dynamic_origin = FALSE`,
    );
    const legacyProfileCartridge = await intOf(
      `SELECT COUNT(*)::int AS n FROM entities WHERE profile ? 'cartridge_id'`,
    );
    const legacyProfileTopology = await intOf(
      `SELECT COUNT(*)::int AS n FROM entities WHERE profile ? 'topology_parent_id'`,
    );
    const legacyProfileOrigin = await intOf(
      `SELECT COUNT(*)::int AS n FROM entities WHERE profile ? 'origin'`,
    );
    const dynamicTag = await intOf(
      `SELECT COUNT(*)::int AS n FROM entities WHERE 'dynamic' = ANY(tags)`,
    );
    const supportSmokeTag = await intOf(
      `SELECT COUNT(*)::int AS n FROM entities WHERE 'support-smoke' = ANY(tags)`,
    );
    return {
      cartridge_id_parity_mismatches: cartridgeIdParity,
      topology_parent_id_parity_mismatches: topologyParity,
      dynamic_origin_parity_mismatches: dynamicParity,
      null_cartridge_id_rows: nullCartridge,
      legacy_key_counts: {
        profile_cartridge_id: legacyProfileCartridge,
        profile_topology_parent_id: legacyProfileTopology,
        profile_origin: legacyProfileOrigin,
      },
      legacy_tag_counts: {
        dynamic_tag: dynamicTag,
        support_smoke_tag: supportSmokeTag,
      },
    };
  } finally {
    await closeDb();
  }
}

export interface BuildReadinessOpts {
  args: CliArgs;
  srcRoot: string;
  dbCounts: Arch19DbCounts;
  /** True only after `loadDbCounts()` returned successfully against
   *  a real pgdata. `--no-db` always sets this to false so the
   *  evaluator emits `database_counts_not_checked`. */
  databaseSafetyChecked: boolean;
  /** Resolved forge-SQL evidence (source/path/parsed) for this
   *  evaluation. The evaluator consumes only the boolean
   *  `forge_export_clean`; the rest is audit metadata surfaced in
   *  the CLI's JSON output. Injectable so unit tests can stub the
   *  parser without touching disk. */
  forgeEvidence: ForgeSqlEvidence;
  policyOverride?: Partial<Arch19Phase4ReadinessPolicy>;
  excludeAbsPaths?: ReadonlySet<string>;
}

export function buildReadinessInput(
  opts: BuildReadinessOpts,
): {input: Arch19Phase4ReadinessInput; offenders: SourceSweepOffender[]} {
  const offenders = scanArch19LegacyReaders({
    srcRoot: opts.srcRoot,
    excludeAbsPaths: opts.excludeAbsPaths,
  });
  // ARCH-19 local/dev override (2026-05-17): the operator
  // start-prompt waives historical calendar/prod soak. The
  // override flips the dev-soak-days threshold to 0 and treats
  // prod-release-confirmed as satisfied. Source sweep, DB counts,
  // forge-SQL evidence, parity/null checks STILL apply — only
  // calendar/prod gates relax.
  const localOverride = opts.args.localDevOverride;
  const policy: Arch19Phase4ReadinessPolicy = {
    ...DEFAULT_ARCH19_PHASE4_POLICY,
    min_dev_soak_days: localOverride ? 0 : opts.args.minDevSoakDays,
    require_prod_release: localOverride
      ? false
      : DEFAULT_ARCH19_PHASE4_POLICY.require_prod_release,
    ...opts.policyOverride,
  };
  return {
    offenders,
    input: {
      as_of: opts.args.asOf,
      phase3_shipped: opts.args.phase3Shipped,
      prod_release_confirmed: localOverride
        ? true
        : opts.args.prodReleaseConfirmed,
      forge_export_clean: opts.forgeEvidence.forge_export_clean,
      source_sweep_offenders: offenders,
      cartridge_id_parity_mismatches:
        opts.dbCounts.cartridge_id_parity_mismatches,
      topology_parent_id_parity_mismatches:
        opts.dbCounts.topology_parent_id_parity_mismatches,
      dynamic_origin_parity_mismatches:
        opts.dbCounts.dynamic_origin_parity_mismatches,
      null_cartridge_id_rows: opts.dbCounts.null_cartridge_id_rows,
      legacy_key_counts: opts.dbCounts.legacy_key_counts,
      legacy_tag_counts: opts.dbCounts.legacy_tag_counts,
      database_safety_checked: opts.databaseSafetyChecked,
      policy,
    },
  };
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl && import.meta.url === entryUrl) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    await maybeRedirectPglite(args);
    // Source-only `--no-db` advisory: zero counts and explicit
    // database_safety_checked=false so the evaluator emits the
    // `database_counts_not_checked` blocker. DB load errors propagate
    // through the outer catch as exit-code 2 (parse/IO failure),
    // never as a silent ready=true.
    let dbCounts: Arch19DbCounts;
    let databaseSafetyChecked: boolean;
    if (args.noDb) {
      dbCounts = ZERO_DB_COUNTS;
      databaseSafetyChecked = false;
    } else {
      dbCounts = await loadDbCounts();
      databaseSafetyChecked = true;
    }
    const forgeEvidence = deriveForgeSqlEvidence({
      forgeSqlPath: args.forgeSqlPath,
      manualForgeExportClean: args.forgeExportClean,
    });
    const srcRoot = fileURLToPath(new URL('../', import.meta.url));
    const {input} = buildReadinessInput({
      args,
      srcRoot,
      dbCounts,
      databaseSafetyChecked,
      forgeEvidence,
    });
    const decision = evaluateArch19Phase4Readiness(input);
    const out = {
      ...decision,
      forge_evidence: forgeEvidence,
      local_dev_override: args.localDevOverride,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exitCode = decision.ready_for_phase4_drop ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({ok: false, error: message}, null, 2)}\n`,
    );
    process.exitCode = 2;
  }
}
