/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-ENGINE-BASELINE-2 — engine baseline generator.
//
// Reads the migration inventory (FEAT-ENGINE-BASELINE-1) and the
// migration files, concatenates the engine-only payloads into
// `packages/web-server/baseline/0001_engine_baseline.sql`, and elides
// authored cartridge content from the small set of mixed migrations
// (0018, 0029, 0032, 0033, 0125, 0107). Migrations classified as
// `cartridge_world_content`, `dev_repair_audit`, or
// `obsolete_compatibility` are excluded entirely.
//
// The output is a deterministic single SQL file the baseline test
// (`engineBaseline.test.ts`) can apply to a fresh PGlite database
// alongside the vector extension, with no authored Greenhaven world
// rows landing.

import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_DIR = path.resolve(__dirname, '..', '..');
// FEAT-ENGINE-BASELINE-3 — historical migrations now live under
// `migrations/archive-prebaseline/`. The baseline generator continues
// to read from that directory.
const MIGRATIONS_DIR = path.join(PACKAGE_DIR, 'migrations', 'archive-prebaseline');
const BASELINE_DIR = path.join(PACKAGE_DIR, 'baseline');
const BASELINE_PATH = path.join(BASELINE_DIR, '0001_engine_baseline.sql');
const INVENTORY_PATH = path.resolve(
  PACKAGE_DIR,
  '..',
  '..',
  'docs',
  'db',
  'engine-baseline-migration-inventory.md',
);

const BASELINE_VERSION = 'baseline-0001-engine';
const KEEP_CLASSIFICATIONS = new Set(['engine_schema', 'engine_system_seed']);

interface InventoryRow {
  filename: string;
  classification: string;
}

// Elision rules — minimal, targeted text spans that must be stripped
// from each mixed migration. Each rule replaces an exact string match.
// The generator throws if a rule does not find its target so the
// elision contract stays in sync with the source migrations.
type ElisionRule = {pattern: string};

