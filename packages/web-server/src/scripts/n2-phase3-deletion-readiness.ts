/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Artifact-only evaluator for the N-2 Phase 3 deletion-readiness
// policy. Reads one or more `driver-summary.json` files produced by
// `packages/desktop-electron/scripts/n2-phase3-soak.ps1`, aggregates
// the counters / language / cartridge / model-family sets across them,
// runs the same `evaluateNarrateSanitiserDeletionReadiness` policy
// helper the soak driver uses, and prints the typed decision to
// stdout. Designed for post-hoc audits that do NOT relaunch the
// packaged desktop EXE — useful when stitching together evidence from
// multiple cartridges or model families collected on separate runs.
//
// Usage:
//   # Explicit paths (preserved contract — always included regardless
//   # of provenance):
//   tsx src/scripts/n2-phase3-deletion-readiness.ts \
//     --artifact path/to/run1/driver-summary.json \
//     --artifact path/to/run2/driver-summary.json
//
//   # Auto-discovery (provenance-gated by default — legacy summaries
//   # lacking `cartridge_source` / `model_family_source` are skipped
//   # so a stale "packaged"-defaulted run can't silently inflate the
//   # diversity gate):
//   tsx src/scripts/n2-phase3-deletion-readiness.ts \
//     --artifact-root .codex/run-logs/live-playtest \
//     --driver-kind-prefix n2-phase3 \
//     --limit 10
//
//   # Optional flags shared by both modes:
//     [--min-inspected-events N]
//     [--min-languages N]
//     [--min-cartridges N]
//     [--min-model-families N]
//     [--include-legacy]              # auto-discovery only: do NOT
//                                       # skip artifacts missing the
//                                       # provenance fields.
//
// Discovery rules:
//   - scans direct child directories of `--artifact-root`;
//   - within each, requires a `driver-summary.json`;
//   - filters by `summary.driver_kind` starting with the prefix
//     (default `n2-phase3`);
//   - sorts newest-first by `summary.driver_end_iso` when present,
//     falling back to the directory name (which the soak driver
//     prefixes with `<kind>-<UTC stamp>` — lexicographic order matches
//     newest-first for the stamp format `yyyyMMddTHHmmssZ`);
//   - takes at most `--limit` entries (default 10);
//   - skips entries missing both provenance fields with
//     `reason: 'missing_provenance'` unless `--include-legacy`.
//
// Exit code 0 when `ready_for_regex_deletion: true`, 1 otherwise, 2 on
// IO/parse error. Stable so the script can be wired into CI gates.

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {
  aggregateDriverSummariesForDeletionReadiness,
  DEFAULT_DELETION_READINESS_POLICY,
  deriveAggregatedPolicy,
  type DeletionReadinessPolicy,
  type DriverSummaryArtifact,
} from '../devtools/narrateSanitiserDeletionReadiness.js';

export const DEFAULT_DRIVER_KIND_PREFIX = 'n2-phase3';
export const DEFAULT_DISCOVERY_LIMIT = 10;

