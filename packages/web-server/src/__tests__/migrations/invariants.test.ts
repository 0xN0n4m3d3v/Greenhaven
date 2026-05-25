import { afterAll, describe, expect, test } from 'vitest';
import {
  cleanupMigrationTemplates,
  listMigrationFiles,
  withPristineDb,
} from './framework.js';

afterAll(async () => {
  await cleanupMigrationTemplates();
});

describe.sequential('migration invariants', () => {
  test('all migrations apply on a pristine pglite database', async () => {
    const files = await listMigrationFiles();
    await withPristineDb(async (db) => {
      const health = await db.query<{ ok: number }>('SELECT 1 AS ok');
      expect(Number(health.rows[0]?.ok)).toBe(1);

      const applied = await db.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM schema_migrations',
      );
      expect(Number(applied.rows[0]?.count)).toBe(files.length);
    });
  });

  test('memory_threads orphan prerepair allows 0102 FK to apply', async () => {
    await withPristineDb(
      async (db) => {
        await db.query(
          `INSERT INTO memory_threads (id, player_id, title)
           VALUES ('orphan-thread', 999999999, 'orphaned legacy thread')`,
        );

        const player = await db.query<{ entity_id: number }>(`
          INSERT INTO entities (kind, display_name, profile, tags)
          VALUES ('player', 'memory thread FK test', '{}'::jsonb, ARRAY['player'])
          RETURNING id AS entity_id
        `);
        const entityId = Number(player.rows[0]?.entity_id);
        await db.query(
          `INSERT INTO players (entity_id, public_id)
           VALUES ($1, '00000000-0000-4000-8000-000000000102'::uuid)`,
          [entityId],
        );
        await db.query(
          `INSERT INTO memory_threads (id, player_id, title)
           VALUES ('valid-thread', $1, 'valid legacy thread')`,
          [entityId],
        );

        await db.applyMigrationFile('0101a_memory_threads_fk_prerepair.sql');
        await db.applyMigrationFile('0102_fk_fixes.sql');

        const orphan = await db.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM memory_threads
            WHERE id = 'orphan-thread'`,
        );
        expect(Number(orphan.rows[0]?.count)).toBe(0);

        await db.query('DELETE FROM players WHERE entity_id = $1', [entityId]);
        const valid = await db.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM memory_threads
            WHERE id = 'valid-thread'`,
        );
        expect(Number(valid.rows[0]?.count)).toBe(0);
      },
      { upToMigration: '0101_mikka_portrait_set.sql' },
    );
  });

  test('core Greenhaven tables exist after migrations', async () => {
    await withPristineDb(async (db) => {
      const missing = await db.query<{ name: string }>(`
        WITH expected(name) AS (
          VALUES
            ('entities'),
            ('players'),
            ('sessions'),
            ('runtime_fields'),
            ('runtime_values'),
            ('runtime_player_overlay'),
            ('player_quests'),
            ('tool_invocations'),
            ('gui_events'),
            ('turn_ingress_queue'),
            ('adventure_queue'),
            ('adventure_queue_counters'),
            ('cartridge_meta'),
            ('telemetry_events'),
            ('telemetry_spans')
        )
        SELECT e.name
          FROM expected e
          LEFT JOIN information_schema.tables t
            ON t.table_schema = 'public'
           AND t.table_name = e.name
         WHERE t.table_name IS NULL
      `);
      expect(missing.rows).toEqual([]);
    });
  });

  test('player recovery schema stores only recovery hashes', async () => {
    await withPristineDb(async (db) => {
      const columns = await db.query<{ column_name: string }>(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'players'
           AND column_name IN ('recovery_code', 'recovery_code_hash')
         ORDER BY column_name
      `);
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'recovery_code_hash',
      ]);
    });
  });

  test('DEEP-2 recovery_code_prefix column, check constraint, and partial index exist', async () => {
    await withPristineDb(async (db) => {
      const column = await db.query<{ data_type: string; is_nullable: string }>(`
        SELECT data_type, is_nullable
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'players'
           AND column_name = 'recovery_code_prefix'
      `);
      expect(column.rows.length).toBe(1);
      expect(column.rows[0]?.data_type).toBe('text');
      expect(column.rows[0]?.is_nullable).toBe('YES');

      const check = await db.query<{ conname: string }>(`
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'public.players'::regclass
           AND conname = 'players_recovery_code_prefix_check'
      `);
      expect(check.rows.length).toBe(1);

      const index = await db.query<{ indexdef: string }>(`
        SELECT indexdef
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'players'
           AND indexname = 'idx_players_recovery_code_prefix'
      `);
      expect(index.rows.length).toBe(1);
      expect(index.rows[0]?.indexdef).toMatch(/recovery_code_prefix/);
      expect(index.rows[0]?.indexdef).toMatch(/WHERE/i);

      // CHECK accepts a four-character base32 prefix and rejects anything
      // outside the recovery-code alphabet (including the confusable
      // 0/O/1/I glyphs).
      // CHECK accepts a four-character base32 prefix and rejects anything
      // outside the recovery-code alphabet (including the confusable
      // 0/O/1/I glyphs). gen_random_uuid() satisfies the players.public_id
      // UUID column without us minting one in JS.
      const okEntity = await db.query<{ id: number }>(
        `INSERT INTO entities (kind, display_name, profile, tags)
         VALUES ('player', 'DEEP-2 invariant ok', '{}'::jsonb, ARRAY['player'])
         RETURNING id`,
      );
      const okId = Number(okEntity.rows[0]?.id);
      await db.query(
        `INSERT INTO players
           (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
         VALUES ($1, gen_random_uuid(), $2, $3)`,
        [okId, 'hash', 'AB2N'],
      );

      const badEntity = await db.query<{ id: number }>(
        `INSERT INTO entities (kind, display_name, profile, tags)
         VALUES ('player', 'DEEP-2 invariant bad', '{}'::jsonb, ARRAY['player'])
         RETURNING id`,
      );
      const badId = Number(badEntity.rows[0]?.id);
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO players
             (entity_id, public_id, recovery_code_hash, recovery_code_prefix)
           VALUES ($1, gen_random_uuid(), $2, $3)`,
          [badId, 'hash', '0OI1'],
        );
      } catch (err) {
        rejected =
          err instanceof Error && /players_recovery_code_prefix_check/.test(err.message);
      }
      expect(rejected).toBe(true);
    });
  });

  test('runtime field declarations use known value types and scopes', async () => {
    await withPristineDb(async (db) => {
      const invalid = await db.query<{ id: number; field_key: string }>(`
        SELECT id, field_key
          FROM runtime_fields
         WHERE btrim(field_key) = ''
            OR value_type NOT IN (
              'int',
              'float',
              'bool',
              'string',
              'enum',
              'entity_ref',
              'json',
              'dice'
            )
            OR scope NOT IN (
              'turn',
              'scene',
              'session',
              'journey',
              'permanent'
            )
         LIMIT 20
      `);
      expect(invalid.rows).toEqual([]);

      const orphaned = await db.query<{ id: number }>(`
        SELECT rf.id
          FROM runtime_fields rf
          LEFT JOIN entities e ON e.id = rf.owner_entity_id
         WHERE e.id IS NULL
         LIMIT 20
      `);
      expect(orphaned.rows).toEqual([]);
    });
  });

  test('topology parent ids point to existing locations or districts (normalized column post-Phase 4)', async () => {
    await withPristineDb(async (db) => {
      // ARCH-19 Phase 4 (migration 0123) — entities.profile no longer
      // carries `topology_parent_id`; the normalized column is the
      // canonical pointer. The FK constraint added in 0105 already
      // enforces existence, so this assertion repeats the FK check
      // via SQL for evidence in the test record.
      const missing = await db.query<{ id: number; topology_parent_id: number }>(`
        SELECT child.id, child.topology_parent_id
          FROM entities child
          LEFT JOIN entities parent
            ON parent.id = child.topology_parent_id
         WHERE child.topology_parent_id IS NOT NULL
           AND (
             parent.id IS NULL
             OR parent.kind NOT IN ('location', 'district')
           )
         LIMIT 20
      `);
      expect(missing.rows).toEqual([]);
    });
  });

  test('topology graph has no parent cycles (normalized column post-Phase 4)', async () => {
    await withPristineDb(async (db) => {
      const cycles = await db.query<{ start_id: number }>(`
        WITH RECURSIVE edges AS (
          SELECT id, topology_parent_id AS parent_id
            FROM entities
           WHERE topology_parent_id IS NOT NULL
        ),
        walk(start_id, current_id, path, cycle) AS (
          SELECT id, parent_id, ARRAY[id], false
            FROM edges
          UNION ALL
          SELECT walk.start_id,
                 edges.parent_id,
                 walk.path || edges.id,
                 edges.parent_id = ANY(walk.path)
            FROM walk
            JOIN edges ON edges.id = walk.current_id
           WHERE NOT walk.cycle
             AND array_length(walk.path, 1) < 64
        )
        SELECT DISTINCT start_id
          FROM walk
         WHERE cycle
         LIMIT 20
      `);
      expect(cycles.rows).toEqual([]);
    });
  });

  test('local density buckets contain only matching entity kinds', async () => {
    await withPristineDb(async (db) => {
      const badNpcs = await db.query<{ location_id: number; npc_id: string }>(`
        SELECT l.id AS location_id, bucket.value AS npc_id
          FROM entities l
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(l.profile->'local_density'->'npc_ids') = 'array'
              THEN l.profile->'local_density'->'npc_ids'
              ELSE '[]'::jsonb
            END
          ) AS bucket(value)
          LEFT JOIN entities e ON e.id = bucket.value::bigint
         WHERE l.kind IN ('location', 'district')
           AND e.kind IS DISTINCT FROM 'person'
         LIMIT 20
      `);
      expect(badNpcs.rows).toEqual([]);

      const badChildren = await db.query<{
        location_id: number;
        child_id: string;
      }>(`
        SELECT l.id AS location_id, bucket.value AS child_id
          FROM entities l
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(l.profile->'local_density'->'child_location_ids') = 'array'
              THEN l.profile->'local_density'->'child_location_ids'
              ELSE '[]'::jsonb
            END
          ) AS bucket(value)
          LEFT JOIN entities e ON e.id = bucket.value::bigint
         WHERE l.kind IN ('location', 'district')
           AND (
             e.id IS NULL
             OR e.kind NOT IN ('location', 'district')
           )
         LIMIT 20
      `);
      expect(badChildren.rows).toEqual([]);
    });
  });

  test('local density summary counts match local density arrays', async () => {
    await withPristineDb(async (db) => {
      const bad = await db.query<{ id: number }>(`
        SELECT id
          FROM entities
         WHERE kind IN ('location', 'district')
           AND profile ? 'local_density_summary'
           AND (
             COALESCE((profile->'local_density_summary'->>'npc_count')::int, 0)
               <> CASE
                    WHEN jsonb_typeof(profile->'local_density'->'npc_ids') = 'array'
                    THEN jsonb_array_length(profile->'local_density'->'npc_ids')
                    ELSE 0
                  END
             OR COALESCE((profile->'local_density_summary'->>'child_location_count')::int, 0)
               <> CASE
                    WHEN jsonb_typeof(profile->'local_density'->'child_location_ids') = 'array'
                    THEN jsonb_array_length(profile->'local_density'->'child_location_ids')
                    ELSE 0
                  END
           )
         LIMIT 20
      `);
      expect(bad.rows).toEqual([]);
    });
  });

  test('cartridge-tagged entities use known cartridge ids (normalized column post-Phase 4)', async () => {
    await withPristineDb(async (db) => {
      // ARCH-19 Phase 4 (migration 0123) — entities.profile no longer
      // carries `cartridge_id`; the normalized column is the canonical
      // home. The `support-smoke` value is also included because
      // 0106 / 0123 stamps it on support-smoke fixture rows.
      const unknown = await db.query<{ cartridge_id: string }>(`
        WITH known(cartridge_id) AS (
          SELECT value #>> '{}'
            FROM cartridge_meta
           WHERE key = 'cartridge_id'
          UNION
          VALUES
            ('quickgrin-lane'),
            ('grinhaven-full'),
            ('robot-empty-world'),
            ('support-smoke')
        )
        SELECT DISTINCT e.cartridge_id
          FROM entities e
          LEFT JOIN known k ON k.cartridge_id = e.cartridge_id
         WHERE e.cartridge_id IS NOT NULL
           AND k.cartridge_id IS NULL
         ORDER BY e.cartridge_id
      `);
      expect(unknown.rows).toEqual([]);
    });
  });

  test('location exits reference existing locations or districts', async () => {
    await withPristineDb(async (db) => {
      const invalid = await db.query<{ location_id: number; exit_id: string }>(`
        SELECT l.id AS location_id, exit_ref.value AS exit_id
          FROM entities l
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(l.profile->'exits') = 'array'
              THEN l.profile->'exits'
              ELSE '[]'::jsonb
            END
          ) AS exit_ref(value)
          LEFT JOIN entities e ON e.id = exit_ref.value::bigint
         WHERE l.kind IN ('location', 'district')
           AND (
             e.id IS NULL
             OR e.kind NOT IN ('location', 'district')
           )
         LIMIT 20
      `);
      expect(invalid.rows).toEqual([]);
    });
  });

  test('forge merge helper preserves protected profile fields on re-import', async () => {
    await withPristineDb(async (db) => {
      // Seed an entity that simulates state after a runtime/compile pass
      // has written computed fields onto entities.profile alongside the
      // cartridge author's original payload.
      // ARCH-19 Phase 4 (migration 0124): non-player non-dynamic rows
      // must carry a cartridge_id. Stamp the seed and upsert with a
      // test cartridge so the row-level CHECK is satisfied.
      await db.query(
        `INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id)
         VALUES ($1, 'location', 'M-2 Probe', 'before', $2::jsonb, ARRAY['m2-probe'], 'm2-probe-test')
         ON CONFLICT (id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           summary = EXCLUDED.summary,
           profile = EXCLUDED.profile,
           tags = EXCLUDED.tags,
           cartridge_id = EXCLUDED.cartridge_id`,
        [
          997001,
          JSON.stringify({
            cartridge_author_field: 'old',
            topology_parent_id: 600,
            local_density: { npc_ids: [], child_location_ids: [] },
            local_density_summary: { npcs: 0, child_locations: 0 },
          }),
        ],
      );

      // Re-run a forge-style upsert: cartridge author updated their
      // payload (cartridge_author_field changes; new summary_addition
      // appears) but did NOT carry the protected fields forward.
      await db.query(
        `INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id)
         VALUES ($1, 'location', 'M-2 Probe', 'after', $2::jsonb, ARRAY['m2-probe', 'updated'], 'm2-probe-test')
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind,
           display_name = EXCLUDED.display_name,
           summary = EXCLUDED.summary,
           profile = gh_forge_merge_entity_profile(entities.profile, EXCLUDED.profile),
           tags = EXCLUDED.tags`,
        [
          997001,
          JSON.stringify({
            cartridge_author_field: 'new',
            summary_addition: 'extra',
          }),
        ],
      );

      const after = await db.query<{
        summary: string;
        tags: string[];
        profile: Record<string, unknown>;
      }>(`SELECT summary, tags, profile FROM entities WHERE id = $1`, [997001]);
      const row = after.rows[0]!;
      expect(row.summary).toBe('after');
      expect(row.tags).toEqual(['m2-probe', 'updated']);
      expect(row.profile['cartridge_author_field']).toBe('new');
      expect(row.profile['summary_addition']).toBe('extra');
      expect(row.profile['topology_parent_id']).toBe(600);
      expect(row.profile['local_density']).toEqual({
        npc_ids: [],
        child_location_ids: [],
      });
      expect(row.profile['local_density_summary']).toEqual({
        npcs: 0,
        child_locations: 0,
      });
    });
  });

  test('forge merge helper does not introduce null protected keys when existing row lacks them', async () => {
    await withPristineDb(async (db) => {
      // Pure cartridge author content — no runtime/computed fields present.
      const incomingProfile = { cartridge_author_field: 'fresh' };
      const result = await db.query<{ merged: Record<string, unknown> }>(
        `SELECT gh_forge_merge_entity_profile($1::jsonb, $2::jsonb) AS merged`,
        [
          JSON.stringify({ cartridge_author_field: 'old' }),
          JSON.stringify(incomingProfile),
        ],
      );
      const merged = result.rows[0]!.merged;
      expect(merged).toEqual(incomingProfile);
      expect(Object.prototype.hasOwnProperty.call(merged, 'topology_parent_id')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(merged, 'local_density')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(merged, 'local_density_summary')).toBe(false);
    });
  });

  test('forge merge helper returns incoming when the existing profile is null', async () => {
    await withPristineDb(async (db) => {
      const incoming = { cartridge_author_field: 'fresh', topology_parent_id: 42 };
      const result = await db.query<{ merged: Record<string, unknown> }>(
        `SELECT gh_forge_merge_entity_profile(NULL::jsonb, $1::jsonb) AS merged`,
        [JSON.stringify(incoming)],
      );
      // First-write: no existing profile means the incoming cartridge
      // payload (including any topology_parent_id the author chose to
      // set) flows through. Runtime pipelines can then overwrite later.
      expect(result.rows[0]!.merged).toEqual(incoming);
    });
  });

  test('rebuild_local_density is defined as a callable function with cap parameters', async () => {
    await withPristineDb(async (db) => {
      // After M-3 (0107) the function takes 7 args: target_cartridge
      // plus six cap parameters (npcs, child_locations, scenes,
      // events, activities, quests). Defaults match 0093/0104 so
      // the one-argument call still works.
      const fn = await db.query<{ pronargs: number; prorettype: string }>(
        `SELECT pronargs::int, pg_type.typname AS prorettype
           FROM pg_proc
           JOIN pg_type ON pg_type.oid = pg_proc.prorettype
          WHERE proname = 'rebuild_local_density'`,
      );
      expect(fn.rows.length).toBe(1);
      expect(fn.rows[0]!.pronargs).toBe(7);
    });
  });

  test('rebuild_local_density is idempotent against the active cartridge', async () => {
    await withPristineDb(async (db) => {
      const before = await db.query<{
        id: number;
        local_density: Record<string, unknown> | null;
        local_density_summary: Record<string, unknown> | null;
        transitive_density_summary: Record<string, unknown> | null;
      }>(
        `SELECT id,
                profile->'local_density' AS local_density,
                profile->'local_density_summary' AS local_density_summary,
                profile->'transitive_density_summary' AS transitive_density_summary
           FROM entities
          WHERE kind IN ('location', 'district')
            AND cartridge_id = 'grinhaven-full'
          ORDER BY id`,
      );
      expect(before.rows.length).toBeGreaterThan(0);

      const firstCall = await db.query<{
        location_id: number;
        npc_count: number;
        child_count: number;
      }>(`SELECT * FROM rebuild_local_density('grinhaven-full')`);
      const secondCall = await db.query<{
        location_id: number;
        npc_count: number;
        child_count: number;
      }>(`SELECT * FROM rebuild_local_density('grinhaven-full')`);
      expect(firstCall.rows).toEqual(secondCall.rows);
      expect(firstCall.rows.length).toBe(before.rows.length);

      const after = await db.query<{
        id: number;
        local_density: Record<string, unknown> | null;
        local_density_summary: Record<string, unknown> | null;
        transitive_density_summary: Record<string, unknown> | null;
      }>(
        `SELECT id,
                profile->'local_density' AS local_density,
                profile->'local_density_summary' AS local_density_summary,
                profile->'transitive_density_summary' AS transitive_density_summary
           FROM entities
          WHERE kind IN ('location', 'district')
            AND cartridge_id = 'grinhaven-full'
          ORDER BY id`,
      );
      expect(after.rows.length).toBe(before.rows.length);
      for (let i = 0; i < before.rows.length; i++) {
        const b = before.rows[i]!;
        const a = after.rows[i]!;
        expect(a.id).toBe(b.id);
        expect(a.local_density).toEqual(b.local_density);
        expect(a.local_density_summary).toEqual(b.local_density_summary);
        expect(a.transitive_density_summary).toEqual(
          b.transitive_density_summary,
        );
      }
    });
  });

  test('entities has normalized cartridge_id / topology_parent_id / dynamic_origin columns', async () => {
    await withPristineDb(async (db) => {
      const columns = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(`
        SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'entities'
           AND column_name IN ('cartridge_id', 'topology_parent_id', 'dynamic_origin')
         ORDER BY column_name
      `);
      expect(columns.rows).toEqual([
        expect.objectContaining({
          column_name: 'cartridge_id',
          data_type: 'text',
          is_nullable: 'YES',
        }),
        expect.objectContaining({
          column_name: 'dynamic_origin',
          data_type: 'boolean',
          is_nullable: 'NO',
          column_default: 'false',
        }),
        expect.objectContaining({
          column_name: 'topology_parent_id',
          data_type: 'bigint',
          is_nullable: 'YES',
        }),
      ]);
    });
  });

  test('ARCH-19 indexes and FK are in place on entities', async () => {
    await withPristineDb(async (db) => {
      const indexes = await db.query<{ indexname: string }>(`
        SELECT indexname
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'entities'
           AND indexname IN (
             'entities_cartridge_id_idx',
             'entities_topology_parent_id_idx',
             'entities_dynamic_origin_idx'
           )
         ORDER BY indexname
      `);
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        'entities_cartridge_id_idx',
        'entities_dynamic_origin_idx',
        'entities_topology_parent_id_idx',
      ]);

      const fk = await db.query<{
        confrelid_name: string;
        confdeltype: string;
      }>(`
        SELECT pg_class.relname AS confrelid_name,
               confdeltype
          FROM pg_constraint
          JOIN pg_class ON pg_class.oid = pg_constraint.confrelid
         WHERE conname = 'entities_topology_parent_id_fkey'
      `);
      expect(fk.rows.length).toBe(1);
      expect(fk.rows[0]!.confrelid_name).toBe('entities');
      // 'n' = NO ACTION, 'r' = RESTRICT, 'c' = CASCADE, 'd' = SET DEFAULT,
      // 'n' actually means NO ACTION; SET NULL = 'n' OR 's'? Reference:
      // postgres pg_constraint docs say SET NULL = 'n', but most installs
      // report 'n' for NO ACTION and 'n' for SET NULL only when nulled.
      // The canonical code for SET NULL is 'n' in older builds; modern
      // PostgreSQL uses 'n' for SET NULL and 'a' for NO ACTION? Be lenient
      // here: accept either SET NULL via lookup.
      expect(['n']).toContain(fk.rows[0]!.confdeltype);
    });
  });

  test('Phase 4: no stored row carries profile.cartridge_id (column is canonical)', async () => {
    await withPristineDb(async (db) => {
      // ARCH-19 Phase 4 (migration 0123) — the dual-write window is
      // over. Every stored row's profile JSONB MUST be free of the
      // retired key; the normalized `cartridge_id` column is the
      // only canonical home.
      const remaining = await db.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count
          FROM entities
         WHERE profile ? 'cartridge_id'
      `);
      expect(Number(remaining.rows[0]?.count)).toBe(0);

      const populated = await db.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count
          FROM entities
         WHERE cartridge_id IS NOT NULL
      `);
      expect(Number(populated.rows[0]?.count)).toBeGreaterThan(0);
    });
  });

  test('Phase 4: no stored row carries profile.origin or the "dynamic" tag (column is canonical)', async () => {
    await withPristineDb(async (db) => {
      const leftoverOrigin = await db.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count
          FROM entities
         WHERE profile ? 'origin'
      `);
      expect(Number(leftoverOrigin.rows[0]?.count)).toBe(0);

      const leftoverTag = await db.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count
          FROM entities
         WHERE 'dynamic' = ANY(tags)
      `);
      expect(Number(leftoverTag.rows[0]?.count)).toBe(0);
    });
  });

  test('Phase 4: no stored row carries the "support-smoke" tag (cartridge_id column is canonical)', async () => {
    await withPristineDb(async (db) => {
      // ARCH-19 Phase 4 (migration 0124) retired the legacy
      // `'support-smoke'` tag at the row level. The canonical scope
      // is `cartridge_id = 'support-smoke'`. Any leak points at a
      // writer that still emits the retired marker.
      const leftover = await db.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count
          FROM entities
         WHERE 'support-smoke' = ANY(tags)
      `);
      expect(Number(leftover.rows[0]?.count)).toBe(0);
    });
  });

  test('Phase 4: no stored row carries profile.topology_parent_id (column is canonical)', async () => {
    await withPristineDb(async (db) => {
      const remaining = await db.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count
          FROM entities
         WHERE profile ? 'topology_parent_id'
      `);
      expect(Number(remaining.rows[0]?.count)).toBe(0);
    });
  });

  test('safe_to_bigint accepts integers and rejects malformed / overflow input', async () => {
    await withPristineDb(async (db) => {
      const r = await db.query<{ probe: string; result: string | null }>(`
        WITH probes(probe) AS (
          VALUES ('42'), ('-7'), ('0'),
                 ('not a number'), (''), ('1.5'),
                 ('99999999999999999999999999999')
        )
        SELECT probe, safe_to_bigint(probe)::text AS result
          FROM probes
         ORDER BY probe
      `);
      const byProbe = new Map(r.rows.map((row) => [row.probe, row.result]));
      expect(byProbe.get('42')).toBe('42');
      expect(byProbe.get('-7')).toBe('-7');
      expect(byProbe.get('0')).toBe('0');
      expect(byProbe.get('not a number')).toBeNull();
      expect(byProbe.get('')).toBeNull();
      expect(byProbe.get('1.5')).toBeNull();
      expect(byProbe.get('99999999999999999999999999999')).toBeNull();
    });
  });

  test('safe_jsonb_array normalises every non-array JSONB shape to []', async () => {
    await withPristineDb(async (db) => {
      // M-6: the helper must convert NULL, objects, scalars, and
      // malformed shapes into '[]'::jsonb so callers can pipe its
      // output straight into jsonb_array_elements*. Arrays pass
      // through unchanged.
      const r = await db.query<{ label: string; out: string }>(`
        WITH probes(label, v) AS (
          VALUES
            ('null'::text,   NULL::jsonb),
            ('object',       '{"a": 1}'::jsonb),
            ('string',       '"hi"'::jsonb),
            ('number',       '42'::jsonb),
            ('bool',         'true'::jsonb),
            ('json_null',    'null'::jsonb),
            ('empty_array',  '[]'::jsonb),
            ('mixed_array',  '[1, "x", null]'::jsonb)
        )
        SELECT label, safe_jsonb_array(v)::text AS out
          FROM probes
         ORDER BY label
      `);
      const byLabel = new Map(r.rows.map((row) => [row.label, row.out]));
      expect(byLabel.get('null')).toBe('[]');
      expect(byLabel.get('object')).toBe('[]');
      expect(byLabel.get('string')).toBe('[]');
      expect(byLabel.get('number')).toBe('[]');
      expect(byLabel.get('bool')).toBe('[]');
      expect(byLabel.get('json_null')).toBe('[]');
      expect(byLabel.get('empty_array')).toBe('[]');
      expect(byLabel.get('mixed_array')).toBe('[1, "x", null]');
    });
  });

  test('safe_jsonb_array hardens runtime_values append over non-array existing values', async () => {
    await withPristineDb(async (db) => {
      // M-6 follow-up: tools/intimacy.ts and tools/runtime.ts both
      // build their append SQL as
      //   safe_jsonb_array(runtime_values.value) || jsonb_build_array(...)
      // so that a pre-existing object / scalar / null runtime_value
      // becomes a single-element array containing only the appended
      // payload — instead of the legacy COALESCE-then-`||` path
      // which would either produce `object || array` or duplicate
      // the bad shape into the result.

      // Seed a runtime_field whose owner is any existing entity.
      const owner = await db.query<{ id: number }>(
        `SELECT id FROM entities WHERE kind IN ('location', 'district') ORDER BY id LIMIT 1`,
      );
      const ownerId = owner.rows[0]!.id;
      const field = await db.query<{ id: number }>(
        `INSERT INTO runtime_fields (owner_entity_id, field_key, value_type, default_value, scope)
         VALUES ($1, 'm6_followup_probe', 'json', '[]'::jsonb, 'permanent')
         RETURNING id`,
        [ownerId],
      );
      const fieldId = field.rows[0]!.id;

      // Force a NON-array existing value so the append must rescue.
      await db.query(
        `INSERT INTO runtime_values (field_id, value, source, updated_at)
         VALUES ($1, '{"corrupted": true}'::jsonb, 'm6-probe', now())`,
        [fieldId],
      );

      // Mirror the production append SQL: insert-or-upsert with the
      // safe_jsonb_array(...) guard. Use a literal payload to make
      // the assertion easy.
      await db.query(
        `INSERT INTO runtime_values (field_id, value, source, updated_at)
         VALUES ($1, jsonb_build_array('"after"'::jsonb), 'm6-probe', now())
         ON CONFLICT (field_id)
         DO UPDATE SET value = safe_jsonb_array(runtime_values.value)
                               || jsonb_build_array('"after"'::jsonb),
                       source = EXCLUDED.source,
                       updated_at = now()`,
        [fieldId],
      );

      const r = await db.query<{ value: unknown; out_type: string }>(
        `SELECT value, jsonb_typeof(value) AS out_type
           FROM runtime_values WHERE field_id = $1`,
        [fieldId],
      );
      // node-postgres parses jsonb → JS, so '"after"'::jsonb arrives
      // as the JS string "after".
      expect(r.rows[0]!.out_type).toBe('array');
      expect(r.rows[0]!.value).toEqual(['after']);
    });
  });

  test('safe_jsonb_array is registered as an IMMUTABLE, non-STRICT SQL function', async () => {
    await withPristineDb(async (db) => {
      // STRICT would short-circuit safe_jsonb_array(NULL) to NULL and
      // break the "missing key flows in as NULL, returns []" contract
      // that the runtime hot paths rely on. Lock that down here.
      const fn = await db.query<{
        provolatile: string;
        proisstrict: boolean;
        prolang: string;
      }>(`
        SELECT pg_proc.provolatile,
               pg_proc.proisstrict,
               pg_language.lanname AS prolang
          FROM pg_proc
          JOIN pg_language ON pg_language.oid = pg_proc.prolang
         WHERE pg_proc.proname = 'safe_jsonb_array'
      `);
      expect(fn.rows.length).toBe(1);
      expect(fn.rows[0]!.provolatile).toBe('i');
      expect(fn.rows[0]!.proisstrict).toBe(false);
      expect(fn.rows[0]!.prolang).toBe('sql');
    });
  });

  test('FK ON DELETE SET NULL nulls child topology_parent_id when parent is removed', async () => {
    await withPristineDb(async (db) => {
      // ARCH-19 Phase 4 (migration 0124): non-player non-dynamic rows
      // must carry a normalized cartridge_id. The JSONB cartridge_id
      // hint was retired in 0123, so stamp the column directly.
      const parent = await db.query<{ id: number }>(
        `INSERT INTO entities (kind, display_name, profile, tags, cartridge_id)
         VALUES ('location', 'ARCH-19 Probe Parent', '{}'::jsonb, ARRAY['arch19-probe'], 'support-smoke')
         RETURNING id`,
      );
      const parentId = parent.rows[0]!.id;

      const child = await db.query<{ id: number }>(
        `INSERT INTO entities (kind, display_name, profile, tags, topology_parent_id, cartridge_id)
         VALUES ('location', 'ARCH-19 Probe Child', '{}'::jsonb, ARRAY['arch19-probe'], $1, 'support-smoke')
         RETURNING id`,
        [parentId],
      );
      const childId = child.rows[0]!.id;

      const before = await db.query<{ topology_parent_id: number | null }>(
        `SELECT topology_parent_id FROM entities WHERE id = $1`,
        [childId],
      );
      expect(Number(before.rows[0]?.topology_parent_id)).toBe(parentId);

      await db.query(`DELETE FROM entities WHERE id = $1`, [parentId]);
      const after = await db.query<{ topology_parent_id: number | null }>(
        `SELECT topology_parent_id FROM entities WHERE id = $1`,
        [childId],
      );
      expect(after.rows[0]?.topology_parent_id).toBeNull();
    });
  });

  test('quickgrin-lane fallback is applied to every unmarked static entity', async () => {
    await withPristineDb(async (db) => {
      // ARCH-19 Phase 4 (migration 0124) retired the legacy
      // `'support-smoke'` tag carve-out. After the parity sweep in
      // 0124 every non-player non-dynamic row carries a
      // `cartridge_id`; the row-level CHECK enforces it from here on.
      const missed = await db.query<{ id: number; kind: string }>(`
        SELECT id, kind
          FROM entities
         WHERE cartridge_id IS NULL
           AND kind <> 'player'
           AND dynamic_origin = false
         LIMIT 5
      `);
      expect(missed.rows).toEqual([]);
    });
  });

  test('Phase 3 cleanup: every non-player non-dynamic entity has a non-null cartridge_id', async () => {
    await withPristineDb(async (db) => {
      const missed = await db.query<{ id: number; kind: string; tags: string[] }>(`
        SELECT id, kind, tags
          FROM entities
         WHERE cartridge_id IS NULL
           AND kind <> 'player'
           AND dynamic_origin = false
         LIMIT 5
      `);
      expect(missed.rows).toEqual([]);
    });
  });

  test('Phase 4 (migration 0124): entities_cartridge_id_required_ck exists and rejects invalid static rows', async () => {
    await withPristineDb(async (db) => {
      // ARCH-19 Phase 4 (migration 0124) added the row-level CHECK
      // `kind = 'player' OR dynamic_origin = TRUE OR cartridge_id IS NOT NULL`.
      const constraint = await db.query<{ conname: string }>(`
        SELECT conname
          FROM pg_constraint
         WHERE conname = 'entities_cartridge_id_required_ck'
      `);
      expect(constraint.rows.length).toBe(1);

      // Player rows are explicitly allowed without a cartridge.
      await expect(
        db.query(
          `INSERT INTO entities (kind, display_name, profile, tags,
                                 cartridge_id, dynamic_origin)
           VALUES ('player', 'phase4 player allowed', '{}'::jsonb,
                   ARRAY[]::text[], NULL, false)`,
        ),
      ).resolves.toBeDefined();

      // Dynamic-origin rows are allowed without a cartridge.
      await expect(
        db.query(
          `INSERT INTO entities (kind, display_name, profile, tags,
                                 cartridge_id, dynamic_origin)
           VALUES ('event', 'phase4 dynamic allowed', '{}'::jsonb,
                   ARRAY[]::text[], NULL, true)`,
        ),
      ).resolves.toBeDefined();

      // Static non-player rows MUST carry a cartridge.
      await expect(
        db.query(
          `INSERT INTO entities (kind, display_name, profile, tags,
                                 cartridge_id, dynamic_origin)
           VALUES ('location', 'phase4 rejected static', '{}'::jsonb,
                   ARRAY[]::text[], NULL, false)`,
        ),
      ).rejects.toThrow(/entities_cartridge_id_required_ck/);
    });
  });

  test('Phase 3 cleanup: cartridge_id column is whitespace-trimmed', async () => {
    await withPristineDb(async (db) => {
      const untrimmed = await db.query<{ id: number; cartridge_id: string }>(`
        SELECT id, cartridge_id
          FROM entities
         WHERE cartridge_id IS NOT NULL
           AND cartridge_id <> TRIM(cartridge_id)
         LIMIT 5
      `);
      expect(untrimmed.rows).toEqual([]);
    });
  });

  test('rebuild_local_density accepts cap parameters that change array sizes', async () => {
    await withPristineDb(async (db) => {
      // Pick the location with the largest npc_count under the
      // default caps (16). We then re-run with max_npcs=2 and assert
      // the array shrinks. Pick a location whose actual NPC count is
      // already > 2 so the cap visibly bites.
      const seed = await db.query<{
        id: number;
        npc_count: number;
      }>(`
        SELECT id,
               COALESCE((profile->'local_density_summary'->>'npc_count')::int, 0) AS npc_count
          FROM entities
         WHERE kind IN ('location', 'district')
           AND cartridge_id = 'grinhaven-full'
           AND COALESCE((profile->'local_density_summary'->>'npc_count')::int, 0) > 2
         ORDER BY npc_count DESC
         LIMIT 1
      `);
      expect(seed.rows.length).toBe(1);
      const targetId = seed.rows[0]!.id;
      const baseline = Number(seed.rows[0]!.npc_count);

      // Re-run with a tiny npcs cap; assert the array shrinks.
      await db.query(
        `SELECT rebuild_local_density('grinhaven-full', 2, 24, 12, 12, 12, 8)`,
      );
      const capped = await db.query<{ npc_count: number; npc_ids_len: number }>(
        `SELECT (profile->'local_density_summary'->>'npc_count')::int AS npc_count,
                jsonb_array_length(profile->'local_density'->'npc_ids') AS npc_ids_len
           FROM entities WHERE id = $1`,
        [targetId],
      );
      expect(Number(capped.rows[0]?.npc_count)).toBe(2);
      expect(Number(capped.rows[0]?.npc_ids_len)).toBe(2);

      // Restore defaults via the one-argument form and assert the
      // count returns to the baseline (idempotence under defaults).
      await db.query(`SELECT rebuild_local_density('grinhaven-full')`);
      const restored = await db.query<{ npc_count: number }>(
        `SELECT (profile->'local_density_summary'->>'npc_count')::int AS npc_count
           FROM entities WHERE id = $1`,
        [targetId],
      );
      expect(Number(restored.rows[0]?.npc_count)).toBe(baseline);
    });
  });

  test('cartridge_meta seeds density_caps with the 0107 defaults', async () => {
    await withPristineDb(async (db) => {
      const r = await db.query<{ value: Record<string, unknown> }>(
        `SELECT value FROM cartridge_meta WHERE key = 'density_caps'`,
      );
      expect(r.rows.length).toBe(1);
      expect(r.rows[0]!.value).toEqual({
        npcs: 16,
        child_locations: 24,
        scenes: 12,
        events: 12,
        activities: 12,
        quests: 8,
      });
    });
  });

  test('rebuild_local_density repairs a dirtied density row', async () => {
    await withPristineDb(async (db) => {
      const seed = await db.query<{
        id: number;
        before_density: Record<string, unknown> | null;
        before_summary: Record<string, unknown> | null;
      }>(
        `SELECT id,
                profile->'local_density' AS before_density,
                profile->'local_density_summary' AS before_summary
           FROM entities
          WHERE kind IN ('location', 'district')
            AND cartridge_id = 'grinhaven-full'
            AND COALESCE((profile->'local_density_summary'->>'npc_count')::int, 0) > 0
          ORDER BY id
          LIMIT 1`,
      );
      // The fixture must include at least one location with NPCs for
      // this test to be meaningful.
      expect(seed.rows.length).toBe(1);
      const target = seed.rows[0]!;

      const dirty = {
        child_location_ids: [-1, -2],
        npc_ids: [-1, -2, -3, -4, -5],
        scene_ids: [-1],
        event_ids: [-1],
        activity_ids: [-1],
        quest_ids: [-1],
      };
      const dirtySummary = {
        child_location_count: 2,
        npc_count: 5,
        scene_count: 1,
        event_count: 1,
        activity_count: 1,
        quest_count: 1,
      };
      await db.query(
        `UPDATE entities
            SET profile = jsonb_set(
                            jsonb_set(profile, '{local_density}', $2::jsonb, true),
                            '{local_density_summary}', $3::jsonb, true)
          WHERE id = $1`,
        [target.id, JSON.stringify(dirty), JSON.stringify(dirtySummary)],
      );
      const dirtied = await db.query<{
        density: Record<string, unknown>;
        summary: Record<string, unknown>;
      }>(
        `SELECT profile->'local_density' AS density,
                profile->'local_density_summary' AS summary
           FROM entities WHERE id = $1`,
        [target.id],
      );
      expect(dirtied.rows[0]!.density).toEqual(dirty);
      expect(dirtied.rows[0]!.summary).toEqual(dirtySummary);

      await db.query(`SELECT rebuild_local_density('grinhaven-full')`);

      const restored = await db.query<{
        density: Record<string, unknown>;
        summary: Record<string, unknown>;
      }>(
        `SELECT profile->'local_density' AS density,
                profile->'local_density_summary' AS summary
           FROM entities WHERE id = $1`,
        [target.id],
      );
      expect(restored.rows[0]!.density).toEqual(target.before_density);
      expect(restored.rows[0]!.summary).toEqual(target.before_summary);
    });
  });

  test('rebuild_local_density inserts a warn diagnostic when topology exceeds the depth-8 cap', async () => {
    await withPristineDb(async (db) => {
      // Build a 10-node chain (depth 0 → depth 9) in an isolated
      // probe cartridge so the diagnostic CTE finds real children
      // past the depth-8 boundary. Without these inserts the warn row
      // must NOT appear, so we assert "exactly one" rather than ">=
      // 1".
      const chainCartridge = 'depth-cap-probe';
      const baseId = 900000;
      for (let depth = 0; depth <= 9; depth++) {
        const id = baseId + depth;
        const parentId = depth === 0 ? null : baseId + depth - 1;
        await db.query(
          `INSERT INTO entities
             (id, kind, display_name, summary, profile, tags,
              cartridge_id, topology_parent_id, dynamic_origin)
           VALUES ($1, 'location', $2, $3, '{}'::jsonb, ARRAY[]::text[],
                   $4, $5, false)`,
          [id, `Depth ${depth}`, `chain depth ${depth}`, chainCartridge, parentId],
        );
      }

      const baseline = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM migration_diagnostics
          WHERE source = 'rebuild_local_density.depth_cap'
            AND level = 'warn'
            AND payload->>'target_cartridge' = $1`,
        [chainCartridge],
      );
      // The 0108 migration already runs rebuild_local_density once
      // against grinhaven-full, which has no depth-9 topology, so the
      // probe cartridge starts with zero warn rows.
      expect(Number(baseline.rows[0]!.count)).toBe(0);

      await db.query(`SELECT rebuild_local_density($1)`, [chainCartridge]);

      const warns = await db.query<{
        root_id: string;
        truncated_child_count: string;
      }>(
        `SELECT
           (payload->>'root_id')::bigint::text AS root_id,
           (payload->>'truncated_child_count')::bigint::text AS truncated_child_count
         FROM migration_diagnostics
         WHERE source = 'rebuild_local_density.depth_cap'
           AND level = 'warn'
           AND payload->>'target_cartridge' = $1
         ORDER BY id ASC`,
        [chainCartridge],
      );
      // Only the chain root (depth 0) reaches depth 8 with a child
      // beyond. Intermediate chain nodes are themselves roots in the
      // CTE seed but their own subtrees do not reach depth 8.
      expect(warns.rows.length).toBe(1);
      expect(Number(warns.rows[0]!.root_id)).toBe(baseId);
      expect(Number(warns.rows[0]!.truncated_child_count)).toBe(1);

      // A flat cartridge with no children must not produce any warn
      // rows.  This guards against the diagnostic over-firing on
      // ordinary topology.
      await db.query(
        `INSERT INTO entities
           (id, kind, display_name, summary, profile, tags,
            cartridge_id, topology_parent_id, dynamic_origin)
         VALUES (910000, 'location', 'Flat', 'single node',
                 '{}'::jsonb, ARRAY[]::text[],
                 'depth-cap-flat', NULL, false)`,
      );
      await db.query(`SELECT rebuild_local_density('depth-cap-flat')`);
      const flatWarns = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM migration_diagnostics
          WHERE source = 'rebuild_local_density.depth_cap'
            AND level = 'warn'
            AND payload->>'target_cartridge' = 'depth-cap-flat'`,
      );
      expect(Number(flatWarns.rows[0]!.count)).toBe(0);
    });
  });

  test('migration_diagnostics table is structured for SQL-emitted warnings', async () => {
    await withPristineDb(async (db) => {
      const columns = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'migration_diagnostics'
          ORDER BY ordinal_position`,
      );
      const byName = new Map(
        columns.rows.map((row) => [row.column_name, row]),
      );
      expect(byName.get('id')?.data_type).toBe('bigint');
      expect(byName.get('recorded_at')?.data_type).toBe(
        'timestamp with time zone',
      );
      expect(byName.get('level')?.data_type).toBe('text');
      expect(byName.get('source')?.data_type).toBe('text');
      expect(byName.get('payload')?.data_type).toBe('jsonb');
      expect(byName.get('level')?.is_nullable).toBe('NO');
      expect(byName.get('source')?.is_nullable).toBe('NO');
      expect(byName.get('payload')?.is_nullable).toBe('NO');

      // CHECK constraint must reject unknown levels — the wrapper
      // queries for level = 'warn' specifically.
      let rejected = false;
      try {
        await db.query(
          `INSERT INTO migration_diagnostics (level, source, payload)
           VALUES ('chatty', 'test', '{}'::jsonb)`,
        );
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  });

  test('T-3 / DEEP-8 — 0111 restamps duplicate (session_id, queue_index) rows and enforces the unique index', async () => {
    // Pre-0111 DB: seed two sessions, each with duplicate queue_index
    // rows that violate the pending unique constraint. Apply 0111 in
    // isolation and assert (a) the restamp uses `row_number() OVER
    // (PARTITION BY session_id ORDER BY queue_index ASC, id ASC)` so
    // each session's rows are renumbered deterministically starting at
    // 1, (b) the unique index now exists, and (c) a subsequent
    // duplicate INSERT fails with the expected constraint name. The
    // restamp must touch BOTH sessions even though the IF EXISTS guard
    // fires once — the migration's UPDATE covers every row.
    await withPristineDb(
      async (db) => {
        const ent1 = await db.query<{ id: number }>(
          `INSERT INTO entities (kind, display_name, profile, tags)
           VALUES ('player', 'T-3 0111 player A', '{}'::jsonb, ARRAY['player'])
           RETURNING id`,
        );
        const ent2 = await db.query<{ id: number }>(
          `INSERT INTO entities (kind, display_name, profile, tags)
           VALUES ('player', 'T-3 0111 player B', '{}'::jsonb, ARRAY['player'])
           RETURNING id`,
        );
        const pA = Number(ent1.rows[0]?.id);
        const pB = Number(ent2.rows[0]?.id);
        await db.query(
          `INSERT INTO sessions (id) VALUES ('t3-0111-A'), ('t3-0111-B')`,
        );
        // Session A: three rows with duplicate queue_index = 5
        //   id ascending → restamps to (1, 2, 3) in id order
        // Session B: two rows with non-duplicate queue_indexes (7, 9)
        //   but only because the IF EXISTS triggers globally, B also
        //   gets restamped to (1, 2) per row_number.
        await db.query(
          `INSERT INTO turn_ingress_queue
             (session_id, player_id, turn_id, text, queue_index)
           VALUES
             ('t3-0111-A', $1, 'a-1', 'a1', 5),
             ('t3-0111-A', $1, 'a-2', 'a2', 5),
             ('t3-0111-A', $1, 'a-3', 'a3', 5),
             ('t3-0111-B', $2, 'b-1', 'b1', 7),
             ('t3-0111-B', $2, 'b-2', 'b2', 9)`,
          [pA, pB],
        );

        await db.applyMigrationFile('0111_turn_ingress_queue_unique_idx.sql');

        const restampedA = await db.query<{
          turn_id: string;
          queue_index: number;
        }>(
          `SELECT turn_id, queue_index FROM turn_ingress_queue
            WHERE session_id = 't3-0111-A' ORDER BY id ASC`,
        );
        expect(restampedA.rows.map((row) => Number(row.queue_index))).toEqual([
          1, 2, 3,
        ]);
        const restampedB = await db.query<{
          turn_id: string;
          queue_index: number;
        }>(
          `SELECT turn_id, queue_index FROM turn_ingress_queue
            WHERE session_id = 't3-0111-B' ORDER BY id ASC`,
        );
        expect(restampedB.rows.map((row) => Number(row.queue_index))).toEqual([
          1, 2,
        ]);

        const index = await db.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'turn_ingress_queue'
              AND indexname = 'turn_ingress_queue_session_queue_idx_uniq'`,
        );
        expect(index.rows.length).toBe(1);

        // Future duplicates must fail under the new unique constraint.
        await expect(
          db.query(
            `INSERT INTO turn_ingress_queue
               (session_id, player_id, turn_id, text, queue_index)
             VALUES ('t3-0111-A', $1, 'a-dup', 'dup', 1)`,
            [pA],
          ),
        ).rejects.toThrow(/turn_ingress_queue_session_queue_idx_uniq/);
      },
      { upToMigration: '0110_safe_jsonb_array_helper.sql' },
    );
  });

  test('T-3 / QE-6 — 0112 normalizes legacy quest advance_on and is idempotent', async () => {
    // Pre-0112: seed a quest entity with one stage carrying the legacy
    // `'manual_or_watcher'` advance_on value plus a control stage that
    // already uses an accepted alias. Apply 0112 and assert (a) only
    // the legacy stage is rewritten, (b) the control stage is
    // untouched, (c) any other stage keys (objectives, id, name) are
    // preserved, and (d) re-applying the migration is a no-op (the
    // EXISTS guard short-circuits).
    await withPristineDb(
      async (db) => {
        const quest = await db.query<{ id: number }>(
          `INSERT INTO entities (kind, display_name, summary, profile, tags)
           VALUES (
             'quest', 'T-3 0112 quest', 'legacy advance_on probe',
             $1::jsonb, ARRAY['quest']
           )
           RETURNING id`,
          [
            JSON.stringify({
              stages: [
                {
                  id: 'open',
                  title: 'Open',
                  advance_on: 'manual_or_watcher',
                  objectives: ['probe'],
                },
                {
                  id: 'closed',
                  title: 'Closed',
                  advance_on: 'any_objective_complete',
                },
              ],
            }),
          ],
        );
        const questId = Number(quest.rows[0]?.id);

        await db.applyMigrationFile('0112_normalize_quest_advance_on.sql');

        const after = await db.query<{ stages: unknown }>(
          `SELECT profile->'stages' AS stages FROM entities WHERE id = $1`,
          [questId],
        );
        const stages = after.rows[0]?.stages as Array<Record<string, unknown>>;
        expect(stages).toEqual([
          {
            id: 'open',
            title: 'Open',
            advance_on: 'all_objectives_complete',
            objectives: ['probe'],
          },
          {
            id: 'closed',
            title: 'Closed',
            advance_on: 'any_objective_complete',
          },
        ]);
        const stragglers = await db.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM entities e,
                  LATERAL jsonb_array_elements(e.profile->'stages') AS s(stage)
            WHERE e.kind = 'quest'
              AND s.stage->>'advance_on' = 'manual_or_watcher'`,
        );
        expect(Number(stragglers.rows[0]?.count)).toBe(0);

        // Idempotence: re-apply does not flip any stage back or write
        // duplicate normalization markers.
        const beforeRerun = await db.query<{ stages: unknown }>(
          `SELECT profile->'stages' AS stages FROM entities WHERE id = $1`,
          [questId],
        );
        await db.query(
          `DELETE FROM schema_migrations WHERE name = $1`,
          ['0112_normalize_quest_advance_on.sql'],
        );
        await db.applyMigrationFile('0112_normalize_quest_advance_on.sql');
        const afterRerun = await db.query<{ stages: unknown }>(
          `SELECT profile->'stages' AS stages FROM entities WHERE id = $1`,
          [questId],
        );
        expect(afterRerun.rows[0]?.stages).toEqual(
          beforeRerun.rows[0]?.stages,
        );
      },
      { upToMigration: '0111_turn_ingress_queue_unique_idx.sql' },
    );
  });

  test('T-3 — 0113 canonicalizes display_name i18n and rewrites localized @ intro bubbles', async () => {
    // Pre-0113: seed a location whose i18n.display_name carries a
    // localized value and a matching localized intro bubble row.
    // Apply 0113 and assert (a) every supported lang in
    // i18n.display_name resolves to the canonical display_name,
    // (b) the intro bubble prefix is rewritten to `@<canonical>` while
    // preserving the rest of the bubble text, and (c) the source
    // column gains the `+canonical_mention` marker so future passes
    // can detect already-rewritten rows.
    await withPristineDb(
      async (db) => {
        const location = await db.query<{ id: number }>(
          `INSERT INTO entities
             (kind, display_name, profile, tags, i18n)
           VALUES (
             'location', 'Lampwright Street', '{}'::jsonb, ARRAY['location'],
             $1::jsonb
           )
           RETURNING id`,
          [
            JSON.stringify({
              display_name: {
                en: 'Lampwright Street',
                ru: 'Улица Фонарщика',
              },
            }),
          ],
        );
        const locationId = Number(location.rows[0]?.id);
        await db.query(
          `INSERT INTO location_intro_bubbles
             (location_entity_id, lang, bubble_text, source)
           VALUES (
             $1, 'ru',
             '@Улица Фонарщика — масляные лампы дрожат на ветру.',
             'seeded_from_location_i18n'
           )`,
          [locationId],
        );

        await db.applyMigrationFile('0113_canonical_display_name_mentions.sql');

        const i18n = await db.query<{ display_name: Record<string, string> }>(
          `SELECT i18n->'display_name' AS display_name
             FROM entities WHERE id = $1`,
          [locationId],
        );
        const names = i18n.rows[0]?.display_name ?? {};
        expect(names['en']).toBe('Lampwright Street');
        expect(names['ru']).toBe('Lampwright Street');
        expect(names['ja']).toBe('Lampwright Street');
        // Sanity: at least the supported_lang set is populated.
        expect(Object.keys(names).length).toBeGreaterThanOrEqual(20);

        const bubble = await db.query<{
          bubble_text: string;
          source: string;
        }>(
          `SELECT bubble_text, source FROM location_intro_bubbles
            WHERE location_entity_id = $1 AND lang = 'ru'`,
          [locationId],
        );
        expect(bubble.rows[0]?.bubble_text).toBe(
          '@Lampwright Street — масляные лампы дрожат на ветру.',
        );
        expect(bubble.rows[0]?.source).toMatch(/\+canonical_mention$/);
      },
      { upToMigration: '0112_normalize_quest_advance_on.sql' },
    );
  });

  test('T-3 / ARCH-9 — 0115 seeds default world_clock and ON CONFLICT preserves a custom one', async () => {
    // The DB at the post-0115 cutoff already has the default seed, so
    // verify default values directly via the pristine template, then
    // verify ON CONFLICT DO NOTHING by replaying the seed in a second
    // pre-0115 fixture that pre-loads a custom value.
    await withPristineDb(async (db) => {
      const defaults = await db.query<{ value: Record<string, unknown> }>(
        `SELECT value FROM cartridge_meta WHERE key = 'world_clock'`,
      );
      expect(defaults.rows.length).toBe(1);
      const value = defaults.rows[0]?.value ?? {};
      expect(Number(value['tick_minutes'])).toBe(10);
      expect(Number(value['default_minutes'])).toBe(450);
    });

    await withPristineDb(
      async (db) => {
        // Pre-0115 fixture: seed a custom world_clock first, then run
        // the migration and assert the existing row was preserved.
        await db.query(
          `INSERT INTO cartridge_meta (key, value, description)
           VALUES (
             'world_clock',
             $1::jsonb,
             'custom world clock seeded before 0115 ran'
           )`,
          [JSON.stringify({ tick_minutes: 30, default_minutes: 600 })],
        );

        await db.applyMigrationFile('0115_cartridge_world_clock_meta.sql');

        const preserved = await db.query<{
          value: Record<string, unknown>;
          description: string | null;
        }>(
          `SELECT value, description FROM cartridge_meta
            WHERE key = 'world_clock'`,
        );
        const customValue = preserved.rows[0]?.value ?? {};
        expect(Number(customValue['tick_minutes'])).toBe(30);
        expect(Number(customValue['default_minutes'])).toBe(600);
        expect(preserved.rows[0]?.description).toBe(
          'custom world clock seeded before 0115 ran',
        );
      },
      { upToMigration: '0114_adventure_queue_counters.sql' },
    );
  });

  test('adventure_queue_counters covers every existing adventure_queue (session, player)', async () => {
    // AQ-2 — migration 0114 introduces the per-(session_id, player_id)
    // adventure sequence counter and backfills it from any pre-existing
    // adventure_queue rows. The invariant: for every existing
    // adventure_queue row, there must be a counter whose last_sequence
    // is at least the row's sequence. The query below returns any
    // adventure_queue row whose (session_id, player_id) either lacks a
    // counter entry or has a counter trailing behind the row. The
    // pristine fixture has no historical adventures, so the gap query
    // must return an empty result regardless of whether the counter
    // table is empty.
    await withPristineDb(async (db) => {
      const gaps = await db.query<{
        session_id: string;
        player_id: number | string;
        sequence: number | string;
      }>(`
        SELECT aq.session_id, aq.player_id, aq.sequence
          FROM adventure_queue aq
         WHERE NOT EXISTS (
           SELECT 1
             FROM adventure_queue_counters c
            WHERE c.session_id = aq.session_id
              AND c.player_id = aq.player_id
              AND c.last_sequence >= aq.sequence
         )
         LIMIT 20
      `);
      expect(gaps.rows).toEqual([]);
    });
  });
});
