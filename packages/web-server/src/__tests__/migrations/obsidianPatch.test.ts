import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'migrations',
  'archive-prebaseline',
);
const PATCH = '0117_obsidian_world_patch.sql';
const PATCH_V2 = '0122_obsidian_world_patch_v2.sql';
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, {recursive: true, force: true})));
});

describe('0117 Obsidian world patch smoke', () => {
  it('applies quickly on the runtime schema subset and remains idempotent', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, PATCH), 'utf8');
    expect(sql).not.toContain('rebuild_local_density(');
    expect(sql).toContain('"local_density_summary"');
    expect(sql).toContain('"transitive_density_summary"');

    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'greenhaven-0117-smoke-'));
    tempDirs.push(dataDir);
    const db = await PGlite.create(dataDir);
    try {
      await createHostSchema(db);
      await applyPatch(db, sql);
      await applyPatch(db, sql);

      const counts = await db.query<{kind: string; count: number}>(`
        SELECT kind, COUNT(*)::int AS count
          FROM entities
         GROUP BY kind
         ORDER BY kind
      `);
      expect(Object.fromEntries(counts.rows.map(row => [row.kind, Number(row.count)]))).toEqual({
        item: 11,
        location: 3,
        person: 2,
        quest: 4,
        scene: 13,
        world_fact: 1,
      });

      const runtimeTypes = await db.query<{value_type: string; count: number}>(`
        SELECT value_type, COUNT(*)::int AS count
          FROM runtime_fields
         GROUP BY value_type
         ORDER BY value_type
      `);
      expect(runtimeTypes.rows).toEqual([{value_type: 'bool', count: 13}]);

      const start = await db.query<{value: unknown}>(`
        SELECT value
          FROM cartridge_meta
         WHERE key = 'starting_location_id'
      `);
      expect(start.rows[0]?.value).toBe(904983);

      const city = await db.query<{
        id: number;
        child_location_count: number;
        npc_count: number;
        scene_count: number;
        quest_count: number;
        descendant_location_count: number;
      }>(`
        SELECT id,
               (profile->'local_density_summary'->>'child_location_count')::int AS child_location_count,
               (profile->'transitive_density_summary'->>'npc_count')::int AS npc_count,
               (profile->'transitive_density_summary'->>'scene_count')::int AS scene_count,
               (profile->'transitive_density_summary'->>'quest_count')::int AS quest_count,
               (profile->'transitive_density_summary'->>'descendant_location_count')::int AS descendant_location_count
          FROM entities
         WHERE id = 901914
      `);
      expect(city.rows[0]).toEqual({
        id: 901914,
        child_location_count: 2,
        npc_count: 2,
        scene_count: 13,
        quest_count: 4,
        descendant_location_count: 2,
      });

      const migrations = await db.query<{count: number}>(
        `SELECT COUNT(*)::int AS count FROM schema_migrations WHERE name = $1`,
        [PATCH],
      );
      expect(Number(migrations.rows[0]?.count)).toBe(1);
    } finally {
      await db.close();
    }
  });
});

async function applyPatch(db: PGlite, sql: string, name = PATCH): Promise<void> {
  await db.exec(`BEGIN; ${sql}; COMMIT;`);
  await db.query(
    `INSERT INTO schema_migrations (name)
     VALUES ($1)
     ON CONFLICT (name) DO NOTHING`,
    [name],
  );
}

