/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// CLI parser + artifact loader for `n2-phase3-deletion-readiness.ts`.
// Pins the argv contract (multiple `--artifact` flags, positional
// fallbacks, numeric policy overrides), the artifact loader's
// JSON-only check, and the audit-hardening surface added 2026-05-17:
// `--artifact-root` discovery, `--driver-kind-prefix` filtering,
// `--limit` cap, `--include-legacy` opt-in, plus `artifact_evidence`
// and `provenance_summary` output shaping.

import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {DEFAULT_DELETION_READINESS_POLICY} from '../../devtools/narrateSanitiserDeletionReadiness.js';
import {
  buildArtifactEvidence,
  DEFAULT_DISCOVERY_LIMIT,
  DEFAULT_DRIVER_KIND_PREFIX,
  discoverArtifactsFromRoot,
  loadDriverSummaryArtifact,
  parseCliArgs,
  resolveEffectivePolicy,
  summariseProvenance,
} from '../../scripts/n2-phase3-deletion-readiness.js';

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, {recursive: true, force: true});
    tmpDir = null;
  }
});

async function makeTmpDir(): Promise<string> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'n2-soak-'));
  return tmpDir;
}

async function writeArtifact(
  root: string,
  dirName: string,
  summary: Record<string, unknown>,
): Promise<string> {
  const dir = path.join(root, dirName);
  await mkdir(dir, {recursive: true});
  const file = path.join(dir, 'driver-summary.json');
  await writeFile(file, JSON.stringify(summary));
  return file;
}

describe('parseCliArgs', () => {
  it('reads --artifact flags repeatable and policy overrides as numbers', () => {
    const args = parseCliArgs([
      '--artifact',
      'a.json',
      '--artifact',
      'b.json',
      '--min-inspected-events',
      '12',
      '--min-languages',
      '3',
      '--min-cartridges',
      '4',
      '--min-model-families',
      '5',
    ]);
    expect(args.artifactPaths).toEqual(['a.json', 'b.json']);
    expect(args.policyOverrides).toEqual({
      min_inspected_events: 12,
      min_languages: 3,
      min_cartridges: 4,
      min_model_families: 5,
    });
    // Discovery defaults — preserved when no `--artifact-root` is
    // supplied so the previous explicit-path contract is unchanged.
    expect(args.artifactRoot).toBeNull();
    expect(args.driverKindPrefix).toBe(DEFAULT_DRIVER_KIND_PREFIX);
    expect(args.limit).toBe(DEFAULT_DISCOVERY_LIMIT);
    expect(args.includeLegacy).toBe(false);
  });

  it('returns null for policy axes that were not overridden', () => {
    const args = parseCliArgs(['x.json']);
    expect(args.policyOverrides).toEqual({
      min_inspected_events: null,
      min_languages: null,
      min_cartridges: null,
      min_model_families: null,
    });
  });

  it('treats positionals as artifact paths', () => {
    const args = parseCliArgs(['x.json', 'y.json']);
    expect(args.artifactPaths).toEqual(['x.json', 'y.json']);
  });

  it('throws when neither explicit paths nor --artifact-root is supplied', () => {
    expect(() => parseCliArgs([])).toThrow(/No artifact paths supplied/);
  });

  it('rejects negative or NaN policy values', () => {
    // Node `parseArgs` requires the `=` form for dash-prefixed values
    // so the validator below it sees the literal "-1".
    expect(() => parseCliArgs(['x.json', '--min-cartridges=-1'])).toThrow(
      /Invalid numeric policy value/,
    );
    expect(() => parseCliArgs(['x.json', '--min-cartridges', 'abc'])).toThrow(
      /Invalid numeric policy value/,
    );
  });

  it('reads discovery flags (--artifact-root / --driver-kind-prefix / --limit / --include-legacy)', () => {
    const args = parseCliArgs([
      '--artifact-root',
      '/tmp/playtest',
      '--driver-kind-prefix',
      'custom-prefix',
      '--limit',
      '3',
      '--include-legacy',
    ]);
    expect(args.artifactPaths).toEqual([]);
    expect(args.artifactRoot).toBe('/tmp/playtest');
    expect(args.driverKindPrefix).toBe('custom-prefix');
    expect(args.limit).toBe(3);
    expect(args.includeLegacy).toBe(true);
  });

  it('accepts --artifact-root without explicit paths', () => {
    // No path / no positional but a root is enough — the previous
    // contract required at least one explicit path.
    const args = parseCliArgs(['--artifact-root', '/tmp/playtest']);
    expect(args.artifactPaths).toEqual([]);
    expect(args.artifactRoot).toBe('/tmp/playtest');
  });

  it('rejects --limit values that are not positive integers', () => {
    expect(() => parseCliArgs(['--artifact-root', '/tmp', '--limit', '0'])).toThrow(
      /Invalid --limit value/,
    );
    // Node `parseArgs` requires the `=` form for dash-prefixed values
    // so the validator below it sees the literal "-2".
    expect(() => parseCliArgs(['--artifact-root', '/tmp', '--limit=-2'])).toThrow(
      /Invalid --limit value/,
    );
    expect(() => parseCliArgs(['--artifact-root', '/tmp', '--limit', '2.5'])).toThrow(
      /Invalid --limit value/,
    );
    expect(() => parseCliArgs(['--artifact-root', '/tmp', '--limit', 'abc'])).toThrow(
      /Invalid --limit value/,
    );
  });
});

