/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Test-bench grant script. Tops up the most-recently-active player
// (or a specific --player-id) with a bundle of testing resources:
//
//   - 1000 Gold Coin (item entity 300)
//   - 1000 Eris Coin (item entity 295001 — created by migration 0100)
//   - 2 enchanted blades (items 295010 Бритвоязычный клинок + 295011 Лунный шёлк)
//
// Usage:
//   tsx src/scripts/test-grant.ts [--player-id <id>]
//                                 [--pgdata <pglite_data_dir>]
//                                 [--gold N] [--eris N]
//                                 [--blades none|both]
//
// Close GreenHaven before running.

import { clearConfigEnv, setConfigEnv } from '../config.js';

const pgdataArg = (() => {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pgdata' && argv[i + 1]) return argv[i + 1];
    const eq = argv[i]?.match(/^--pgdata=(.+)$/);
    if (eq) return eq[1];
  }
  return null;
})();
if (pgdataArg) {
  clearConfigEnv('DATABASE_URL');
  setConfigEnv('PGLITE_DATA_DIR', pgdataArg);
}

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'player-id': { type: 'string' },
    pgdata: { type: 'string' },
    gold: { type: 'string' },
    eris: { type: 'string' },
    blades: { type: 'string' },
  },
  allowPositionals: false,
});

const goldCount = Number(values.gold ?? '1000');
const erisCount = Number(values.eris ?? '1000');
const bladesMode = String(values.blades ?? 'both');

const { query } = await import('../db.js');

async function main(): Promise<void> {
  let playerId: number | null = values['player-id']
    ? Number(values['player-id'])
    : null;
  if (playerId == null) {
    const r = await query<{ entity_id: number }>(
      `SELECT entity_id FROM players ORDER BY entity_id DESC LIMIT 1`,
    );
    playerId = r.rows[0]?.entity_id ?? null;
  }
  if (playerId == null) {
    throw new Error(
      'No player found in DB. Launch GreenHaven once to create a character, then re-run this script.',
    );
  }

  const player = await query<{ display_name: string }>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [playerId],
  );
  const name = player.rows[0]?.display_name ?? `player ${playerId}`;
  console.log(`[test-grant] target: ${name} (entity_id=${playerId})`);

  // Ensure items exist (migration 0100 should have created them, but
  // guard against a partial migration state).
  const required: Array<{ id: number; label: string }> = [
    { id: 300, label: 'Gold Coin' },
    { id: 295001, label: 'Eris Coin' },
    { id: 295010, label: 'Бритвоязычный клинок' },
    { id: 295011, label: 'Лунный шёлк' },
  ];
  for (const it of required) {
    const r = await query<{ id: number }>(
      `SELECT id FROM entities WHERE id = $1`,
      [it.id],
    );
    if (r.rows.length === 0) {
      throw new Error(
        `Item entity ${it.id} (${it.label}) not found. Migration 0100 may not have been applied — launch GreenHaven once to run pending migrations, then close the app and re-run this script.`,
      );
    }
  }

  // Top up inventory_entries (counts source-of-truth).
  await upsert(playerId, 300, goldCount, 'Gold Coin');
  await upsert(playerId, 295001, erisCount, 'Eris Coin');
  if (bladesMode === 'both') {
    await upsert(playerId, 295010, 1, 'Бритвоязычный клинок');
    await upsert(playerId, 295011, 1, 'Лунный шёлк');
  }

  // Mirror into player_inventory (structured-meta lens used by UI HUD).
  await upsertPlayerInventory(playerId, 'gold_coin', goldCount);
  await upsertPlayerInventory(playerId, 'eris_coin', erisCount);
  if (bladesMode === 'both') {
    await upsertPlayerInventory(playerId, 'razortongue_blade', 1);
    await upsertPlayerInventory(playerId, 'moon_silk_blade', 1);
  }

  console.log('[test-grant] done.');
}

async function upsertPlayerInventory(
  playerId: number,
  slug: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const item = await query<{ id: number }>(
    `SELECT id FROM items WHERE slug = $1`,
    [slug],
  );
  const itemId = item.rows[0]?.id;
  if (itemId == null) {
    console.warn(
      `  ! items.${slug} not found — skipping player_inventory mirror`,
    );
    return;
  }
  const existing = await query<{ id: number; quantity: number }>(
    `SELECT id, quantity FROM player_inventory
      WHERE player_id = $1 AND item_id = $2 AND equipped = false
      ORDER BY quantity DESC LIMIT 1`,
    [playerId, itemId],
  );
  if (existing.rows.length === 0) {
    await query(
      `INSERT INTO player_inventory (player_id, item_id, quantity, equipped, meta)
       VALUES ($1, $2, $3, false, $4::jsonb)`,
      [playerId, itemId, count, JSON.stringify({ source: 'test_grant' })],
    );
    console.log(`  + player_inventory ${slug}: new row qty=${count}`);
    return;
  }
  const have = existing.rows[0]!;
  if (have.quantity >= count) {
    console.log(
      `  = player_inventory ${slug}: keep qty=${have.quantity} (≥${count})`,
    );
    return;
  }
  await query(`UPDATE player_inventory SET quantity = $1 WHERE id = $2`, [
    count,
    have.id,
  ]);
  console.log(
    `  + player_inventory ${slug}: bumped ${have.quantity} → ${count}`,
  );
}

async function upsert(
  holderId: number,
  itemId: number,
  count: number,
  label: string,
): Promise<void> {
  if (count <= 0) return;
  const r = await query<{ count: number }>(
    `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (holder_entity_id, item_entity_id)
     DO UPDATE SET count = GREATEST(inventory_entries.count, EXCLUDED.count),
                   metadata = COALESCE(inventory_entries.metadata, '{}'::jsonb)
                           || EXCLUDED.metadata
     RETURNING count`,
    [
      holderId,
      itemId,
      count,
      JSON.stringify({
        source: 'test_grant',
        granted_at: new Date().toISOString(),
      }),
    ],
  );
  console.log(
    `  + ${label}: now ${r.rows[0]?.count ?? '?'} (target ≥${count})`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      '[test-grant] ERROR:',
      err instanceof Error ? err.message : err,
    );
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
