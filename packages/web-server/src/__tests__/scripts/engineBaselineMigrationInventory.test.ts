/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-1 — coverage test for
// `docs/db/engine-baseline-migration-inventory.md`.
//
// Fails CI if any `packages/web-server/migrations/*.sql` file is missing
// from the inventory, if any inventory row references a file that no
// longer exists, or if any classification is not one of the five
// allowed values. This catches new migrations whose author forgot to
// extend the inventory.

import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// FEAT-ENGINE-BASELINE-3 — the prebaseline migrations the inventory
// covers were moved under `migrations/archive-prebaseline/`. The
// coverage check follows them.
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'migrations',
  'archive-prebaseline',
);
const INVENTORY_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'db',
  'engine-baseline-migration-inventory.md',
);

const ALLOWED_CLASSIFICATIONS = new Set([
  'engine_schema',
  'engine_system_seed',
  'cartridge_world_content',
  'dev_repair_audit',
  'obsolete_compatibility',
]);

const ALLOWED_CUTOVER_ACTIONS = new Set([
  'keep_in_baseline',
  'keep_schema_drop_seed',
  'move_to_cartridge_install',
  'archive',
]);

interface InventoryRow {
  filename: string;
  classification: string;
  cutoverAction: string;
}

async function listMigrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

function parseInventoryTable(markdown: string): InventoryRow[] {
  const rows: InventoryRow[] = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| `0')) continue;
    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const fileCell = cells[0]?.replace(/`/g, '').trim() ?? '';
    const classification = cells[1] ?? '';
    const cutoverAction = cells[5] ?? '';
    if (!fileCell.endsWith('.sql')) continue;
    rows.push({filename: fileCell, classification, cutoverAction});
  }
  return rows;
}

describe('engine-baseline migration inventory', () => {
  it('covers every .sql migration with exactly one row', async () => {
    const [files, raw] = await Promise.all([
      listMigrationFiles(),
      readFile(INVENTORY_PATH, 'utf8'),
    ]);
    const inventory = parseInventoryTable(raw);
    const inventoryFilenames = inventory.map((r) => r.filename).sort();

    const missingFromInventory = files.filter(
      (f) => !inventoryFilenames.includes(f),
    );
    const phantomInventoryRows = inventoryFilenames.filter(
      (f) => !files.includes(f),
    );

    expect(
      missingFromInventory,
      `migrations missing from inventory — add them to docs/db/engine-baseline-migration-inventory.md: ${missingFromInventory.join(', ')}`,
    ).toEqual([]);
    expect(
      phantomInventoryRows,
      `inventory rows reference missing .sql files: ${phantomInventoryRows.join(', ')}`,
    ).toEqual([]);

    const filenameCounts = new Map<string, number>();
    for (const row of inventory) {
      filenameCounts.set(
        row.filename,
        (filenameCounts.get(row.filename) ?? 0) + 1,
      );
    }
    const duplicates = [...filenameCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name);
    expect(
      duplicates,
      `duplicate inventory rows: ${duplicates.join(', ')}`,
    ).toEqual([]);

    expect(inventory.length).toBe(files.length);
  });

  it('every inventory row uses an allowed classification + cutover action', async () => {
    const raw = await readFile(INVENTORY_PATH, 'utf8');
    const inventory = parseInventoryTable(raw);
    const badClassifications = inventory.filter(
      (r) => !ALLOWED_CLASSIFICATIONS.has(r.classification),
    );
    const badActions = inventory.filter(
      (r) => !ALLOWED_CUTOVER_ACTIONS.has(r.cutoverAction),
    );
    expect(
      badClassifications.map((r) => `${r.filename}=${r.classification}`),
      'unknown classification values',
    ).toEqual([]);
    expect(
      badActions.map((r) => `${r.filename}=${r.cutoverAction}`),
      'unknown cutover_action values',
    ).toEqual([]);
  });

  it('declared category totals match the parsed table', async () => {
    const raw = await readFile(INVENTORY_PATH, 'utf8');
    const inventory = parseInventoryTable(raw);
    const actual: Record<string, number> = {
      engine_schema: 0,
      engine_system_seed: 0,
      cartridge_world_content: 0,
      dev_repair_audit: 0,
      obsolete_compatibility: 0,
    };
    for (const row of inventory) {
      actual[row.classification] = (actual[row.classification] ?? 0) + 1;
    }

    const declared = extractDeclaredTotals(raw);
    expect(actual).toEqual(declared);
  });
});

function extractDeclaredTotals(markdown: string): Record<string, number> {
  const totals: Record<string, number> = {};
  const patterns: Array<[string, RegExp]> = [
    [
      'engine_schema',
      /- `engine_schema`:\s+(\d+)\s+migrations?\b/i,
    ],
    [
      'engine_system_seed',
      /- `engine_system_seed`:\s+(\d+)\s+migrations?\b/i,
    ],
    [
      'cartridge_world_content',
      /- `cartridge_world_content`:\s+(\d+)\s+migrations?\b/i,
    ],
    [
      'dev_repair_audit',
      /- `dev_repair_audit`:\s+(\d+)\s+migrations?\b/i,
    ],
    [
      'obsolete_compatibility',
      /- `obsolete_compatibility`:\s+(\d+)\s+migrations?\b/i,
    ],
  ];
  for (const [key, regex] of patterns) {
    const m = markdown.match(regex);
    totals[key] = m && m[1] ? Number.parseInt(m[1], 10) : 0;
  }
  return totals;
}
