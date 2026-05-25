/**
 * Focused tests for the OWV-17 currency item-catalog runtime bridge.
 *
 * The Obsidian vault compiler writes `audit/currency-rates.json`
 * alongside the existing cartridge-forge-project artifacts. These
 * tests pin the cartridge-forge consumption contract:
 *
 *   • `loadProject` parses the optional artifact into
 *     `LoadedProject.bridge.currency`, leaves the field undefined
 *     when the file is missing or invalid, and never crashes a load;
 *   • `exportGrinhavenSql` emits idempotent `items` upserts using
 *     only the existing inventory schema (`category='currency'`,
 *     `stackable`, `max_stack`, `behaviour`, `legacy_entity_id`);
 *   • `legacy_entity_id` links to the matching entity row when the
 *     project already carries an item record for the coin slug;
 *   • the runtime `cartridge_meta` entry uses the namespaced
 *     `forge_currency_bridge` key and *does not* touch
 *     `currency_item_id` / `starting_currency_count` (production
 *     keys are out of scope for this slice);
 *   • the SQL emission is deterministic across re-runs.
 */

import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {addRecord, initProject, loadProject, makeRecord} from '../src/core/projectStore.js';
import {exportGrinhavenSql} from '../src/exporters/exportGrinhavenSql.js';

async function seedProject(label: string): Promise<{slug: string; root: string}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `forge-currency-${label}-`));
  process.env.CARTRIDGE_FORGE_PROJECTS = root;
  const slug = `currency-${label}`;
  await initProject(slug);
  return {slug, root};
}

async function writeCurrencyArtifact(
  projectRoot: string,
  body: object,
): Promise<void> {
  const auditDir = path.join(projectRoot, 'audit');
  await mkdir(auditDir, {recursive: true});
  await writeFile(
    path.join(auditDir, 'currency-rates.json'),
    `${JSON.stringify(body, null, 2)}\n`,
    'utf8',
  );
}

function liveBridge() {
  return {
    schema_version: 'greenhaven.currency_rates.v1',
    source_project: 'greenhaven-obsidian-world',
    coins: [
      {
        slug: 'gold-coin',
        mention: '@Gold coin',
        copper_value: 100,
        source_path: 'GreenHavenWorld/Economy/items/@Gold coin/GoldCoinMind.md',
      },
      {
        slug: 'silver-coin',
        mention: '@Silver coin',
        copper_value: 10,
        source_path: 'GreenHavenWorld/Economy/items/@Silver coin/SilverCoinMind.md',
      },
      {
        slug: 'copper-coin',
        mention: '@Copper coin',
        copper_value: 1,
        source_path: 'GreenHavenWorld/Economy/items/@Copper coin/CopperCoinMind.md',
      },
    ],
    world_currency_facts: [],
  };
}