export interface CliArgs {
  artifactPaths: string[];
  artifactRoot: string | null;
  driverKindPrefix: string;
  limit: number;
  includeLegacy: boolean;
  /** Each axis is the operator-supplied override (a finite ≥ 0
   *  number) or `null` when no flag was passed for that axis. The
   *  runtime resolves `null` axes against the artifacts' embedded
   *  policies via `deriveAggregatedPolicy`, with
   *  `DEFAULT_DELETION_READINESS_POLICY` as the final fallback. */
  policyOverrides: {
    [K in keyof DeletionReadinessPolicy]: number | null;
  };
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const {values, positionals} = parseArgs({
    args: argv as string[],
    options: {
      artifact: {type: 'string', multiple: true},
      'artifact-root': {type: 'string'},
      'driver-kind-prefix': {type: 'string'},
      limit: {type: 'string'},
      'include-legacy': {type: 'boolean'},
      'min-inspected-events': {type: 'string'},
      'min-languages': {type: 'string'},
      'min-cartridges': {type: 'string'},
      'min-model-families': {type: 'string'},
    },
    strict: true,
    allowPositionals: true,
  });
  const artifactPaths: string[] = [
    ...((values.artifact as string[] | undefined) ?? []),
    ...positionals,
  ];
  const artifactRoot = (values['artifact-root'] as string | undefined) ?? null;
  if (artifactPaths.length === 0 && !artifactRoot) {
    throw new Error(
      'No artifact paths supplied. Pass one or more via --artifact <path> or as positional arguments, OR pass --artifact-root <dir> for auto-discovery.',
    );
  }
  const numberOrNull = (raw: unknown): number | null => {
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid numeric policy value: ${String(raw)}`);
    }
    return n;
  };
  const positiveInt = (raw: unknown, fallback: number): number => {
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw new Error(`Invalid --limit value: ${String(raw)} (must be a positive integer)`);
    }
    return n;
  };
  return {
    artifactPaths,
    artifactRoot,
    driverKindPrefix:
      (values['driver-kind-prefix'] as string | undefined) ??
      DEFAULT_DRIVER_KIND_PREFIX,
    limit: positiveInt(values.limit, DEFAULT_DISCOVERY_LIMIT),
    includeLegacy: (values['include-legacy'] as boolean | undefined) === true,
    policyOverrides: {
      min_inspected_events: numberOrNull(values['min-inspected-events']),
      min_languages: numberOrNull(values['min-languages']),
      min_cartridges: numberOrNull(values['min-cartridges']),
      min_model_families: numberOrNull(values['min-model-families']),
    },
  };
}

/**
 * Resolve the effective policy for a deletion-readiness evaluation:
 * CLI override > artifact-embedded policy > DEFAULT_*. Per-axis.
 */
export function resolveEffectivePolicy(
  artifacts: readonly DriverSummaryArtifact[],
  overrides: CliArgs['policyOverrides'],
): DeletionReadinessPolicy {
  const derived = deriveAggregatedPolicy(
    artifacts,
    DEFAULT_DELETION_READINESS_POLICY,
  );
  return {
    min_inspected_events:
      overrides.min_inspected_events ?? derived.min_inspected_events,
    min_languages: overrides.min_languages ?? derived.min_languages,
    min_cartridges: overrides.min_cartridges ?? derived.min_cartridges,
    min_model_families:
      overrides.min_model_families ?? derived.min_model_families,
  };
}

export function loadDriverSummaryArtifact(
  path: string,
): DriverSummaryArtifact {
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`Artifact path is not a file: ${path}`);
  }
  // PowerShell 5.1 writes UTF-8 files with a BOM by default, so strip
  // one leading U+FEFF before JSON.parse.
  let raw = readFileSync(path, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Artifact ${path} is not a JSON object`);
  }
  return parsed as DriverSummaryArtifact;
}

export interface DiscoveredArtifact {
  path: string;
  summary: DriverSummaryArtifact;
}

export interface SkippedArtifact {
  path: string;
  reason: 'missing_provenance';
}

export interface DiscoveryResult {
  discovered: DiscoveredArtifact[];
  skipped: SkippedArtifact[];
}

/** Pure: list direct child directories of `root` containing a
 *  `driver-summary.json` and whose summary matches the prefix +
 *  provenance filter. Sort newest-first by `driver_end_iso` (falling
 *  back to the directory name; the soak driver prefixes the dir with
 *  the UTC stamp `yyyyMMddTHHmmssZ` so lexicographic sort matches).
 *  Apply `limit` AFTER the prefix + provenance filter so legacy
 *  artifacts cannot push real evidence below the cutoff. */