describe('0122 Obsidian world patch v2 (production migration)', () => {
  it('applies idempotently and ships every OWV-14 acceptance row', async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, PATCH_V2), 'utf8');
    // OWV-14: the production migration must never re-trigger the
    // expensive full-cartridge density rebuild and must carry the
    // ARCH-19 normalized density columns plus all five OWV-17
    // runtime bridge rows.
    expect(sql).not.toContain('rebuild_local_density(');
    expect(sql).toContain('local_density_summary');
    expect(sql).toContain('transitive_density_summary');
    expect(sql).toContain('gh_forge_merge_entity_profile');
    expect(sql).toContain('forge_currency_bridge');
    expect(sql).toContain('forge_merchant_contracts');
    expect(sql).toContain('forge_materializer_bridge');
    expect(sql).toContain('forge_scene_instructions');
    expect(sql).toContain('forge_visual_assets');

    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'greenhaven-0122-smoke-'));
    tempDirs.push(dataDir);
    const db = await PGlite.create(dataDir);
    try {
      await createHostSchema(db);
      await applyPatch(db, sql, PATCH_V2);
      // Pre-seed one writer-edit so the merge helper has something
      // to protect: stamp a unique `topology_parent_id` and a fake
      // `local_density` row on Mikka's profile, then re-apply the
      // patch and assert the merge preserved both.
      const mikka = await db.query<{id: number}>(
        `SELECT id FROM entities WHERE display_name = 'Mikka' AND kind = 'person'`,
      );
      const mikkaId = mikka.rows[0]?.id;
      expect(mikkaId).toBeTypeOf('number');
      await db.query(
        `UPDATE entities
            SET profile = profile
              || jsonb_build_object('topology_parent_id', 999777)
              || jsonb_build_object('local_density', jsonb_build_object('sentinel', true))
          WHERE id = $1`,
        [mikkaId],
      );
      await applyPatch(db, sql, PATCH_V2);

      const counts = await db.query<{kind: string; count: number}>(`
        SELECT kind, COUNT(*)::int AS count
          FROM entities
         GROUP BY kind
         ORDER BY kind
      `);
      expect(Object.fromEntries(counts.rows.map(row => [row.kind, Number(row.count)]))).toEqual({
        item: 11,
        location: 3,
        person: 2,
        quest: 4,
        scene: 13,
        world_fact: 1,
      });

      const runtimeTypes = await db.query<{value_type: string; count: number}>(`
        SELECT value_type, COUNT(*)::int AS count
          FROM runtime_fields
         GROUP BY value_type
         ORDER BY value_type
      `);
      expect(runtimeTypes.rows).toEqual([{value_type: 'bool', count: 13}]);

      const start = await db.query<{value: unknown}>(`
        SELECT value
          FROM cartridge_meta
         WHERE key = 'starting_location_id'
      `);
      expect(start.rows[0]?.value).toBe(904983);

      // OWV-14: every entity profile now carries the authored
      // `source_path` + `source_markdown` so the runtime broker can
      // render an entity without a second Forge round-trip.
      const provenance = await db.query<{has_source_path: number; has_markdown: number}>(`
        SELECT COUNT(*) FILTER (WHERE profile ? 'source_path')::int AS has_source_path,
               COUNT(*) FILTER (WHERE profile ? 'source_markdown')::int AS has_markdown
          FROM entities
      `);
      expect(provenance.rows[0]?.has_source_path).toBe(34);
      expect(provenance.rows[0]?.has_markdown).toBe(34);

      // OWV-17 bridge meta: every bridge row is present with a
      // non-empty payload so the runtime services can load without
      // a fallback path. Each bridge uses its own canonical array
      // key (coins / offers / rows) — we look them up by name.
      const bridges = await db.query<{
        key: string;
        coins: number | null;
        offers: number | null;
        rows: number | null;
      }>(`
        SELECT key,
               jsonb_array_length(value->'coins')  AS coins,
               jsonb_array_length(value->'offers') AS offers,
               jsonb_array_length(value->'rows')   AS rows
          FROM cartridge_meta
         WHERE key IN (
           'forge_currency_bridge',
           'forge_merchant_contracts',
           'forge_materializer_bridge',
           'forge_scene_instructions',
           'forge_visual_assets'
         )
         ORDER BY key
      `);
      const bridgeMap = Object.fromEntries(
        bridges.rows.map(row => {
          const count = row.coins ?? row.offers ?? row.rows ?? 0;
          return [row.key, Number(count)];
        }),
      );
      expect(bridgeMap).toEqual({
        forge_currency_bridge: 3,
        forge_materializer_bridge: 5,
        forge_merchant_contracts: 13,
        forge_scene_instructions: 13,
        forge_visual_assets: 29,
      });

      // OWV-14: the migration also UPSERTs the three canonical
      // currency rows into the inventory items catalog so the
      // runtime currency bridge can resolve coin slugs without
      // hitting `entities`.
      const currency = await db.query<{slug: string; copper_value: number}>(`
        SELECT slug, (behaviour->>'copper_value')::int AS copper_value
          FROM items
         WHERE category = 'currency'
         ORDER BY copper_value
      `);
      expect(currency.rows).toEqual([
        {slug: 'copper-coin', copper_value: 1},
        {slug: 'silver-coin', copper_value: 10},
        {slug: 'gold-coin', copper_value: 100},
      ]);

      // OWV-14: way-to-thiefs-market quest no longer leaks the
      // markdown H1 into `quest_objective`. We pin the prefix here so
      // a future regression (e.g. parser revert) fails this test.
      const quest = await db.query<{quest_objective: string | null}>(`
        SELECT profile->>'quest_objective' AS quest_objective
          FROM entities
         WHERE kind = 'quest' AND display_name = 'Way to Thief''s market'
      `);
      const objective = quest.rows[0]?.quest_objective ?? '';
      expect(objective).not.toMatch(/^#/);
      expect(objective.length).toBeGreaterThan(0);

      // Protected profile merge: the writer-edited topology_parent_id
      // + local_density sentinel must survive the second migration
      // pass even though the incoming Forge payload does not carry
      // them.
      const mikkaProfile = await db.query<{
        topology_parent_id: number;
        sentinel: boolean | null;
      }>(`
        SELECT (profile->>'topology_parent_id')::int AS topology_parent_id,
               (profile->'local_density'->>'sentinel')::bool AS sentinel
          FROM entities
         WHERE id = $1
      `, [mikkaId]);
      expect(mikkaProfile.rows[0]?.topology_parent_id).toBe(999777);
      expect(mikkaProfile.rows[0]?.sentinel).toBe(true);

      const migrations = await db.query<{count: number}>(
        `SELECT COUNT(*)::int AS count FROM schema_migrations WHERE name = $1`,
        [PATCH_V2],
      );
      expect(Number(migrations.rows[0]?.count)).toBe(1);
    } finally {
      await db.close();
    }
  });
});

