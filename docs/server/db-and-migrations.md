# Database & migrations

The DB layer is dual-backend: PGlite for local dev, Postgres via `pg.Pool` when
`DATABASE_URL` is set. Both speak Postgres-wire so the SQL is identical. Schema
is owned by ordered SQL migration files.

## Backend selection

Selected once at first DB call by
[packages/web-server/src/db.ts:57-103](../../packages/web-server/src/db.ts#L57-L103).

| Condition            | Backend                         | Notes                                                                                                                                                      |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` set   | `pg.Pool` (Postgres)            | `PGPOOL_MAX` controls pool size (default 30). `PGSSL_REJECT_UNAUTHORIZED=0` allows self-signed. `CREATE EXTENSION IF NOT EXISTS vector;` at first connect. |
| `DATABASE_URL` unset | PGlite (`@electric-sql/pglite`) | Data dir = `PGLITE_DATA_DIR` or `<server>/pgdata/`. `vector` extension via `@electric-sql/pglite/vector`.                                                  |

Public API
([packages/web-server/src/db.ts](../../packages/web-server/src/db.ts)):

- `query<T>(sql, params?) → Promise<{rows, rowCount}>` — parameterised single
  statement.
- `execMulti(sql)` — multi-statement batch, used by the migration runner.
  `query()` would refuse multi-statement input.
- `withTransaction(fn)` — runs `fn` inside `BEGIN/COMMIT`. PGlite auto-rolls
  failures; pg rolls back via `ROLLBACK`. Nested calls participate in the
  active transaction via `SAVEPOINT`/`RELEASE`/`ROLLBACK TO`; see
  [`docs/backend/transactions.md`](../backend/transactions.md) for the full
  contract (savepoint identifiers, commit/rollback hook scoping, no
  independent inner commit).
- `dbHealth()` — used by `/api/db/health`; reports backend, Postgres version,
  pgvector loaded.
- `getConnectivity()` — `'unknown' | 'ok' | 'error'` plus `lastError`. The
  bridge can render a "DB offline" badge without flipping into error mode.

Switching backends mid-session is unsupported — restart with the new env to
switch.

## Migration runner

Runs once on server startup, called from
[packages/web-server/src/index.ts](../../packages/web-server/src/index.ts).
Implementation:
[packages/web-server/src/migrate.ts](../../packages/web-server/src/migrate.ts).

Algorithm
([packages/web-server/src/migrate.ts:32-87](../../packages/web-server/src/migrate.ts#L32-L87)):

1. `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now());`
   — idempotent bookkeeping bootstrap.
2. `readdir(migrations/)` filtered to `*.sql`, sorted lex.
3. `SELECT name FROM schema_migrations` → applied set.
4. For each file not in applied: read SQL, wrap in `BEGIN; ${sql}; COMMIT;`, run
   via `execMulti`. On success insert into `schema_migrations`. On failure,
   throw.
5. Returns `{applied, skipped}`.

Conventions:

- **No down-migrations.** Fix forward — write `0050_*.sql` to undo `0049_*.sql`.
  The complexity of bidirectional migrations isn't worth it for a single-author
  codebase.
- **Idempotent SQL where possible.** `CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`.
  Re-running any migration manually shouldn't break the DB.
- **Cartridge Content Decoupled from Migrations:** Authored world content (locations, NPCs, quests, item definitions, dialogue pools, i18n translations) is **never** seeded via migrations. The database schema represents a unified consolidated DDL engine baseline. Cartridges are dynamically compiled from Obsidian vaults via the Cartridge Forge compiler and imported in-game via transactions using the import/apply services.
- **Consolidated Baseline DDL:** A fresh database starts entirely blank and executes `packages/web-server/baseline/0001_engine_baseline.sql` to establish empty engine-owned tables. Pre-baseline migrations (128 historical migrations) are fully archived under `packages/web-server/migrations/archive-prebaseline/` and are bypassed for release builds. Post-baseline deltas append to the schema.
- **No Autoincrement Seed Collision:** Dynamic entities are assigned standard unique identifiers without reserved static sequence offsets. Authored cartridge record primary keys are assigned and mapped dynamically during cartridge import, ensuring absolute isolation between different installed worlds and running playthroughs.

## Migration index

Each migration's purpose, in lex order:

| File                                                                      | Purpose                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0001_cartridge.sql`                                                      | Bootstrap world schema. Tables: `entities`, `runtime_fields`, `runtime_values`, `transitions`, `tool_invocations`, `chat_messages`, `players`, `sessions`, `cartridge_meta`, `npc_memories`. The cartridge IS the world. |
| `0002_litrpg.sql`                                                         | LitRPG layer: `player_stats` (long-format, skill-name keyed), XP curve, ability mods.                                                                                                                                    |
| `0003_seed_quickgrin.sql`                                                 | First cartridge: Quickgrin Lane (location 100), Mikka the goblin (NPC 200), Velvet Booths scene, payment recipe.                                                                                                         |
| `0004_sequence_fix.sql`                                                   | Push `entities_id_seq` past the seeded id ranges so dynamic creates don't collide.                                                                                                                                       |
| `0005_fix_payment_recipe.sql`                                             | Rewrite the cartridge's PAYMENT-ACCEPTED recipe to reference real registered tool signatures.                                                                                                                            |
| `0006_location_exits.sql`                                                 | Adjacency between Quickgrin Lane and the Velvet Booths so `query_player_state` can surface them as `@`-mention travel options.                                                                                           |
| `0007_dialogue_mode.sql`                                                  | Dialogue-vs-ambient model: locations are broadcast channels, NPCs are focus modes. Adds `active_dialogue_partner_id` runtime field.                                                                                      |
| `0008_entity_aliases.sql`                                                 | Alternate names for entities so models can call them in any language and still hit a buttonable `@`-mention.                                                                                                             |
| `0009_npc_hp.sql`                                                         | Convention: every damageable NPC declares `current_hp` + `max_hp` runtime fields, both global scope.                                                                                                                     |
| `0010_npc_stats.sql`                                                      | NPC ability scores, AC, proficiency bonus stored on `npc_stats`.                                                                                                                                                         |
| `0011_ability_checks.sql`                                                 | D&D-style `ability_check` conventions on items and NPCs (pick-lock, intimidate, etc.).                                                                                                                                   |
| `0012_dice_cooldowns.sql`                                                 | Per-(player, target_id, check_kind) 24h cooldown to gate skill checks. Combat bypasses.                                                                                                                                  |
| `0013_status_effects.sql`                                                 | Combat status effects on NPCs (stunned, prone).                                                                                                                                                                          |
| `0014_player_status.sql`                                                  | Mirror of 0013 on the player.                                                                                                                                                                                            |
| `0015_turn_telemetry.sql`                                                 | Per-(turn, role) cost + latency tracking. Broker and narrator are separate rows.                                                                                                                                         |
| `0016_telemetry_player.sql`                                               | Add `player_id` to `turn_telemetry` for per-user usage admin.                                                                                                                                                            |
| `0017_i18n.sql`                                                           | Canonical i18n map for cartridge text.                                                                                                                                                                                   |
| `0018_cartridge_meta.sql`                                                 | Engine ↔ cartridge decoupling. Starting location, currency item, etc. moved out of code into `cartridge_meta`.                                                                                                          |
| `0019_quiet_lantern_inn.sql`                                              | Cartridge content: Quiet Lantern Inn location adjacent to Quickgrin Lane.                                                                                                                                                |
| `0020_full_npc_reset.sql`                                                 | Reset NPC seed data to canonical state after iterative tweaks.                                                                                                                                                           |
| `0021_world_entity.sql`                                                   | Add a `kind='world'` entity carrying global cartridge-level instructions and tone.                                                                                                                                       |
| `0022_world_adult_tone.sql`                                               | Correct world entity narrator_brief to 21+.                                                                                                                                                                              |
| `0023_item_i18n.sql`                                                      | RU/JA translations for Heavy Crate (302) and Vendor's Cart (303).                                                                                                                                                        |
| `0024_entity_i18n.sql`                                                    | RU + JA translations for all named entities. Moves cartridge.ts ENTITY_I18N into SQL.                                                                                                                                    |
| `0025_player_default_name_i18n.sql`                                       | Localised default display_name for new anonymous players.                                                                                                                                                                |
| `0026_conditions_field.sql`                                               | Spec 17 — `conditions` JSONB array runtime field on every `kind='person'` entity.                                                                                                                                        |
| `0027_strings_field.sql`                                                  | Spec 18 — `strings` JSONB on every `kind='person'`. Emotional leverage between player and NPC.                                                                                                                           |
| `0028_sex_moves_and_trauma.sql`                                           | Spec 20 — per-NPC `profile.sex_move` + per-player trauma counter.                                                                                                                                                        |
| `0029_quest_schema.sql`                                                   | Spec 21 — quest authoring contract. Stage tracking, scratchpad, path-taken on `player_quests`.                                                                                                                           |
| `0030_quest_mechanics_examples.sql`                                       | Spec 24 — extend Mikka's Trust quest with prerequisites + per-stage bargain.                                                                                                                                             |
| `0031_player_profile_schema.sql`                                          | Spec 26 — player profile schema (background, alignment, etc.).                                                                                                                                                           |
| `0032_class_profile_and_stats.sql`                                        | Spec 27 — class profile + skill-name-keyed proficiency.                                                                                                                                                                  |
| `0033_npc_portraits_and_world_atmosphere.sql`                             | Portrait URLs on NPCs; world atmosphere config (time-of-day, weather seed).                                                                                                                                              |
| `0034_surfaces_and_inspiration.sql`                                       | Spec 33 — surfaces (DOS:OS-style env effects) + Inspiration (BG3-style).                                                                                                                                                 |
| `0035_memory_salience.sql`                                                | Spec 34 — `npc_memories.salience` for ranked retrieval. Computed at create-time from importance, bumped on reference.                                                                                                    |
| `0036_npc_initiative_profile.sql`                                         | Spec 34 — initiative tuning per NPC (Mikka aggressive, Borek patient).                                                                                                                                                   |
| `0037_combat_state.sql`                                                   | `death_save_failures` (0..3) on player.                                                                                                                                                                                  |
| `0038_inventory_categories.sql`                                           | Spec 35 — six baseline cartridge items + per-player inventory beyond Gold Coin.                                                                                                                                          |
| `0039_scripted_intimacy_rules.sql`                                        | Spec 35 — scripted intimacy rules. Mode-classifier intimacy + trigger tag fires field_patches + string_delta + trauma_tag.                                                                                               |
| `0040_i18n_translations.sql`                                              | Mechanic labels: condition slugs, surface names, dice categories, in RU/JA.                                                                                                                                              |
| `0041_xp_levels.sql`                                                      | XP curve table; level-scaled proficiency bonus.                                                                                                                                                                          |
| `0042_save_slots.sql`                                                     | Spec 31 — `save_slots` table for game-state snapshots.                                                                                                                                                                   |
| `0043_dialogue_partner_and_extensions.sql`                                | Per-player `active_dialogue_partner_id` overlay + dialogue extensions.                                                                                                                                                   |
| `0044_persona_registry.sql`                                               | Spec 37 — `persona_archetypes` table; entities reference via `persona_slug`.                                                                                                                                             |
| `0045_directive_tags_audio_quotes.sql`                                    | Spec 37 §2/3/8 — directive tag types, ambient beds, loading-quote pool, time-of-day i18n.                                                                                                                                |
| `0046_inventory_consolidation.sql`                                        | Consolidate dual inventory systems found by the spec-35 audit; canonical `inventory_entries`.                                                                                                                            |
| `0047_noticed_directive.sql`                                              | Spec 32 — diegetic `noticed` directive tag (the NPC heard that).                                                                                                                                                         |
| `0048_origin_templates.sql`                                               | Spec 28 — BG3-style preset gate. Cartridge ships 3-5 archetypes for the wizard.                                                                                                                                          |
| `0049_examiner_classes.sql`                                               | Spec 38 — examiner-character-creation classes (Fighter 600, Rogue 601).                                                                                                                                                  |
| `0050_fix_borek_sex_move_effect_args.sql`                                 | Fix Borek's `profile.sex_move.effect_args` to the current `apply_runtime_field_patch` contract.                                                                                                                          |
| `0051_turn_telemetry_session_id_text.sql`                                 | Align `turn_telemetry.session_id` to the opaque text session id contract used by sessions, chat, and tool audit rows.                                                                                                    |
| `0052`-`0058`                                                             | Session reset, GUI event ordering, adventure queue, and intimacy cleanup migrations; see file names for exact scope.                                                                                                     |
| `0059_world_fact_ownership_metadata.sql`                                  | Adds topology/ownership/access metadata for core cartridge locations so dynamic world-fact guards can validate private/hidden spawned places.                                                                            |
| `0060_performance_events.sql`                                             | Durable performance spans for turn/tool/LLM/post-turn/GUI diagnostics.                                                                                                                                                   |
| `0061_local_telemetry_lake.sql`                                           | Local telemetry lake: sessions, spans, events, metrics, artifacts, and eval scores.                                                                                                                                      |
| `0062_core_mechanic_i18n_packs.sql` - `0064_loading_quote_i18n_packs.sql` | Complete supported-language packs for mechanics and loading quotes.                                                                                                                                                      |
| `0065_core_entity_i18n_packs.sql` - `0070_quest_entity_i18n_packs.sql`    | Cartridge localization packs for entities, items, world locations, scenes, NPCs, and quests.                                                                                                                             |
| `0071_examiner_class_i18n_packs.sql`                                      | Localized class definitions for the unified character creator.                                                                                                                                                           |
| `0072_origin_template_i18n_packs.sql`                                     | Localized origin templates for character creation.                                                                                                                                                                       |
| `0073_dynamic_item_materialization.sql`                                   | Backfills runtime `entities.kind='item'` rows into `items.legacy_entity_id` and non-player `inventory_entries` so dynamic item spawns are inventory-resolvable.                                                           |
| `0074_delivery_quest_item_links.sql`                                      | Backfills accepted adventure quest item links from durable `adventure:accepted.spawnResults` so delivery quest context can show the current holder.                                                                       |
| `0075`-`0077`                                                             | Implicit delivery quest items, readable turn-error text, and Velvet Booths runtime fields.                                                                                                                               |
| `0078`-`0081`                                                             | Robot empty-world cartridge proof, robot quest completion runtime patches, first-turn guidance, and restoration of Quickgrin as active cartridge.                                                                        |
| `0082`-`0084`                                                             | Full Grinhaven dataset cartridge import, activation, and current patch.                                                                                                                                                   |
| `0085`-`0088`                                                             | Memory-palace packet tables, living-world location memory, memory-thread contract parity, and all-language first-entry bubbles.                                                                                           |
| `0089`-`0097`                                                             | AI location intro bubbles, presence/density/topology repairs, Market Square demo start, and Grinhaven map topography.                                                                                                    |
| `0098`-`0128`                                                             | NPC memory witness/private fields, companion offers, test items, dialogue resets, adventures queue fixtures, and baseline-reconciliation patches.                                                                         |
| `0129_hero_universe_instances.sql`                                        | [POST-BASELINE] Universe instances core table (FEAT-HERO-CONTINUITY-2) for parallel-world player playthrough partitions.                                                                                                   |
| `0130_hero_continuity_ledger.sql`                                         | [POST-BASELINE] Hero continuity ledger tables (FEAT-HERO-CONTINUITY-3) governing cross-world traveler artifacts, companion bonds, and projections.                                                                       |

> [!NOTE]
> All 128 historical migrations listed above are archived under `packages/web-server/migrations/archive-prebaseline/`. During server bootstrap, if the database is fresh, the runner skips the archived chain entirely and applies `packages/web-server/baseline/0001_engine_baseline.sql` to establish the baseline schema. Subsequent updates are managed via standard post-baseline delta SQL files.

`schema_migrations` records every applied file; querying it gives a quick
"what's live" check (`SELECT name FROM schema_migrations ORDER BY name`).

## Sources

- [packages/web-server/src/db.ts](../../packages/web-server/src/db.ts) —
  dual-backend layer
- [packages/web-server/src/migrate.ts](../../packages/web-server/src/migrate.ts)
  — migration runner
- [packages/web-server/migrations/](../../packages/web-server/migrations/) - SQL
  migrations