describe('loadDriverSummaryArtifact', () => {
  it('reads and parses a driver-summary.json file', async () => {
    const root = await makeTmpDir();
    const file = path.join(root, 'driver-summary.json');
    await writeFile(
      file,
      JSON.stringify({
        new_inspected_events: 8,
        new_phase3_total: 0,
        cartridges_attempted: ['packaged'],
      }),
    );
    const loaded = loadDriverSummaryArtifact(file);
    expect(loaded.new_inspected_events).toBe(8);
    expect(loaded.cartridges_attempted).toEqual(['packaged']);
  });

  it('throws when the artifact path is not a file', async () => {
    const root = await makeTmpDir();
    expect(() => loadDriverSummaryArtifact(root)).toThrow(/not a file/);
  });

  it('throws when the artifact is not a JSON object', async () => {
    const root = await makeTmpDir();
    const file = path.join(root, 'driver-summary.json');
    await writeFile(file, '"not an object"');
    expect(() => loadDriverSummaryArtifact(file)).toThrow(
      /not a JSON object/,
    );
  });

  it('strips a UTF-8 BOM written by PowerShell so JSON.parse succeeds', async () => {
    const root = await makeTmpDir();
    const file = path.join(root, 'driver-summary.json');
    const body = '{"new_inspected_events":2}';
    await writeFile(file, `﻿${body}`);
    const loaded = loadDriverSummaryArtifact(file);
    expect(loaded.new_inspected_events).toBe(2);
  });
});

describe('resolveEffectivePolicy', () => {
  it('uses CLI overrides when supplied', () => {
    const policy = resolveEffectivePolicy([], {
      min_inspected_events: 16,
      min_languages: 3,
      min_cartridges: 5,
      min_model_families: 4,
    });
    expect(policy).toEqual({
      min_inspected_events: 16,
      min_languages: 3,
      min_cartridges: 5,
      min_model_families: 4,
    });
  });

  it('falls back to the most-conservative axis recorded in artifacts when no override', () => {
    const policy = resolveEffectivePolicy(
      [
        {policy: {min_inspected_events: 4, min_cartridges: 1}},
        {policy: {min_inspected_events: 12, min_cartridges: 3}},
      ],
      {
        min_inspected_events: null,
        min_languages: null,
        min_cartridges: null,
        min_model_families: null,
      },
    );
    expect(policy.min_inspected_events).toBe(12);
    expect(policy.min_cartridges).toBe(3);
    // Axes not recorded by any artifact stay at module defaults.
    expect(policy.min_languages).toBe(
      DEFAULT_DELETION_READINESS_POLICY.min_languages,
    );
    expect(policy.min_model_families).toBe(
      DEFAULT_DELETION_READINESS_POLICY.min_model_families,
    );
  });

  it('uses module defaults when no artifacts and no overrides', () => {
    const policy = resolveEffectivePolicy([], {
      min_inspected_events: null,
      min_languages: null,
      min_cartridges: null,
      min_model_families: null,
    });
    expect(policy).toEqual(DEFAULT_DELETION_READINESS_POLICY);
  });
});