export function discoverArtifactsFromRoot(
  root: string,
  options: {
    driverKindPrefix: string;
    limit: number;
    includeLegacy: boolean;
  },
): DiscoveryResult {
  const rootStat = statSync(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Artifact root is not a directory: ${root}`);
  }
  const entries = readdirSync(root, {withFileTypes: true});
  const candidates: DiscoveredArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, 'driver-summary.json');
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let summary: DriverSummaryArtifact;
    try {
      summary = loadDriverSummaryArtifact(candidate);
    } catch {
      // A corrupt summary is not the same as a missing one — surface
      // by silently skipping; explicit `--artifact <path>` is the
      // escape hatch when an operator wants to debug a broken artifact.
      continue;
    }
    if (typeof summary.driver_kind !== 'string') continue;
    if (!summary.driver_kind.startsWith(options.driverKindPrefix)) continue;
    candidates.push({path: candidate, summary});
  }

  candidates.sort((a, b) => {
    const aKey =
      typeof a.summary.driver_end_iso === 'string'
        ? a.summary.driver_end_iso
        : a.path;
    const bKey =
      typeof b.summary.driver_end_iso === 'string'
        ? b.summary.driver_end_iso
        : b.path;
    if (aKey > bKey) return -1;
    if (aKey < bKey) return 1;
    return 0;
  });

  const discovered: DiscoveredArtifact[] = [];
  const skipped: SkippedArtifact[] = [];
  for (const c of candidates) {
    if (discovered.length >= options.limit) break;
    const hasProvenance =
      typeof c.summary.cartridge_source === 'string' &&
      typeof c.summary.model_family_source === 'string';
    if (!hasProvenance && !options.includeLegacy) {
      skipped.push({path: c.path, reason: 'missing_provenance'});
      continue;
    }
    discovered.push(c);
  }
  return {discovered, skipped};
}

export interface ArtifactEvidence {
  path: string;
  driver_kind: string | null;
  driver_end_iso: string | null;
  cartridges_attempted: string[];
  cartridges_attempted_raw: string[] | null;
  cartridge_source: string | null;
  model_families_attempted: string[];
  model_families_attempted_raw: string[] | null;
  model_family_source: string | null;
  local_soak_passed: boolean | null;
  ready_for_regex_deletion: boolean | null;
}

function asStringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function buildArtifactEvidence(
  path: string,
  summary: DriverSummaryArtifact,
): ArtifactEvidence {
  return {
    path,
    driver_kind:
      typeof summary.driver_kind === 'string' ? summary.driver_kind : null,
    driver_end_iso:
      typeof summary.driver_end_iso === 'string'
        ? summary.driver_end_iso
        : null,
    cartridges_attempted: asStringArray(summary.cartridges_attempted),
    cartridges_attempted_raw: asStringArrayOrNull(
      summary.cartridges_attempted_raw,
    ),
    cartridge_source:
      typeof summary.cartridge_source === 'string'
        ? summary.cartridge_source
        : null,
    model_families_attempted: asStringArray(summary.model_families_attempted),
    model_families_attempted_raw: asStringArrayOrNull(
      summary.model_families_attempted_raw,
    ),
    model_family_source:
      typeof summary.model_family_source === 'string'
        ? summary.model_family_source
        : null,
    local_soak_passed:
      typeof summary.local_soak_passed === 'boolean'
        ? summary.local_soak_passed
        : null,
    ready_for_regex_deletion:
      typeof summary.ready_for_regex_deletion === 'boolean'
        ? summary.ready_for_regex_deletion
        : null,
  };
}

export interface ProvenanceSummary {
  cartridge_sources: Record<string, number>;
  model_family_sources: Record<string, number>;
  artifacts_with_provenance: number;
  artifacts_missing_provenance: number;
  skipped_artifact_count: number;
}

export function summariseProvenance(
  evidence: readonly ArtifactEvidence[],
  skipped: readonly SkippedArtifact[],
): ProvenanceSummary {
  const cartridgeSources: Record<string, number> = {};
  const modelFamilySources: Record<string, number> = {};
  let withProvenance = 0;
  let missingProvenance = 0;
  for (const e of evidence) {
    const cartridgeKey = e.cartridge_source ?? 'absent';
    const familyKey = e.model_family_source ?? 'absent';
    cartridgeSources[cartridgeKey] = (cartridgeSources[cartridgeKey] ?? 0) + 1;
    modelFamilySources[familyKey] = (modelFamilySources[familyKey] ?? 0) + 1;
    if (e.cartridge_source !== null && e.model_family_source !== null) {
      withProvenance += 1;
    } else {
      missingProvenance += 1;
    }
  }
  return {
    cartridge_sources: cartridgeSources,
    model_family_sources: modelFamilySources,
    artifacts_with_provenance: withProvenance,
    artifacts_missing_provenance: missingProvenance,
    skipped_artifact_count: skipped.length,
  };
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl && import.meta.url === entryUrl) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const explicitArtifacts: DiscoveredArtifact[] = args.artifactPaths.map(
      (p) => ({path: p, summary: loadDriverSummaryArtifact(p)}),
    );
    let discovered: DiscoveredArtifact[] = [];
    let skipped: SkippedArtifact[] = [];
    if (args.artifactRoot) {
      const result = discoverArtifactsFromRoot(args.artifactRoot, {
        driverKindPrefix: args.driverKindPrefix,
        limit: args.limit,
        includeLegacy: args.includeLegacy,
      });
      discovered = result.discovered;
      skipped = result.skipped;
    }
    const allArtifacts = [...explicitArtifacts, ...discovered];
    if (allArtifacts.length === 0) {
      throw new Error(
        `No artifacts matched (root=${args.artifactRoot ?? '<none>'} prefix=${args.driverKindPrefix} limit=${args.limit} include_legacy=${args.includeLegacy}). Auto-discovery may have skipped legacy artifacts that lack provenance fields.`,
      );
    }
    const summaries = allArtifacts.map((a) => a.summary);
    const policy = resolveEffectivePolicy(summaries, args.policyOverrides);
    const decision = aggregateDriverSummariesForDeletionReadiness(
      summaries,
      policy,
    );
    const artifactEvidence = allArtifacts.map((a) =>
      buildArtifactEvidence(a.path, a.summary),
    );
    const provenance = summariseProvenance(artifactEvidence, skipped);
    const out = {
      ...decision,
      artifact_paths: allArtifacts.map((a) => a.path),
      artifact_evidence: artifactEvidence,
      provenance_summary: provenance,
      skipped_artifacts: skipped,
      discovery: {
        artifact_root: args.artifactRoot,
        driver_kind_prefix: args.driverKindPrefix,
        limit: args.limit,
        include_legacy: args.includeLegacy,
      },
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exitCode = decision.ready_for_regex_deletion ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({ok: false, error: message}, null, 2)}\n`,
    );
    process.exitCode = 2;
  }
}
