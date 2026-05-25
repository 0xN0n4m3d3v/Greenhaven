/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OBSIDIAN-VAULT-IMPORT-2 (2026-05-18) — read the four generated OWV
// runtime bridge artifacts from a Forge project's `audit/` directory
// and shape them into the v1 meta documents the runtime bridge
// services consume.
//
// The bridge artifact set per project is:
//
//   audit/currency-rates.json            → forge_currency_bridge
//   audit/merchant-contracts.jsonl       → forge_merchant_contracts
//   audit/materializes.jsonl             → forge_materializer_bridge
//   audit/scene-instructions.jsonl       → forge_scene_instructions
//
// Missing or empty files yield an *empty v1 document* (a tombstone)
// rather than an absent record. The apply pipeline writes the
// tombstone into `cartridge_meta_scoped` so a reimport that drops an
// artifact cannot silently fall through to legacy global
// `cartridge_meta` left over from an earlier global-only install.

import {readFile} from 'node:fs/promises';
import path from 'node:path';

export const CURRENCY_SCHEMA_VERSION = 'greenhaven.currency_rates.v1';
export const MERCHANT_SCHEMA_VERSION = 'greenhaven.merchant_contracts.v1';
export const MATERIALIZER_SCHEMA_VERSION = 'greenhaven.materializers.v1';
export const SCENE_INSTRUCTIONS_SCHEMA_VERSION = 'greenhaven.scene_instructions.v1';

export const CURRENCY_META_KEY = 'forge_currency_bridge';
export const MERCHANT_META_KEY = 'forge_merchant_contracts';
export const MATERIALIZER_META_KEY = 'forge_materializer_bridge';
export const SCENE_INSTRUCTIONS_META_KEY = 'forge_scene_instructions';

export interface ForgeBridgeArtifacts {
  currency: Record<string, unknown>;
  merchant: Record<string, unknown>;
  materializer: Record<string, unknown>;
  sceneInstructions: Record<string, unknown>;
  /** True when the source path is a valid Forge project on disk.
   *  When false, every bridge document is the empty tombstone. */
  sourcePresent: boolean;
}

export interface LoadOptions {
  /** Forge project root (must contain an `audit/` directory). */
  sourcePath: string;
  /** Optional override stamped onto the meta documents for telemetry
   *  / merge-conflict diagnostics. Defaults to the path stem. */
  sourceProject?: string;
}

interface RawJsonl<T> {
  rows: T[];
}

async function safeReadFile(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return null;
  }
}

function parseJsonl<T = unknown>(raw: string | null): RawJsonl<T> {
  if (!raw) return {rows: []};
  const rows: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object') rows.push(value as T);
    } catch {
      // skip malformed line — the compiler is the canonical writer,
      // and we'd rather drop one bad row than fail the whole apply.
    }
  }
  return {rows};
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Falls through to null; caller surfaces an empty tombstone.
  }
  return null;
}

function emptyCurrency(sourceProject: string): Record<string, unknown> {
  return {
    schema_version: CURRENCY_SCHEMA_VERSION,
    source_project: sourceProject,
    coins: [],
    world_currency_facts: [],
  };
}

function emptyMerchant(sourceProject: string): Record<string, unknown> {
  return {
    schema_version: MERCHANT_SCHEMA_VERSION,
    source_project: sourceProject,
    offers: [],
  };
}

function emptyMaterializer(sourceProject: string): Record<string, unknown> {
  return {
    schema_version: MATERIALIZER_SCHEMA_VERSION,
    source_project: sourceProject,
    rows: [],
  };
}

function emptyScene(sourceProject: string): Record<string, unknown> {
  return {
    schema_version: SCENE_INSTRUCTIONS_SCHEMA_VERSION,
    source_project: sourceProject,
    rows: [],
  };
}

/** Return tombstone v1 documents for every bridge. Apply uses this
 *  when the source path is unknown / unreadable so reimport never
 *  leaves stale scoped rows attached to the cartridge. */
export function tombstoneBridgeArtifacts(
  sourceProject: string = 'unknown',
): ForgeBridgeArtifacts {
  return {
    currency: emptyCurrency(sourceProject),
    merchant: emptyMerchant(sourceProject),
    materializer: emptyMaterializer(sourceProject),
    sceneInstructions: emptyScene(sourceProject),
    sourcePresent: false,
  };
}