async function createHostSchema(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE entities (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      summary TEXT,
      profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      tags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      cartridge_id TEXT,
      topology_parent_id BIGINT REFERENCES entities(id) ON DELETE SET NULL,
      dynamic_origin BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE runtime_fields (
      id BIGSERIAL PRIMARY KEY,
      owner_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      field_key TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK (value_type IN
        ('int','float','bool','string','enum','entity_ref','json','dice')),
      default_value JSONB,
      allowed_values JSONB,
      scope TEXT NOT NULL DEFAULT 'session' CHECK (scope IN
        ('turn','scene','session','journey','permanent')),
      description TEXT,
      UNIQUE (owner_entity_id, field_key)
    );

    CREATE TABLE runtime_values (
      field_id BIGINT PRIMARY KEY REFERENCES runtime_fields(id) ON DELETE CASCADE,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source TEXT
    );

    CREATE TABLE cartridge_meta (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- OWV-14: production migration also UPSERTs currency rows into
    -- the inventory items catalog so the runtime currency bridge can
    -- resolve coin slugs by name. Shape mirrors migration 0046 plus
    -- legacy_entity_id added by the inventory consolidation chain.
    CREATE TABLE items (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL CHECK (category IN
        ('weapon','armor','consumable','tool','quest','material','currency')),
      weight_kg NUMERIC(5,2) NOT NULL DEFAULT 0,
      stackable BOOLEAN NOT NULL DEFAULT false,
      max_stack INTEGER NOT NULL DEFAULT 1,
      behaviour JSONB NOT NULL DEFAULT '{}'::jsonb,
      legacy_entity_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION safe_to_bigint(value text)
    RETURNS bigint
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
    BEGIN
      IF value !~ '^-?[0-9]+$' THEN
        RETURN NULL;
      END IF;
      BEGIN
        RETURN value::bigint;
      EXCEPTION
        WHEN numeric_value_out_of_range OR invalid_text_representation THEN
          RETURN NULL;
      END;
    END;
    $$;

    CREATE OR REPLACE FUNCTION gh_forge_merge_entity_profile(
      existing_profile jsonb,
      incoming_profile jsonb
    ) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
      SELECT
        COALESCE(incoming_profile, '{}'::jsonb)
        || CASE
             WHEN existing_profile IS NOT NULL
                  AND existing_profile ? 'topology_parent_id' THEN
               jsonb_build_object(
                 'topology_parent_id',
                 existing_profile -> 'topology_parent_id'
               )
             ELSE '{}'::jsonb
           END
        || CASE
             WHEN existing_profile IS NOT NULL
                  AND existing_profile ? 'local_density' THEN
               jsonb_build_object(
                 'local_density',
                 existing_profile -> 'local_density'
               )
             ELSE '{}'::jsonb
           END
        || CASE
             WHEN existing_profile IS NOT NULL
                  AND existing_profile ? 'local_density_summary' THEN
               jsonb_build_object(
                 'local_density_summary',
                 existing_profile -> 'local_density_summary'
               )
             ELSE '{}'::jsonb
           END
    $$;
  `);
}