const ELISIONS: Record<string, ElisionRule[]> = {
  // 0018 — drop the quickgrin-specific cartridge_meta seed values.
  '0018_cartridge_meta.sql': [
    {
      pattern: `INSERT INTO cartridge_meta (key, value, description) VALUES
  ('cartridge_id',
     '"quickgrin-lane"'::jsonb,
     'Identifier of the active cartridge.'),
  ('cartridge_version',
     '"0.1.0"'::jsonb,
     'Cartridge schema/content version.'),
  ('starting_location_id',
     '100'::jsonb,
     'entity_id where new players spawn.'),
  ('starting_scene_id',
     'null'::jsonb,
     'Optional entity_id for an initial scene anchor; null = no scene pin.'),
  ('default_class_id',
     '600'::jsonb,
     'class entity_id used at anonymous-create.'),
  ('currency_item_id',
     '300'::jsonb,
     'entity_id of the canonical currency item.'),
  ('starting_currency_count',
     '100'::jsonb,
     'Amount of currency given to new players.'),
  ('reset_inventory_seeds',
     '[{"holder_entity_id":200,"item_entity_id":300,"count":0}]'::jsonb,
     'Inventory rows to UPSERT on /api/debug/reset-world (cartridge-specific intake bags).'),
  ('reset_runtime_overrides',
     '[{"field_id":2101,"value":"pricing"},{"field_id":2102,"value":"dark"}]'::jsonb,
     'runtime_values to force-write on /api/debug/reset-world (cartridge-initial state).')
ON CONFLICT (key) DO NOTHING;`,
    },
  ],

  // 0029 — keep ALTER TABLE player_quests, drop both Mikka quest seed
  // operations.
  '0029_quest_schema.sql': [
    {
      pattern: `UPDATE entities SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
  'tags', jsonb_build_array('intimacy'),
  'partner', 'Mikka Quickgrin',
  'stages', jsonb_build_array(
    jsonb_build_object(
      'id', 'initiation',
      'name', 'Initiation',
      'description', 'The active player commits to the encounter - pays in coin or in body, signs the deal.',
      'objectives', jsonb_build_array(
        jsonb_build_object('kind', 'tool_called', 'tool', 'string_award',
          'args_match', jsonb_build_object('npc', 'Mikka Quickgrin', 'delta_min', 1))
      ),
      'advance_on', 'all_objectives_complete',
      'next_stage', 'escalation'
    ),
    jsonb_build_object(
      'id', 'escalation',
      'name', 'Escalation',
      'description', 'The encounter intensifies; Mikka becomes vocal.',
      'objectives', jsonb_build_array(
        jsonb_build_object('kind', 'field_threshold', 'owner_entity_id', 200,
          'field_key', 'arousal_level', 'op', '>=', 'value', 50)
      ),
      'advance_on', 'all_objectives_complete',
      'next_stage', 'climax'
    ),
    jsonb_build_object(
      'id', 'climax',
      'name', 'Mutual climax',
      'description', 'Both parties reach the peak.',
      'objectives', jsonb_build_array(
        jsonb_build_object('kind', 'field_threshold', 'owner_entity_id', 200,
          'field_key', 'satisfaction_level', 'op', '>=', 'value', 90)
      ),
      'advance_on', 'all_objectives_complete',
      'next_stage', null
    )
  ),
  'rewards', jsonb_build_object(
    'xp', 75,
    'strings', jsonb_build_array(jsonb_build_object('npc', 'Mikka Quickgrin', 'delta', 1)),
    'memory', jsonb_build_object(
      'owner', 'Mikka Quickgrin', 'about', NULL,
      'text', 'A real one. Paid in body and felt every coin.',
      'importance', 0.85
    ),
    'sex_move_eligible', true
  ),
  'failure_conditions', jsonb_build_array(
    jsonb_build_object('kind', 'field_threshold', 'owner_entity_id', 200,
      'field_key', 'mood_string', 'op', '==', 'value', 'reluctant')
  )
) WHERE display_name = 'Mikka''s Private Price' AND kind = 'quest';`,
    },
    {
      pattern: `INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES (
  700, 'quest', 'Mikka''s Trust',
  'Earn enough strings on Mikka without sleeping with her to unlock a permanent info-broker discount.',
  jsonb_build_object(
    'tags', jsonb_build_array('social'),
    'partner', 'Mikka Quickgrin',
    'stages', jsonb_build_array(
      jsonb_build_object(
        'id', 'first-string',
        'name', 'First trust earned',
        'description', 'The active player earns their first string on Mikka through helpful action, not seduction.',
        'objectives', jsonb_build_array(
          jsonb_build_object('kind', 'string_threshold', 'npc', 'Mikka Quickgrin',
            'op', '>=', 'value', 1)
        ),
        'advance_on', 'all_objectives_complete',
        'next_stage', 'second-string'
      ),
      jsonb_build_object(
        'id', 'second-string',
        'name', 'Trust deepens',
        'description', 'The bond grows beyond a single moment of leverage.',
        'objectives', jsonb_build_array(
          jsonb_build_object('kind', 'string_threshold', 'npc', 'Mikka Quickgrin',
            'op', '>=', 'value', 3)
        ),
        'advance_on', 'all_objectives_complete',
        'next_stage', null
      )
    ),
    'rewards', jsonb_build_object(
      'xp', 50,
      'memory', jsonb_build_object(
        'owner', 'Mikka Quickgrin', 'about', NULL,
        'text', 'Earned my trust without bedding me. Worth keeping around.',
        'importance', 0.75
      ),
      'permanent_field_patches', jsonb_build_array(
        jsonb_build_object('owner_entity_id', 200, 'field_key', 'info_discount_for_player', 'value', true)
      )
    ),
    'failure_conditions', '[]'::jsonb
  ),
  ARRAY['quest', 'social', 'mikka-arc']::text[]
)
ON CONFLICT (id) DO NOTHING;`,
    },
  ],

  // 0010 — keep CREATE TABLE npc_stats; drop the Mikka (entity 200)
  // ability-score, AC, and proficiency_bonus seed rows. The schema
  // is engine; the values are cartridge.
  '0010_npc_stats.sql': [
    {
      pattern: `-- Mikka Quickgrin — goblin broker. Light frame, sharp tongue.
-- Reads & negotiates better than she fights. Quick on her feet
-- (DEX 14 = +2 to-hit with light blades, +2 AC) but no muscle to
-- speak of (STR 8 = -1).
INSERT INTO npc_stats (npc_entity_id, stat_key, base, current) VALUES
  (200, 'STR', 8,  8),
  (200, 'DEX', 14, 14),
  (200, 'CON', 11, 11),
  (200, 'INT', 12, 12),
  (200, 'WIS', 13, 13),
  (200, 'CHA', 14, 14)
ON CONFLICT (npc_entity_id, stat_key) DO NOTHING;

-- Mikka's armour class. Light leather + DEX bonus = 13.
INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, scope, scope_per_player, description)
VALUES
  (2202, 200, 'armor_class', 'int', '13'::jsonb, 'session', false,
   'Mikka''s AC. Attack rolls vs Mikka use this as DC.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (2202, '13'::jsonb, 'cartridge_seed')
ON CONFLICT (field_id) DO NOTHING;

-- Proficiency bonus (D&D 5e: +2 at levels 1-4). Stored as a runtime
-- field so it can scale with NPC level if we ever introduce one.
INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, scope, scope_per_player, description)
VALUES
  (2203, 200, 'proficiency_bonus', 'int', '2'::jsonb, 'session', false,
   'Mikka''s proficiency bonus added to checks she''s trained in.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (2203, '2'::jsonb, 'cartridge_seed')
ON CONFLICT (field_id) DO NOTHING;`,
    },
  ],

  // 0032 — keep CREATE TABLE player_proficient_skills; drop the
  // class 600 backfill and the class 601 (Rogue) seed.
  '0032_class_profile_and_stats.sql': [
    {
      pattern: `-- Class 600 (Fighter) — backfill profile.
UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
         'hit_die', 10,
         'saving_throws', jsonb_build_array('STR', 'CON'),
         'skill_choices', jsonb_build_object(
           'from', jsonb_build_array(
             'Acrobatics', 'Animal Handling', 'Athletics', 'History',
             'Insight', 'Intimidation', 'Perception', 'Survival'
           ),
           'pick', 2
         ),
         'starting_equipment', jsonb_build_array(),
         'level_1_features', jsonb_build_array('Second Wind', 'Fighting Style')
       )
 WHERE id = 600 AND kind = 'class';`,
    },
    {
      pattern: `-- Class 601 (Rogue) — seed if missing.
INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES (
  601, 'class', 'Rogue',
  'Quick-witted, light-stepping operator. Lives by sleight of hand and the right word at the right moment.',
  jsonb_build_object(
    'hit_die', 8,
    'saving_throws', jsonb_build_array('DEX', 'INT'),
    'skill_choices', jsonb_build_object(
      'from', jsonb_build_array(
        'Acrobatics', 'Athletics', 'Deception', 'Insight', 'Intimidation',
        'Investigation', 'Perception', 'Performance', 'Persuasion',
        'Sleight of Hand', 'Stealth'
      ),
      'pick', 4
    ),
    'starting_equipment', jsonb_build_array(),
    'level_1_features', jsonb_build_array('Expertise', 'Sneak Attack', 'Thieves Cant')
  ),
  ARRAY['class', 'dex-based']::text[]
)
ON CONFLICT (id) DO NOTHING;`,
    },
  ],

  // 0033 — drop runtime_fields + runtime_values + atmosphere_presets
  // that hard-code the cartridge WORLD entity id=10 (those rows fail
  // the runtime_fields.owner_entity_id FK on an empty baseline).
  // Keep the portrait_set scaffold UPDATE: it's a no-op on empty
  // entities but documents the schema convention.
  '0033_npc_portraits_and_world_atmosphere.sql': [
    {
      pattern: `INSERT INTO runtime_fields
  (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
VALUES
  (10010, 10, 'time_of_day', 'string', '"dusk"'::jsonb, NULL,
    'session', false,
    'World time-of-day. Rotates: dawn → morning → noon → afternoon → dusk → night → midnight → dawn.'),
  (10011, 10, 'weather', 'string', '"clear"'::jsonb, NULL,
    'session', false,
    'World weather: clear, overcast, rain, fog, storm, smog (post-industrial signal).'),
  (10012, 10, 'world_time_minutes', 'int', '450'::jsonb, NULL,
    'session', false,
    'World time accumulator (minutes since session start). Drives time_of_day.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO runtime_values (field_id, value, source) VALUES
  (10010, '"dusk"'::jsonb, 'init'),
  (10011, '"clear"'::jsonb, 'init'),
  (10012, '450'::jsonb, 'init')
ON CONFLICT (field_id) DO NOTHING;

INSERT INTO cartridge_meta (key, value, description)
VALUES (
  'atmosphere_presets',
  jsonb_build_object(
    'time_palettes', jsonb_build_object(
      'dawn',      jsonb_build_object('tint', '350 60% 70%', 'particle', 'mist'),
      'morning',   jsonb_build_object('tint', '50 70% 75%',  'particle', null),
      'noon',      jsonb_build_object('tint', '210 30% 92%', 'particle', null),
      'afternoon', jsonb_build_object('tint', '40 50% 80%',  'particle', 'dust'),
      'dusk',      jsonb_build_object('tint', '20 70% 55%',  'particle', 'embers'),
      'night',     jsonb_build_object('tint', '230 40% 35%', 'particle', null),
      'midnight',  jsonb_build_object('tint', '250 50% 18%', 'particle', null)
    ),
    'weather_palettes', jsonb_build_object(
      'clear',    jsonb_build_object('overlay', null,                  'particle', null),
      'overcast', jsonb_build_object('overlay', '220 10% 35% / 0.15', 'particle', null),
      'rain',     jsonb_build_object('overlay', '210 30% 25% / 0.25', 'particle', 'rain'),
      'fog',      jsonb_build_object('overlay', '0 0% 80% / 0.2',     'particle', 'mist'),
      'storm',    jsonb_build_object('overlay', '230 30% 18% / 0.35', 'particle', 'rain'),
      'smog',     jsonb_build_object('overlay', '30 40% 30% / 0.2',   'particle', 'smog')
    )
  ),
  'Per-cartridge atmospheric palette. UI mixes time + weather presets to compute the chat background tint and active particle layer.'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
    },
  ],

  // 0104 — drop the SELECT rebuild_local_density('grinhaven-full')
  // call. Function definition stays; the trailing apply call assumes
  // grinhaven-full content that does not exist on a clean baseline.
  '0104_density_rebuild_function.sql': [
    {
      pattern: `-- Apply once against the active fixture cartridge. On a fresh database
-- that has just run 0091-0094 the inputs are unchanged, so this call is
-- a state-preserving no-op (idempotence is a tested invariant).
SELECT rebuild_local_density('grinhaven-full');`,
    },
  ],

  // 0107 — drop the SELECT rebuild_local_density('grinhaven-full')
  // call. Function definition + density_caps seed remain. The trailing
  // call would touch a populated cartridge that does not exist on a
  // clean baseline.
  '0107_density_caps_parameterized.sql': [
    {
      pattern: `-- Apply once against the active fixture cartridge using the seeded
-- defaults. On a database that has already passed 0104 this is a
-- state-preserving no-op (the algorithm is deterministic in cap
-- values and inputs).
SELECT rebuild_local_density('grinhaven-full');`,
    },
  ],

  // 0125 — drop the entire FEAT-CART-LIB-1 backfill DO $$ ... END $$
  // block (it copies legacy cartridge_meta into the new cartridges +
  // cartridge_meta_scoped tables; on a baseline there is nothing to
  // backfill so the block is a no-op anyway, but it also references
  // `players` rows which do not exist).
  '0125_cartridge_library.sql': [
    {
      pattern: `DO $$
DECLARE
  v_cartridge_id  TEXT;
  v_version       TEXT;
  v_title         TEXT;
BEGIN
  SELECT (value #>> '{}')::text INTO v_cartridge_id
    FROM cartridge_meta WHERE key = 'cartridge_id';
  IF v_cartridge_id IS NULL OR length(v_cartridge_id) = 0 THEN
    v_cartridge_id := 'default';
  END IF;

  SELECT (value #>> '{}')::text INTO v_version
    FROM cartridge_meta WHERE key = 'cartridge_version';
  IF v_version IS NULL OR length(v_version) = 0 THEN
    v_version := '0.0.0';
  END IF;

  v_title := v_cartridge_id;

  INSERT INTO cartridges (
    id, title, version, schema_version, source_kind, source_path,
    content_hash, manifest, validation_report, status
  )
  VALUES (
    v_cartridge_id,
    v_title,
    v_version,
    '1',
    'builtin',
    NULL,
    'legacy:' || v_cartridge_id,
    '{}'::jsonb,
    '{}'::jsonb,
    'installed'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Mirror every legacy \`cartridge_meta\` row into the scoped
  -- table under the active cartridge id. Skip rows already
  -- present (re-running this migration must be a no-op).
  INSERT INTO cartridge_meta_scoped (cartridge_id, key, value, description)
  SELECT v_cartridge_id, cm.key, cm.value, cm.description
    FROM cartridge_meta cm
    WHERE NOT EXISTS (
      SELECT 1 FROM cartridge_meta_scoped s
       WHERE s.cartridge_id = v_cartridge_id AND s.key = cm.key
    );

  -- Backfill every existing player as \`available\` on the default
  -- cartridge, carrying their current location/scene. We don't
  -- touch \`players.current_location_id\` itself — gameplay still
  -- reads from there. This is purely a parallel record so the
  -- library API has something to show on day one.
  INSERT INTO hero_cartridge_states (
    player_id, cartridge_id, status,
    current_location_id, current_scene_id,
    snapshot, compatibility_report
  )
  SELECT
    p.entity_id,
    v_cartridge_id,
    'available',
    p.current_location_id,
    p.current_scene_id,
    '{}'::jsonb,
    '{}'::jsonb
  FROM players p
  WHERE NOT EXISTS (
    SELECT 1 FROM hero_cartridge_states h
     WHERE h.player_id = p.entity_id
       AND h.cartridge_id = v_cartridge_id
  );
END $$;`,
    },
  ],
};

async function parseInventory(): Promise<InventoryRow[]> {
  const md = await readFile(INVENTORY_PATH, 'utf8');
  const rows: InventoryRow[] = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('| `0')) continue;
    const cells = t
      .slice(1, t.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const filename = cells[0]?.replace(/`/g, '').trim() ?? '';
    const classification = cells[1] ?? '';
    if (!filename.endsWith('.sql')) continue;
    rows.push({filename, classification});
  }
  return rows;
}

async function loadMigrationFiles(): Promise<Set<string>> {
  const all = await readdir(MIGRATIONS_DIR);
  return new Set(all.filter((f) => f.endsWith('.sql')));
}

function applyElisions(filename: string, sql: string): string {
  const rules = ELISIONS[filename];
  if (!rules) return sql;
  let out = sql;
  for (const rule of rules) {
    if (!out.includes(rule.pattern)) {
      throw new Error(
        `[build-engine-baseline] elision rule for ${filename} did not match — has the source migration changed? Re-author the elision pattern.`,
      );
    }
    out = out.replace(
      rule.pattern,
      `-- [engine-baseline] elided: cartridge content removed for clean baseline.\n`,
    );
  }
  return out;
}

const HEADER = `-- packages/web-server/baseline/0001_engine_baseline.sql
--
-- FEAT-ENGINE-BASELINE-2 — clean engine-only baseline.
--
-- Generated by packages/web-server/src/scripts/build-engine-baseline.ts
-- from the engine_schema + engine_system_seed migrations listed in
-- docs/db/engine-baseline-migration-inventory.md. Cartridge-only and
-- repair-only migrations are excluded; mixed migrations have their
-- authored-content lines elided.
--
-- DO NOT edit by hand. Regenerate via:
--   npm --prefix packages/web-server exec -- tsx \\\\
--     src/scripts/build-engine-baseline.ts
--
-- Application: this file expects a fresh PGlite database with the
-- vector extension already created and the schema_migrations
-- bookkeeping table already present. The bootstrap helper in
-- packages/web-server/src/__tests__/migrations/engineBaseline.test.ts
-- demonstrates the contract; production startup will move to a
-- similar helper in FEAT-ENGINE-BASELINE-3.
--
-- Authored Greenhaven world content (grinhaven-full, Obsidian
-- patches, quickgrin, robot-empty) is NOT installed here. The
-- cartridge install pipeline (FEAT-CART-LIB) owns that.

`;

async function main(): Promise<void> {
  await mkdir(BASELINE_DIR, {recursive: true});
  const inventory = await parseInventory();
  const existing = await loadMigrationFiles();
  const missing = inventory.filter((r) => !existing.has(r.filename));
  if (missing.length > 0) {
    throw new Error(
      `[build-engine-baseline] inventory references migrations missing from disk: ${missing
        .map((m) => m.filename)
        .join(', ')}`,
    );
  }

  const keep = inventory.filter((r) => KEEP_CLASSIFICATIONS.has(r.classification));
  const chunks: string[] = [HEADER];

  for (const row of keep) {
    const sqlPath = path.join(MIGRATIONS_DIR, row.filename);
    const raw = await readFile(sqlPath, 'utf8');
    const transformed = applyElisions(row.filename, raw);
    chunks.push(`-- ── ${row.filename} (${row.classification}) ────────────\n`);
    chunks.push(transformed.trimEnd());
    chunks.push('\n\n');
  }

  // Record the baseline version in schema_migrations so the runtime
  // and tests can detect that the baseline has been applied (FEAT-
  // ENGINE-BASELINE-3 will use this row as the bootstrap marker).
  chunks.push(`-- ── baseline bookkeeping ──────────────────────────────\n`);
  chunks.push(
    `INSERT INTO schema_migrations (name) VALUES ('${BASELINE_VERSION}')\n` +
      `  ON CONFLICT (name) DO NOTHING;\n`,
  );

  const out = chunks.join('');
  await writeFile(BASELINE_PATH, out, 'utf8');

  // eslint-disable-next-line no-console
  console.log(
    `[build-engine-baseline] wrote ${BASELINE_PATH} (${out.length} bytes, ${keep.length} migrations).`,
  );
}

const isDirect = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(__filename)
  : false;
if (isDirect) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[build-engine-baseline] FATAL', err);
    process.exit(1);
  });
}

export {main as buildEngineBaseline, BASELINE_PATH, BASELINE_VERSION};
