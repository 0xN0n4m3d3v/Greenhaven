/**
 * Focused tests for the OWV-17 merchant-contracts runtime bridge.
 *
 *   • `loadProject` parses the optional `audit/merchant-contracts.jsonl`
 *     into `LoadedProject.bridge.merchants`, mints stable per-line
 *     `offer_id`s, and tolerates a missing artifact;
 *   • `exportGrinhavenSql` emits a deterministic
 *     `forge_merchant_contracts` `cartridge_meta` row sorted by
 *     `(source_slug, copper_value, line)`, namespaced by the
 *     `project_slug`, and does not touch production keys;
 *   • projects without the artifact still export normally — no
 *     `forge_merchant_contracts` meta is written.
 */

import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {initProject, loadProject} from '../src/core/projectStore.js';
import {merchantOfferId} from '../src/core/projectStore.js';
import {exportGrinhavenSql} from '../src/exporters/exportGrinhavenSql.js';

async function seedProject(label: string): Promise<{slug: string; root: string}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `forge-merchant-${label}-`));
  process.env.CARTRIDGE_FORGE_PROJECTS = root;
  const slug = `merchant-${label}`;
  await initProject(slug);
  return {slug, root};
}

async function writeMerchantArtifact(
  projectRoot: string,
  rows: object[],
): Promise<void> {
  const auditDir = path.join(projectRoot, 'audit');
  await mkdir(auditDir, {recursive: true});
  await writeFile(
    path.join(auditDir, 'merchant-contracts.jsonl'),
    rows.map(row => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
}

function liveOffers() {
  return [
    {
      source_slug: 'mikka',
      source_mention: '@Mikka',
      source_kind: 'person',
      source_path:
        'GreenHavenWorld/Locations/@City of Greenhaven/@Town square/npc/@Mikka/MikkaMind.md',
      line: 'городской слух без риска - 3 @Copper coin;',
      coins: [{coin: '@Copper coin', amount: 3}],
      copper_value: 3,
    },
    {
      source_slug: 'mikka',
      source_mention: '@Mikka',
      source_kind: 'person',
      source_path:
        'GreenHavenWorld/Locations/@City of Greenhaven/@Town square/npc/@Mikka/MikkaMind.md',
      line: 'адрес, имя или опасный приватный слух - 2 @Silver coin;',
      coins: [{coin: '@Silver coin', amount: 2}],
      copper_value: 20,
    },
  ];
}

describe('OWV-17 merchant-contracts bridge', () => {
  it('loadProject populates bridge.merchants when the audit artifact exists', async () => {
    const {slug} = await seedProject('load-present');
    const loaded = await loadProject(slug);
    await writeMerchantArtifact(loaded.root, liveOffers());
    const reloaded = await loadProject(slug);
    expect(reloaded.bridge.merchants).toBeDefined();
    expect(reloaded.bridge.merchants?.schema_version).toBe(
      'greenhaven.merchant_contracts.v1',
    );
    const offers = reloaded.bridge.merchants?.offers ?? [];
    expect(offers).toHaveLength(2);
    expect(offers[0]!.offer_id).toBe(
      merchantOfferId('mikka', 'городской слух без риска - 3 @Copper coin;'),
    );
    // Sorted ascending by copper_value then line within same merchant.
    expect(offers[0]!.copper_value).toBe(3);
    expect(offers[1]!.copper_value).toBe(20);
  });

  it('loadProject tolerates a missing artifact without crashing', async () => {
    const {slug} = await seedProject('load-missing');
    const loaded = await loadProject(slug);
    expect(loaded.bridge.merchants).toBeUndefined();
  });

  it('exportGrinhavenSql writes the forge_merchant_contracts meta row', async () => {
    const {slug, root} = await seedProject('sql');
    const seeded = await loadProject(slug);
    await writeMerchantArtifact(seeded.root, liveOffers());
    const reloaded = await loadProject(slug);
    const out = path.join(root, 'merchants.sql');
    const report = await exportGrinhavenSql(reloaded, out);
    expect(report.merchantOffers).toBe(2);
    const text = await readFile(out, 'utf8');
    expect(text).toContain("'forge_merchant_contracts'");
    expect(text).toContain('OWV-17 merchant offer contracts');
    expect(text).toContain(
      `"schema_version":"greenhaven.merchant_contracts.v1"`,
    );
    expect(text).toContain(`"source_project":"${slug}"`);
    expect(text).toContain('"source_slug":"mikka"');
    expect(text).toContain('"@Copper coin"');
    expect(text).toContain('"@Silver coin"');
    // Production keys must NOT be touched.
    expect(text).not.toContain("'currency_item_id'");
    expect(text).not.toContain("'starting_currency_count'");
  });

  it('exportGrinhavenSql is a no-op when the merchants artifact is absent', async () => {
    const {slug, root} = await seedProject('sql-empty');
    const loaded = await loadProject(slug);
    const out = path.join(root, 'no-merchants.sql');
    const report = await exportGrinhavenSql(loaded, out);
    expect(report.merchantOffers).toBe(0);
    const text = await readFile(out, 'utf8');
    expect(text).not.toContain('forge_merchant_contracts');
  });

  it('exportGrinhavenSql produces deterministic merchant SQL across re-runs', async () => {
    const {slug, root} = await seedProject('sql-stable');
    const seeded = await loadProject(slug);
    await writeMerchantArtifact(seeded.root, liveOffers());
    const reloaded = await loadProject(slug);
    const first = path.join(root, 'first.sql');
    const second = path.join(root, 'second.sql');
    await exportGrinhavenSql(reloaded, first);
    await exportGrinhavenSql(reloaded, second);
    const strip = (text: string) =>
      text
        .split('\n')
        .filter(line => !line.includes("'forge_last_sql_export'"))
        .filter(line => !line.includes('"exported_at"'))
        .join('\n');
    const a = strip(await readFile(first, 'utf8'));
    const b = strip(await readFile(second, 'utf8'));
    expect(a).toBe(b);
  });
});