describe('discoverArtifactsFromRoot', () => {
  it('finds driver-summary.json in each child dir and filters by driver_kind prefix', async () => {
    const root = await makeTmpDir();
    await writeArtifact(root, 'n2-phase3-soak-20260517T010000Z', {
      driver_kind: 'n2-phase3-soak',
      driver_end_iso: '2026-05-17T01:05:00.000Z',
      cartridge_source: 'world_overview',
      model_family_source: 'session_state',
      cartridges_attempted: ['grinhaven-full'],
      model_families_attempted: ['deepseek'],
    });
    await writeArtifact(root, 'unrelated-driver-20260517T020000Z', {
      driver_kind: 'unrelated-driver',
      driver_end_iso: '2026-05-17T02:00:00.000Z',
      cartridge_source: 'manual',
      model_family_source: 'manual',
    });
    const result = discoverArtifactsFromRoot(root, {
      driverKindPrefix: 'n2-phase3',
      limit: 10,
      includeLegacy: false,
    });
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.summary.driver_kind).toBe('n2-phase3-soak');
    expect(result.skipped).toEqual([]);
  });

  it('sorts newest-first by driver_end_iso and applies --limit', async () => {
    const root = await makeTmpDir();
    await writeArtifact(root, 'n2-phase3-a-20260517T010000Z', {
      driver_kind: 'n2-phase3-a',
      driver_end_iso: '2026-05-17T01:00:00.000Z',
      cartridge_source: 'world_overview',
      model_family_source: 'session_state',
    });
    await writeArtifact(root, 'n2-phase3-b-20260517T030000Z', {
      driver_kind: 'n2-phase3-b',
      driver_end_iso: '2026-05-17T03:00:00.000Z',
      cartridge_source: 'world_overview',
      model_family_source: 'session_state',
    });
    await writeArtifact(root, 'n2-phase3-c-20260517T020000Z', {
      driver_kind: 'n2-phase3-c',
      driver_end_iso: '2026-05-17T02:00:00.000Z',
      cartridge_source: 'world_overview',
      model_family_source: 'session_state',
    });
    const result = discoverArtifactsFromRoot(root, {
      driverKindPrefix: 'n2-phase3',
      limit: 2,
      includeLegacy: false,
    });
    expect(result.discovered).toHaveLength(2);
    expect(result.discovered.map((d) => d.summary.driver_kind)).toEqual([
      'n2-phase3-b',
      'n2-phase3-c',
    ]);
  });

  it('falls back to directory-name ordering when driver_end_iso is absent', async () => {
    const root = await makeTmpDir();
    await writeArtifact(root, 'n2-phase3-a-20260101T000000Z', {
      driver_kind: 'n2-phase3-a',
      cartridge_source: 'world_overview',
      model_family_source: 'session_state',
    });
    await writeArtifact(root, 'n2-phase3-b-20260501T000000Z', {
      driver_kind: 'n2-phase3-b',
      cartridge_source: 'world_overview',
      model_family_source: 'session_state',
    });
    const result = discoverArtifactsFromRoot(root, {
      driverKindPrefix: 'n2-phase3',
      limit: 10,
      includeLegacy: false,
    });
    expect(result.discovered.map((d) => d.summary.driver_kind)).toEqual([
      'n2-phase3-b',
      'n2-phase3-a',
    ]);
  });

  it('skips legacy summaries missing provenance fields with reason "missing_provenance"', async () => {
    const root = await makeTmpDir();
    const newPath = await writeArtifact(root, 'n2-phase3-new-20260517T030000Z', {
      driver_kind: 'n2-phase3-new',
      driver_end_iso: '2026-05-17T03:00:00.000Z',
      cartridge_source: 'world_overview',
      model_family_source: 'session_state',
    });
    const legacyPath = await writeArtifact(
      root,
      'n2-phase3-legacy-20260101T000000Z',
      {
        driver_kind: 'n2-phase3-legacy',
        driver_end_iso: '2026-01-01T00:00:00.000Z',
        cartridges_attempted: ['packaged'],
        // NO cartridge_source / model_family_source — pre-provenance
        // artifact that must NOT silently inflate the diversity gate.
      },
    );
    const result = discoverArtifactsFromRoot(root, {
      driverKindPrefix: 'n2-phase3',
      limit: 10,
      includeLegacy: false,
    });
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.path).toBe(newPath);
    expect(result.skipped).toEqual([
      {path: legacyPath, reason: 'missing_provenance'},
    ]);
  });

  it('includes legacy summaries when --include-legacy is opted in', async () => {
    const root = await makeTmpDir();
    await writeArtifact(root, 'n2-phase3-legacy-20260101T000000Z', {
      driver_kind: 'n2-phase3-legacy',
      driver_end_iso: '2026-01-01T00:00:00.000Z',
      cartridges_attempted: ['packaged'],
    });
    const result = discoverArtifactsFromRoot(root, {
      driverKindPrefix: 'n2-phase3',
      limit: 10,
      includeLegacy: true,
    });
    expect(result.discovered).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it('drops candidates whose driver_kind is missing or non-string', async () => {
    const root = await makeTmpDir();
    await writeArtifact(root, 'no-driver-kind-20260517T010000Z', {
      cartridge_source: 'manual',
      model_family_source: 'manual',
    });
    await writeArtifact(root, 'numeric-driver-kind-20260517T020000Z', {
      driver_kind: 12 as unknown as string,
      cartridge_source: 'manual',
      model_family_source: 'manual',
    });
    const result = discoverArtifactsFromRoot(root, {
      driverKindPrefix: 'n2-phase3',
      limit: 10,
      includeLegacy: false,
    });
    expect(result.discovered).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('throws when the artifact root is not a directory', async () => {
    const root = await makeTmpDir();
    const file = path.join(root, 'driver-summary.json');
    await writeFile(file, '{}');
    expect(() =>
      discoverArtifactsFromRoot(file, {
        driverKindPrefix: 'n2-phase3',
        limit: 10,
        includeLegacy: false,
      }),
    ).toThrow(/not a directory/);
  });
});

describe('buildArtifactEvidence', () => {
  it('extracts all provenance fields and falls back to null for absent ones', () => {
    const ev = buildArtifactEvidence('/abs/run/driver-summary.json', {
      driver_kind: 'n2-phase3-soak',
      driver_end_iso: '2026-05-17T05:41:55.000Z',
      cartridges_attempted: ['grinhaven-full'],
      cartridges_attempted_raw: ['grinhaven-full'],
      cartridge_source: 'world_overview',
      model_families_attempted: ['deepseek'],
      model_families_attempted_raw: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      model_family_source: 'session_state',
      local_soak_passed: true,
      ready_for_regex_deletion: false,
    });
    expect(ev).toEqual({
      path: '/abs/run/driver-summary.json',
      driver_kind: 'n2-phase3-soak',
      driver_end_iso: '2026-05-17T05:41:55.000Z',
      cartridges_attempted: ['grinhaven-full'],
      cartridges_attempted_raw: ['grinhaven-full'],
      cartridge_source: 'world_overview',
      model_families_attempted: ['deepseek'],
      model_families_attempted_raw: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      model_family_source: 'session_state',
      local_soak_passed: true,
      ready_for_regex_deletion: false,
    });
  });

  it('returns nulls for absent provenance fields without inventing data', () => {
    const ev = buildArtifactEvidence('/abs/legacy/driver-summary.json', {
      cartridges_attempted: ['packaged'],
      model_families_attempted: [],
    });
    expect(ev.cartridge_source).toBeNull();
    expect(ev.model_family_source).toBeNull();
    expect(ev.cartridges_attempted_raw).toBeNull();
    expect(ev.model_families_attempted_raw).toBeNull();
    expect(ev.local_soak_passed).toBeNull();
    expect(ev.ready_for_regex_deletion).toBeNull();
    expect(ev.driver_kind).toBeNull();
    expect(ev.driver_end_iso).toBeNull();
    expect(ev.cartridges_attempted).toEqual(['packaged']);
    expect(ev.model_families_attempted).toEqual([]);
  });
});

describe('summariseProvenance', () => {
  it('counts artifacts by cartridge/model_family source, with-provenance, and skipped', () => {
    const evidence = [
      buildArtifactEvidence('/a/driver-summary.json', {
        cartridge_source: 'world_overview',
        model_family_source: 'session_state',
      }),
      buildArtifactEvidence('/b/driver-summary.json', {
        cartridge_source: 'world_overview',
        model_family_source: 'manual',
      }),
      buildArtifactEvidence('/c/driver-summary.json', {
        cartridge_source: 'manual',
        model_family_source: 'session_state',
      }),
      buildArtifactEvidence('/d/driver-summary.json', {
        // Legacy explicit artifact (no provenance) intentionally
        // included via --artifact; should appear under 'absent'
        // counts and increment artifacts_missing_provenance.
        cartridges_attempted: ['packaged'],
      }),
    ];
    const summary = summariseProvenance(evidence, [
      {path: '/skipped/driver-summary.json', reason: 'missing_provenance'},
    ]);
    expect(summary).toEqual({
      cartridge_sources: {
        world_overview: 2,
        manual: 1,
        absent: 1,
      },
      model_family_sources: {
        session_state: 2,
        manual: 1,
        absent: 1,
      },
      artifacts_with_provenance: 3,
      artifacts_missing_provenance: 1,
      skipped_artifact_count: 1,
    });
  });

  it('returns zero counts and empty maps when there is no evidence', () => {
    const summary = summariseProvenance([], []);
    expect(summary).toEqual({
      cartridge_sources: {},
      model_family_sources: {},
      artifacts_with_provenance: 0,
      artifacts_missing_provenance: 0,
      skipped_artifact_count: 0,
    });
  });
});