describe('OWV-17 currency item-catalog bridge', () => {
  it('loadProject populates bridge.currency when the audit artifact exists', async () => {
    const {slug} = await seedProject('load-present');
    const loaded = await loadProject(slug);
    await writeCurrencyArtifact(loaded.root, liveBridge());
    const reloaded = await loadProject(slug);
    expect(reloaded.bridge).toBeDefined();
    expect(reloaded.bridge.currency?.schema_version).toBe('greenhaven.currency_rates.v1');
    expect(reloaded.bridge.currency?.coins.map(coin => coin.slug)).toEqual([
      'gold-coin',
      'silver-coin',
      'copper-coin',
    ]);
  });

  it('loadProject tolerates a missing artifact without crashing', async () => {
    const {slug} = await seedProject('load-missing');
    const loaded = await loadProject(slug);
    expect(loaded.bridge).toEqual({});
    expect(loaded.bridge.currency).toBeUndefined();
  });

  it('loadProject ignores an artifact with a wrong schema_version', async () => {
    const {slug} = await seedProject('load-wrong-schema');
    const seeded = await loadProject(slug);
    await writeCurrencyArtifact(seeded.root, {
      schema_version: 'greenhaven.currency_rates.v2',
      source_project: 'x',
      coins: [],
      world_currency_facts: [],
    });
    const reloaded = await loadProject(slug);
    expect(reloaded.bridge.currency).toBeUndefined();
  });

  it('exportGrinhavenSql emits idempotent currency items + forge_currency_bridge meta', async () => {
    const {slug, root} = await seedProject('sql-items');
    const seeded = await loadProject(slug);
    await writeCurrencyArtifact(seeded.root, liveBridge());
    const loaded = await loadProject(slug);
    const out = path.join(root, 'currency.sql');
    const report = await exportGrinhavenSql(loaded, out);
    expect(report.currencyItems).toBe(3);
    const text = await readFile(out, 'utf8');
    expect(text).toContain(
      'INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id) VALUES',
    );
    expect(text).toContain("'copper-coin', 'currency'");
    expect(text).toContain("'silver-coin', 'currency'");
    expect(text).toContain("'gold-coin', 'currency'");
    // Static currency schema: stackable, max_stack 9999, idempotent.
    expect(text).toContain('9999');
    expect(text).toContain('ON CONFLICT (slug) DO UPDATE SET');
    expect(text).toContain(
      'legacy_entity_id = COALESCE(items.legacy_entity_id, EXCLUDED.legacy_entity_id);',
    );
    // Namespaced cartridge_meta bridge document.
    expect(text).toContain("'forge_currency_bridge'");
    expect(text).toContain('OWV-17 currency item-catalog bridge');
    // Production keys must NOT be touched in this slice.
    expect(text).not.toContain("'currency_item_id'");
    expect(text).not.toContain("'starting_currency_count'");
    // No bridge.currency → no items block. Behaviour blob carries the
    // provenance the runtime importer needs.
    expect(text).toContain('"bridge":"greenhaven.currency_rates.v1"');
    expect(text).toContain('"canonical_mention":"@Copper coin"');
  });

  it('exportGrinhavenSql links legacy_entity_id when an item record already exists', async () => {
    const {slug, root} = await seedProject('sql-link');
    const seeded = await loadProject(slug);
    await writeCurrencyArtifact(seeded.root, liveBridge());
    // The Forge project already has an authored item record for one
    // of the coins. The exporter must link the new items row to the
    // entity id it allocates for that record.
    await addRecord(
      seeded.root,
      makeRecord({
        kind: 'item',
        slug: 'copper-coin',
        name: 'Copper coin',
        summary: 'A small copper coin.',
        tags: ['item', 'currency'],
        payload: {item_kind: 'currency'},
      }),
    );
    const loaded = await loadProject(slug);
    const copperRecord = loaded.records.find(record => record.slug === 'copper-coin');
    expect(copperRecord).toBeDefined();
    const out = path.join(root, 'currency-link.sql');
    await exportGrinhavenSql(loaded, out);
    const text = await readFile(out, 'utf8');
    // The exported items row for copper-coin must reference the same
    // entity id the entities INSERT used. Pull the legacy_entity_id
    // off the items row, then assert an entities row with the same
    // id + `'item'` kind exists earlier in the same file.
    const itemRow = text
      .split('\n')
      .find(line => line.includes("'copper-coin', 'currency'"));
    expect(itemRow).toBeDefined();
    const itemEntityIdMatch = itemRow!.match(/,\s*(\d+|NULL)\),?$/);
    expect(itemEntityIdMatch).not.toBeNull();
    const entityId = itemEntityIdMatch![1];
    expect(entityId).not.toBe('NULL');
    const entitiesRow = text
      .split('\n')
      .find(line => line.startsWith(`(${entityId}, 'item',`));
    expect(entitiesRow).toBeDefined();
    expect(entitiesRow).toContain('"source_slug":"copper-coin"');
  });

  it('exportGrinhavenSql is a no-op for projects without a currency artifact', async () => {
    const {slug, root} = await seedProject('sql-empty');
    const loaded = await loadProject(slug);
    const out = path.join(root, 'no-currency.sql');
    const report = await exportGrinhavenSql(loaded, out);
    expect(report.currencyItems).toBe(0);
    const text = await readFile(out, 'utf8');
    expect(text).toContain('-- No currency bridge items.');
    expect(text).not.toContain('forge_currency_bridge');
    expect(text).not.toContain('INSERT INTO items');
  });

  it('exportGrinhavenSql produces deterministic SQL across repeated runs', async () => {
    const {slug, root} = await seedProject('sql-stable');
    const seeded = await loadProject(slug);
    await writeCurrencyArtifact(seeded.root, liveBridge());
    const loaded = await loadProject(slug);
    const first = path.join(root, 'first.sql');
    const second = path.join(root, 'second.sql');
    await exportGrinhavenSql(loaded, first);
    await exportGrinhavenSql(loaded, second);
    const a = await readFile(first, 'utf8');
    const b = await readFile(second, 'utf8');
    // The `exported_at` ISO timestamp in `forge_last_sql_export`
    // changes per run; everything else must be byte-identical. Strip
    // the timestamp by removing the `forge_last_sql_export` row.
    const strip = (text: string) =>
      text
        .split('\n')
        .filter(line => !line.includes("'forge_last_sql_export'"))
        .filter(line => !line.includes('"exported_at"'))
        .join('\n');
    expect(strip(a)).toBe(strip(b));
  });
});