/** Load all four bridge artifacts from a Forge project on disk.
 *  Missing files are silently treated as empty tombstones so the
 *  apply pipeline can write valid scoped meta even when the writer
 *  has not authored that bridge surface yet. */
export async function loadForgeBridgeArtifacts(
  opts: LoadOptions,
): Promise<ForgeBridgeArtifacts> {
  const sourceProject =
    opts.sourceProject?.trim().length
      ? opts.sourceProject.trim()
      : path.basename(opts.sourcePath || 'unknown') || 'unknown';
  const auditDir = path.join(opts.sourcePath, 'audit');

  const [currencyRaw, merchantRaw, materializerRaw, sceneRaw] = await Promise.all([
    safeReadFile(path.join(auditDir, 'currency-rates.json')),
    safeReadFile(path.join(auditDir, 'merchant-contracts.jsonl')),
    safeReadFile(path.join(auditDir, 'materializes.jsonl')),
    safeReadFile(path.join(auditDir, 'scene-instructions.jsonl')),
  ]);

  const currencyJson = parseJson(currencyRaw);
  const currency: Record<string, unknown> = currencyJson
    ? {
        schema_version: CURRENCY_SCHEMA_VERSION,
        source_project: sourceProject,
        coins: Array.isArray(currencyJson.coins) ? currencyJson.coins : [],
        world_currency_facts: Array.isArray(currencyJson.world_currency_facts)
          ? currencyJson.world_currency_facts
          : [],
      }
    : emptyCurrency(sourceProject);

  const merchantParsed = parseJsonl(merchantRaw);
  const merchant: Record<string, unknown> = {
    schema_version: MERCHANT_SCHEMA_VERSION,
    source_project: sourceProject,
    offers: merchantParsed.rows,
  };

  const materializerParsed = parseJsonl(materializerRaw);
  const materializer: Record<string, unknown> = {
    schema_version: MATERIALIZER_SCHEMA_VERSION,
    source_project: sourceProject,
    rows: materializerParsed.rows,
  };

  const sceneParsed = parseJsonl(sceneRaw);
  const sceneInstructions: Record<string, unknown> = {
    schema_version: SCENE_INSTRUCTIONS_SCHEMA_VERSION,
    source_project: sourceProject,
    rows: sceneParsed.rows,
  };

  // `sourcePresent` is true if at least one artifact file was on disk;
  // the apply pipeline still writes all four scoped rows in any case
  // so a reimport that removes a single artifact replaces it with the
  // tombstone shape rather than leaving a stale scoped value.
  const sourcePresent =
    currencyRaw !== null ||
    merchantRaw !== null ||
    materializerRaw !== null ||
    sceneRaw !== null;

  return {
    currency,
    merchant,
    materializer,
    sceneInstructions,
    sourcePresent,
  };
}

export interface ScopedBridgeWritePlan {
  key: string;
  value: Record<string, unknown>;
  description: string;
}

/** Build the four scoped-write rows the apply transaction commits.
 *  Order matches the bridge service file order for consistent
 *  telemetry / regression reads. */
export function buildScopedBridgeWritePlan(
  artifacts: ForgeBridgeArtifacts,
): ScopedBridgeWritePlan[] {
  return [
    {
      key: CURRENCY_META_KEY,
      value: artifacts.currency,
      description:
        'OBSIDIAN-VAULT-IMPORT-2 — scoped currency rates bridge (v1) loaded from audit/currency-rates.json.',
    },
    {
      key: MERCHANT_META_KEY,
      value: artifacts.merchant,
      description:
        'OBSIDIAN-VAULT-IMPORT-2 — scoped merchant contracts bridge (v1) loaded from audit/merchant-contracts.jsonl.',
    },
    {
      key: MATERIALIZER_META_KEY,
      value: artifacts.materializer,
      description:
        'OBSIDIAN-VAULT-IMPORT-2 — scoped materializer bridge (v1) loaded from audit/materializes.jsonl.',
    },
    {
      key: SCENE_INSTRUCTIONS_META_KEY,
      value: artifacts.sceneInstructions,
      description:
        'OBSIDIAN-VAULT-IMPORT-2 — scoped scene-instructions bridge (v1) loaded from audit/scene-instructions.jsonl.',
    },
  ];
}
