# Engine Baseline Migration Inventory

FEAT-ENGINE-BASELINE-1 deliverable. Inventory of every
`packages/web-server/migrations/*.sql` file as of 2026-05-17, classified by
how it must be treated when Greenhaven moves to a clean engine baseline +
cartridge install runtime (see
`docs/specs/engine-baseline-and-cartridge-runtime.md` and
`docs/db/engine-baseline.md`).

The inventory is the input for the next subpasses (BASELINE-2 = build the
clean baseline SQL; BASELINE-3 = cut the fresh-DB startup over to that
baseline). No migrations are moved or rewritten in this pass.

## Classification legend

- `engine_schema` — tables, columns, indexes, constraints, triggers, or
  stored functions the runtime depends on. Belongs in the clean engine
  baseline. May include incidental data fix-ups that become harmless on
  an empty entities table.
- `engine_system_seed` — small engine-owned seed rows that the runtime
  reads on startup (default knobs, mechanical UI vocabulary). Belongs in
  the baseline as data, but is engine-owned, not cartridge-owned.
- `cartridge_world_content` — authored world content (entity rows,
  cartridge-scoped meta, world-specific i18n, prose). Must move out of
  the baseline; enters the runtime through cartridge install.
- `dev_repair_audit` — historical dev-only repair, audit, or backfill
  migration. The fix is either subsumed by clean baseline shape or no
  longer applies to a fresh DB. Should not run on the fresh-DB path.
- `obsolete_compatibility` — migration whose only purpose was to keep an
  older dev/prod DB compatible. No new database needs it. Archive.

A migration is classified by its **dominant baseline contribution**: if
it adds schema the runtime needs, it is `engine_schema` even if it also
seeds a small amount of authored world content (that authored content
must be dropped from the future baseline regeneration). The
`cutover_action` column says exactly what to do.

## Required cutover actions

- `keep_in_baseline` — re-emit the schema/data verbatim from the next
  baseline regeneration.
- `keep_schema_drop_seed` — re-emit the schema; drop any authored-world
  insert lines (entity rows, cartridge_meta world prose, world i18n).
- `move_to_cartridge_install` — content belongs to a cartridge artifact;
  do not replay on baseline. Enters runtime through cartridge install.
- `archive` — exclude from the fresh-DB path. Keep on disk under an
  `archive-prebaseline/` (or equivalent) directory for audit.

## Authored-world insert evidence

Per the spec verification command
`rg -n "INSERT INTO entities|INSERT INTO cartridge_meta|INSERT INTO cartridges|grinhaven-full|Greenhaven Obsidian"
packages/web-server/migrations`, 29 files match. Direct `INSERT INTO
entities` appears in 16 files (0003, 0011, 0019, 0021, 0029, 0032, 0049,
0075, 0078, 0082, 0084, 0096, 0099, 0100, 0117, 0122). `INSERT INTO
cartridge_meta` value rows appear in 15 files. `INSERT INTO cartridges`
appears only in 0125 (FEAT-CART-LIB-1 registry backfill from existing
`cartridge_meta.cartridge_id`). The `Evidence` column flags each row's
authored-world surface.

## Inventory

| Filename | Classification | Runtime role | Content risk | World-insert evidence | Cutover action |
|---|---|---|---|---|---|
| `0001_cartridge.sql` | engine_schema | base entities/runtime/transitions/inventory tables | none | — | keep_in_baseline |
| `0002_litrpg.sql` | engine_schema | LitRPG: runtime_player_overlay, players, player_stats, player_skills, chat_messages | none | — | keep_in_baseline |
| `0003_seed_quickgrin.sql` | cartridge_world_content | seeds the original `quickgrin-lane` cartridge | high — full cartridge seed | INSERT INTO entities + INSERT INTO cartridges | move_to_cartridge_install |
| `0004_sequence_fix.sql` | engine_schema | entities sequence ownership fix | none | — | keep_in_baseline |
| `0005_fix_payment_recipe.sql` | dev_repair_audit | repairs a quickgrin payment recipe row | low | UPDATE entities | archive |
| `0006_location_exits.sql` | cartridge_world_content | adds quickgrin location exits | high — cartridge content | INSERT/UPDATE on cartridge entities | move_to_cartridge_install |
| `0007_dialogue_mode.sql` | engine_schema | dialogue mode columns on chat_messages + players | none | — | keep_in_baseline |
| `0008_entity_aliases.sql` | engine_schema | entity_aliases storage for cross-language @-mentions | none | — | keep_in_baseline |
| `0009_npc_hp.sql` | cartridge_world_content | seeds Mikka (entity 200) current_hp + max_hp runtime fields | medium — cartridge NPC stats | INSERT INTO runtime_fields/runtime_values for entity 200 | move_to_cartridge_install |
| `0010_npc_stats.sql` | engine_schema | creates `npc_stats` table + seeds Mikka ability scores + AC/prof runtime fields | mixed — schema + cartridge seed | INSERT INTO npc_stats + runtime_fields/runtime_values for entity 200 | keep_schema_drop_seed |
| `0011_ability_checks.sql` | cartridge_world_content | seeds quickgrin item ability-check rules | medium — cartridge items | INSERT INTO entities + inventory_entries + UPDATE entities | move_to_cartridge_install |
| `0012_dice_cooldowns.sql` | engine_schema | dice cooldown schema | none | — | keep_in_baseline |
| `0013_status_effects.sql` | cartridge_world_content | seeds Mikka (entity 200) `stunned` runtime field | medium — cartridge NPC status | INSERT INTO runtime_fields/runtime_values for entity 200 | move_to_cartridge_install |
| `0014_player_status.sql` | engine_schema | adds `stunned` column on `players` | none | ALTER TABLE only | keep_in_baseline |
| `0015_turn_telemetry.sql` | engine_schema | turn telemetry schema | none | — | keep_in_baseline |
| `0016_telemetry_player.sql` | engine_schema | telemetry FK on player | none | — | keep_in_baseline |
| `0017_i18n.sql` | engine_schema | ALTER entities/entity_instructions/players for i18n column | none | — | keep_in_baseline |
| `0018_cartridge_meta.sql` | engine_schema | creates `cartridge_meta` table + quickgrin default keys | medium — seed rows are cartridge-owned defaults | INSERT INTO cartridge_meta (quickgrin keys) | keep_schema_drop_seed |
| `0019_quiet_lantern_inn.sql` | cartridge_world_content | seeds Quiet Lantern Inn location | high — cartridge entity | INSERT INTO entities | move_to_cartridge_install |
| `0020_full_npc_reset.sql` | dev_repair_audit | one-off NPC reset for early-dev cartridge | medium — cartridge | UPDATE entities | archive |
| `0021_world_entity.sql` | cartridge_world_content | seeds WORLD entity (id=10) + quickgrin world lore | high — cartridge lore | INSERT INTO entities + INSERT INTO cartridge_meta | move_to_cartridge_install |
| `0022_world_adult_tone.sql` | cartridge_world_content | quickgrin adult-tone cartridge meta | medium | INSERT INTO cartridge_meta | move_to_cartridge_install |
| `0023_item_i18n.sql` | cartridge_world_content | i18n for cartridge items (302, 303) | medium | UPDATE entities (i18n jsonb) | move_to_cartridge_install |
| `0024_entity_i18n.sql` | cartridge_world_content | i18n for all quickgrin named entities (RU + JA) | high — full cartridge prose | UPDATE entities (i18n jsonb) | move_to_cartridge_install |
| `0026_conditions_field.sql` | engine_schema | registers `conditions` runtime_field for all persons | low — engine taxonomy | INSERT INTO runtime_fields | keep_in_baseline |
| `0027_strings_field.sql` | engine_schema | registers `strings` runtime_field for all persons | low — engine taxonomy | INSERT INTO runtime_fields | keep_in_baseline |
| `0028_sex_moves_and_trauma.sql` | cartridge_world_content | seeds `profile.sex_move` on cartridge NPCs + trauma runtime field | high — cartridge content | UPDATE entities | move_to_cartridge_install |
| `0029_quest_schema.sql` | engine_schema | ALTER TABLE player_quests adds current_stage_id / accumulated_state / path_taken; seeds Mikka's Trust quest | mixed — schema essential, quest seed cartridge-owned | INSERT INTO entities (Mikka's Trust) | keep_schema_drop_seed |
| `0030_quest_mechanics_examples.sql` | cartridge_world_content | extends Mikka's Trust quest stages | medium — cartridge | UPDATE entities | move_to_cartridge_install |
| `0031_player_profile_schema.sql` | engine_schema | player profile schema | none | — | keep_in_baseline |
| `0032_class_profile_and_stats.sql` | engine_schema | adds `class_id` + class schema; seeds Wanderer (600) | mixed | INSERT INTO entities (class) | keep_schema_drop_seed |
| `0033_npc_portraits_and_world_atmosphere.sql` | engine_schema | runtime_fields for time/weather/portrait + cartridge atmosphere defaults | medium — cartridge values | INSERT INTO runtime_fields/runtime_values + INSERT INTO cartridge_meta + UPDATE entities | keep_schema_drop_seed |
| `0034_surfaces_and_inspiration.sql` | engine_schema | surfaces + inspiration runtime_fields + cartridge combo defaults | medium | INSERT INTO runtime_fields + INSERT INTO cartridge_meta | keep_schema_drop_seed |
| `0035_memory_salience.sql` | engine_schema | memory salience column on `npc_memories` | none | — | keep_in_baseline |
| `0036_npc_initiative_profile.sql` | cartridge_world_content | initiative tuning for cartridge NPCs (Mikka, Borek) | medium — cartridge | UPDATE entities | move_to_cartridge_install |
| `0037_combat_state.sql` | engine_schema | combat_state column | none | — | keep_in_baseline |
| `0038_inventory_categories.sql` | engine_schema | inventory category schema | none | — | keep_in_baseline |
| `0039_scripted_intimacy_rules.sql` | engine_schema | scripted_intimacy_rules table | none | — | keep_in_baseline |
| `0040_i18n_translations.sql` | engine_schema | creates `i18n_keys` + `i18n_translations` + seeds mechanical-vocab EN labels | low — engine UI vocab | INSERT INTO i18n_keys/i18n_translations | keep_in_baseline |
| `0041_xp_levels.sql` | engine_schema | XP curve table | none | — | keep_in_baseline |
| `0042_save_slots.sql` | engine_schema | save slot tables | none | — | keep_in_baseline |
| `0043_dialogue_partner_and_extensions.sql` | engine_schema | dialogue_partner column + surface extensions | none | — | keep_in_baseline |
| `0044_persona_registry.sql` | engine_schema | `persona_archetypes` engine taxonomy + ALTER entities.persona_slug | low — engine bubble taxonomy | INSERT INTO persona_archetypes + UPDATE entities (defaults) | keep_in_baseline |
| `0045_directive_tags_audio_quotes.sql` | engine_schema | directive_tag_types + ambient_beds + loading_quotes + scene-break i18n keys | low — engine UI taxonomy | INSERT INTO engine taxonomy tables | keep_in_baseline |
| `0046_inventory_consolidation.sql` | dev_repair_audit | consolidates legacy dual-inventory systems | low | data migration | archive |
| `0047_noticed_directive.sql` | engine_schema | adds the `noticed` directive tag taxonomy | none | — | keep_in_baseline |
| `0048_origin_templates.sql` | cartridge_world_content | seeds origin templates (3-5 archetypes) in cartridge_meta | high — cartridge templates | INSERT INTO cartridge_meta | move_to_cartridge_install |
| `0049_examiner_classes.sql` | cartridge_world_content | seeds 10 Examiner classes (602-611) + i18n | high — cartridge content | INSERT INTO entities + i18n_keys + i18n_translations | move_to_cartridge_install |
| `0050_fix_borek_sex_move_effect_args.sql` | dev_repair_audit | fixes a Borek sex-move arg from 0028 | low | UPDATE entities | archive |
| `0051_turn_telemetry_session_id_text.sql` | engine_schema | aligns telemetry session id type | none | — | keep_in_baseline |
| `0052_drop_default_player_display_name.sql` | engine_schema | drops a default value on players.display_name | none | — | keep_in_baseline |
| `0053_gui_event_outbox.sql` | engine_schema | gui_event_outbox table | none | — | keep_in_baseline |
| `0054_turn_ingress_queue.sql` | engine_schema | turn ingress queue table | none | — | keep_in_baseline |
| `0055_turn_telemetry_presentation_slots.sql` | engine_schema | telemetry presentation slot columns | none | — | keep_in_baseline |
| `0056_gui_event_release_sequence.sql` | engine_schema | release_seq column + index on gui_event_outbox | none | — | keep_in_baseline |
| `0057_adventure_queue.sql` | engine_schema | adventure_queue table | none | — | keep_in_baseline |
| `0058_intimacy_runtime_field_cleanup.sql` | dev_repair_audit | strips stale intimacy objectives | low | UPDATE runtime_values | archive |
| `0059_world_fact_ownership_metadata.sql` | cartridge_world_content | deterministic topology/ownership metadata on shipped cartridge entities | high — cartridge content | UPDATE entities (profile) | move_to_cartridge_install |
| `0060_performance_events.sql` | engine_schema | performance_events table | none | — | keep_in_baseline |
| `0061_local_telemetry_lake.sql` | engine_schema | local telemetry lake schema | none | — | keep_in_baseline |
| `0062_core_mechanic_i18n_packs.sql` | engine_system_seed | EN/RU/JA labels for engine mechanical vocab (conditions, surfaces, etc.) | low — engine UI strings | INSERT INTO i18n_translations | keep_in_baseline |
| `0063_remaining_mechanic_i18n_packs.sql` | engine_system_seed | EN/RU/JA labels for remaining engine mechanical vocab | low | INSERT INTO i18n_translations | keep_in_baseline |
| `0064_loading_quote_i18n_packs.sql` | engine_system_seed | EN/RU/JA loading-quote pool (engine UI) | low — engine UI | INSERT INTO i18n_translations | keep_in_baseline |
| `0065_core_entity_i18n_packs.sql` | cartridge_world_content | i18n for cartridge core entities | high — cartridge | INSERT INTO i18n_translations | move_to_cartridge_install |
| `0066_examiner_class_hook_i18n_normalization.sql` | cartridge_world_content | i18n normalization for Examiner class hooks (0049 cartridge content) | medium | INSERT/UPDATE i18n_translations | move_to_cartridge_install |
| `0067_item_entity_i18n_packs.sql` | cartridge_world_content | i18n for cartridge item entities | high — cartridge | INSERT INTO i18n_translations | move_to_cartridge_install |
| `0068_world_location_scene_i18n_packs.sql` | cartridge_world_content | i18n for cartridge world/location/scene entities | high — cartridge | INSERT INTO i18n_translations | move_to_cartridge_install |
| `0069_npc_entity_i18n_packs.sql` | cartridge_world_content | i18n for cartridge NPC entities | high — cartridge | INSERT INTO i18n_translations | move_to_cartridge_install |
| `0070_quest_entity_i18n_packs.sql` | cartridge_world_content | i18n for cartridge quest entities | high — cartridge | INSERT INTO i18n_translations | move_to_cartridge_install |
| `0071_examiner_class_i18n_packs.sql` | cartridge_world_content | i18n for cartridge Examiner classes (0049) | high — cartridge | INSERT INTO i18n_translations | move_to_cartridge_install |
| `0072_origin_template_i18n_packs.sql` | cartridge_world_content | i18n for cartridge origin templates (0048) | high — cartridge | INSERT INTO i18n_translations | move_to_cartridge_install |
| `0073_dynamic_item_materialization.sql` | engine_schema | adds `items.legacy_entity_id` column + unique index; backfill SELECTs against `entities` produce zero rows on empty baseline | low — schema add | INSERT INTO items + inventory_entries (SELECT FROM entities; empty on baseline) | keep_in_baseline |
| `0074_delivery_quest_item_links.sql` | dev_repair_audit | links accepted delivery quests to their item placements | low — repair | UPDATE entities | archive |
| `0075_implicit_delivery_quest_items.sql` | dev_repair_audit | materializes implicit delivery quest items | low — repair | INSERT INTO entities | archive |
| `0076_turn_error_text_encoding.sql` | engine_schema | fixes turn_error text encoding | none | — | keep_in_baseline |
| `0077_velvet_booths_runtime_fields.sql` | cartridge_world_content | seeds Velvet Booths cartridge runtime fields | high — cartridge | runtime_values inserts | move_to_cartridge_install |
| `0078_robot_empty_world_cartridge.sql` | cartridge_world_content | full `robot-empty` cartridge dataset | high — full cartridge | INSERT INTO entities + INSERT INTO cartridges + INSERT INTO cartridge_meta | move_to_cartridge_install |
| `0079_robot_quest_completion_runtime_patches.sql` | cartridge_world_content | robot-empty cartridge quest completion patches | medium — cartridge | UPDATE entities | move_to_cartridge_install |
| `0080_robot_scene_first_turn_guidance.sql` | cartridge_world_content | robot-empty cartridge scene guidance | medium — cartridge | UPDATE entities | move_to_cartridge_install |
| `0081_restore_quickgrin_active_cartridge.sql` | obsolete_compatibility | re-activates quickgrin after robot-empty experiment | low — cartridge switch | UPDATE cartridge_meta | archive |
| `0082_grinhaven_full_dataset_cartridge.sql` | cartridge_world_content | full `grinhaven-full` cartridge dataset (1317 INSERTs) | very high — full cartridge | INSERT INTO entities + INSERT INTO cartridges + INSERT INTO cartridge_meta | move_to_cartridge_install |
| `0083_activate_grinhaven_full_cartridge.sql` | obsolete_compatibility | activates grinhaven-full as the live cartridge | low — cartridge switch | UPDATE cartridge_meta + INSERT INTO cartridges | archive |
| `0084_forge_grinhaven_full_current_patch.sql` | cartridge_world_content | regenerated grinhaven-full forge upsert patch (1299 INSERTs) | very high — full cartridge | INSERT INTO entities + INSERT INTO cartridges + INSERT INTO cartridge_meta | move_to_cartridge_install |
| `0085_memory_palace_loop_packets.sql` | engine_schema | ALTER npc_memories adds memory_kind/family/etc.; backfills derived metadata | low — derived backfill | UPDATE npc_memories | keep_in_baseline |
| `0086_living_world_location_memory.sql` | engine_schema | creates player_location_visits + actor_statuses + extends memory_clusters | none | — | keep_in_baseline |
| `0087_memory_threads_contract_parity.sql` | engine_schema | aligns memory_threads column names with code (Spec 137) | none | — | keep_in_baseline |
| `0088_location_first_entry_bubbles_all_languages.sql` | engine_schema | derives location_intro_bubbles rows from existing cartridge entities | low — derivation only | INSERT INTO location_intro_bubbles (derived) | keep_in_baseline |
| `0089_ai_location_intro_bubbles_ale_and_eats.sql` | cartridge_world_content | authored Ale & Eats intro bubble copy | medium — cartridge | INSERT/UPDATE location_intro_bubbles | move_to_cartridge_install |
| `0090_meow_meow_paradise_presence_patch.sql` | cartridge_world_content | Meow Meow Paradise presence patch | medium — cartridge | UPDATE entities | move_to_cartridge_install |
| `0091_recompute_location_density_runtime_links.sql` | dev_repair_audit | recomputes local-density runtime links | medium — runtime repair | UPDATE entities (runtime fields) | archive |
| `0092_filter_density_ids_by_kind.sql` | dev_repair_audit | corrects 0091's density-id filter | low — repair | UPDATE entities | archive |
| `0093_strict_local_density_and_transitive_rollup.sql` | dev_repair_audit | further tightens 0091/0092 density rebuild | low — repair | UPDATE entities | archive |
| `0094_district_name_topology_repair.sql` | dev_repair_audit | repairs district name/topology rows on grinhaven cartridge | low — repair | UPDATE entities | archive |
| `0095_nectar_presence_patch.sql` | cartridge_world_content | Nectar presence patch | medium — cartridge | UPDATE entities | move_to_cartridge_install |
| `0096_grinhaven_market_square_demo_start.sql` | cartridge_world_content | grinhaven Main Market Square demo start | high — cartridge | INSERT INTO entities + INSERT INTO cartridge_meta | move_to_cartridge_install |
| `0097_grinhaven_map_topography.sql` | cartridge_world_content | authored city-map topography for grinhaven visible set | high — cartridge | UPDATE entities (profile.map_x/map_y) | move_to_cartridge_install |
| `0098_npc_memory_witness_and_private.sql` | engine_schema | witness-scoped + private memory channel schema | none | — | keep_in_baseline |
| `0099_mikka_companion_offer.sql` | cartridge_world_content | Mikka companion-offer cartridge content | medium — cartridge | INSERT/UPDATE entities | move_to_cartridge_install |
| `0100_test_bench_items.sql` | dev_repair_audit | test-bench items (Eris Coin + enchanted blades) for dev testing | low — dev fixtures | INSERT INTO entities | archive |
| `0101_mikka_portrait_set.sql` | cartridge_world_content | Mikka portrait set | medium — cartridge | UPDATE entities | move_to_cartridge_install |
| `0101a_memory_threads_fk_prerepair.sql` | dev_repair_audit | pre-repairs orphan memory_threads FK rows before 0102 | low — repair | DELETE memory_threads | archive |
| `0102_fk_fixes.sql` | engine_schema | adds missing FK constraints + ON DELETE CASCADE | none | — | keep_in_baseline |
| `0103_forge_upsert_protected_fields.sql` | engine_schema | merge helper function for cartridge forge re-import (M-2) | none | — | keep_in_baseline |
| `0104_density_rebuild_function.sql` | engine_schema | extracts the canonical density rebuild PL/pgSQL function (M-1) | none | — | keep_in_baseline |
| `0105_normalize_entity_profile_phase1_add_columns.sql` | engine_schema | ARCH-19 Phase 1 — adds normalized profile columns | none | — | keep_in_baseline |
| `0106_normalize_entity_profile_phase3_reader_cleanup.sql` | engine_schema | ARCH-19 Phase 3 — reader cleanup | none | — | keep_in_baseline |
| `0107_density_caps_parameterized.sql` | engine_schema | parameterizes density caps + seeds engine default knob (M-3) | low — engine knob | UPDATE entities + INSERT INTO cartridge_meta | keep_in_baseline |
| `0108_density_depth_cap_diagnostics.sql` | engine_schema | M-4 diagnostics function | none | — | keep_in_baseline |
| `0109_density_depth_cap_diagnostics_guard.sql` | engine_schema | M-4 PL/pgSQL undefined_table guard | none | — | keep_in_baseline |
| `0110_safe_jsonb_array_helper.sql` | engine_schema | M-6 `safe_jsonb_array` helper function | none | — | keep_in_baseline |
| `0111_turn_ingress_queue_unique_idx.sql` | engine_schema | DEEP-8 unique index on (session_id, queue_index) | none | — | keep_in_baseline |
| `0112_normalize_quest_advance_on.sql` | dev_repair_audit | normalizes legacy `advance_on` from 0078 robot quests | low — repair | UPDATE entities | archive |
| `0113_canonical_display_name_mentions.sql` | dev_repair_audit | normalizes runtime mention keys to canonical display_name | low — repair | UPDATE runtime_values | archive |
| `0114_adventure_queue_counters.sql` | engine_schema | per-(session_id, player_id) adventure counters | none | — | keep_in_baseline |
| `0115_cartridge_world_clock_meta.sql` | engine_system_seed | engine-default world-clock cadence row in cartridge_meta | low — engine default | INSERT INTO cartridge_meta | keep_in_baseline |
| `0116_player_recovery_code_prefix.sql` | engine_schema | DEEP-2 indexed recovery-code prefix lookup | none | — | keep_in_baseline |
| `0117_obsidian_world_patch.sql` | cartridge_world_content | OWV obsidian-vault world patch (38 cartridge_meta + entity inserts) | very high — cartridge prose patch | INSERT INTO entities + INSERT INTO cartridge_meta | move_to_cartridge_install |
| `0118_session_tokens.sql` | engine_schema | SEC-6 session_tokens revocation table | none | — | keep_in_baseline |
| `0119_inventory_surface_columns.sql` | engine_schema | FEAT-INV-1 structured inventory columns | none | — | keep_in_baseline |
| `0120_player_journal_entries.sql` | engine_schema | FEAT-NOTICE-1 durable journal projection table | none | — | keep_in_baseline |
| `0121_character_state_progression.sql` | engine_schema | FEAT-STATE-1 typed character progression tables | none | — | keep_in_baseline |
| `0122_obsidian_world_patch_v2.sql` | cartridge_world_content | OWV obsidian-vault world patch v2 (38 inserts) | very high — cartridge prose patch | INSERT INTO entities + INSERT INTO cartridge_meta | move_to_cartridge_install |
| `0123_normalize_entity_profile_phase4_drop_legacy_keys.sql` | engine_schema | ARCH-19 Phase 4 — drop legacy profile keys | none | — | keep_in_baseline |
| `0124_normalize_entity_profile_phase4_enforce_cartridge_scope.sql` | engine_schema | ARCH-19 Phase 4 — enforce cartridge scope | none | — | keep_in_baseline |
| `0125_cartridge_library.sql` | engine_schema | FEAT-CART-LIB-1 cartridge registry tables; backfills `cartridges` from `cartridge_meta.cartridge_id` | mixed — schema + transitional backfill | INSERT INTO cartridges (one-time backfill) | keep_schema_drop_seed |
| `0126_cartridge_import_preview_jobs.sql` | engine_schema | FEAT-CART-LIB-2 install cache + preview jobs | none | — | keep_in_baseline |
| `0127_cartridge_import_apply_jobs.sql` | engine_schema | FEAT-CART-LIB-3 apply job statuses | none | — | keep_in_baseline |
| `0128_cartridge_playthrough_launch.sql` | engine_schema | FEAT-CART-LIB-5 playthrough launch columns | none | — | keep_in_baseline |

## Category totals

- `engine_schema`: 68 migrations.
- `engine_system_seed`: 4 migrations (0062, 0063, 0064, 0115).
- `cartridge_world_content`: 39 migrations.
- `dev_repair_audit`: 15 migrations (includes 0074 quest-item link repair,
  flagged as backfill rather than new authored content).
- `obsolete_compatibility`: 2 migrations (0081, 0083).
- **Total**: 128 (matches
  `Get-ChildItem packages\web-server\migrations\archive-prebaseline\*.sql | Measure-Object`).
- FEAT-ENGINE-BASELINE-2 reclassification (2026-05-17): 0009 and 0013
  moved from `engine_schema` to `cartridge_world_content` after the
  baseline generator surfaced a hardcoded Mikka (entity 200) FK
  violation. They contain only `INSERT INTO runtime_fields/runtime_values`
  for entity 200 and add no schema. 0010 stays `engine_schema` but
  switched to `keep_schema_drop_seed` so the `npc_stats` table lands
  in the baseline without the Mikka ability-score / AC seed rows.

## Empty-on-baseline tables

After a baseline-only bootstrap (no cartridge installed yet) the following
runtime tables must be **empty**:

- `entities` (all authored world rows live in cartridge content);
- `entity_aliases`;
- `entity_instructions`;
- `runtime_values`;
- `inventory_entries`;
- `items`;
- `transitions`;
- `cartridges` (no installed cartridges yet — FEAT-CART-LIB pipeline
  populates this on install);
- `cartridge_records` (FEAT-CART-LIB-3 apply target);
- `cartridge_meta` for **world-prose / cartridge-scoped** keys
  (engine-default knobs like `world_clock_minutes_per_turn` from 0115
  remain — see "engine-owned" subset below);
- `cartridge_meta_scoped`;
- `cartridge_install_cache`;
- `cartridge_import_preview_jobs`;
- `cartridge_import_apply_jobs`;
- `i18n_keys` / `i18n_translations` **for cartridge entities**
  (engine mechanical-vocab keys from 0040 + 0062-0064 remain — see
  "engine-owned" subset below);
- `location_intro_bubbles`;
- `player_location_visits`;
- `actor_statuses`;
- `memory_clusters` / `memory_threads`;
- `npc_memories`;
- `player_quests` / `player_inventory` (player-scoped runtime);
- `gui_event_outbox` / `turn_ingress_queue` / `adventure_queue`;
- `turn_telemetry` / `performance_events` / `telemetry_events`;
- `players` / `player_stats` / `player_skills` / `runtime_player_overlay`
  (no hero exists yet);
- `chat_messages` / `sessions` / `save_slots`;
- `player_journal_entries` (FEAT-NOTICE-1 projection);
- `character_state_*` (FEAT-STATE-1 tables);
- `session_tokens` (SEC-6).

## Engine-owned rows that **may** exist after baseline-only bootstrap

- `cartridge_meta`: rows for **engine-default knobs** — e.g.,
  `world_clock_minutes_per_turn`, `world_clock_default_world_time_minutes`
  (0115). Cartridge-scoped values like `cartridge_id`,
  `starting_location_id`, `currency_item_id` (0018) are **cartridge-owned**
  and must NOT appear after baseline bootstrap (the cartridge install
  writes them).
- `i18n_keys` + `i18n_translations`: rows seeded by 0040 + 0062-0064 for
  engine mechanical vocabulary (`condition.bleeding`, `surface.fire`,
  loading-quote pool, mode names, etc.). Cartridge entity i18n
  (0065-0072) and cartridge prose i18n (0023, 0024) must NOT appear.
- `runtime_fields`: cross-cutting engine field registrations from
  0026 (`conditions`), 0027 (`strings`), 0028 (trauma), 0033 (atmosphere
  + portrait), 0034 (surfaces, inspiration), and so on. These are
  engine-owned cross-cutting definitions; their **values** in
  `runtime_values` for specific entities are cartridge content and must
  not appear in a baseline-only DB.
- `persona_archetypes`: engine bubble taxonomy from 0044.
- `directive_tag_types` + `ambient_beds` + `loading_quotes`: engine UI
  taxonomies from 0045.
- `cartridge_meta` engine knobs from 0107 (`local_density_caps`).
- `schema_migrations`: migration bookkeeping with one row recording the
  baseline version.

## Cutover risks for FEAT-ENGINE-BASELINE-2..3

Surfaced during this taxonomy pass. The next subpass (clean baseline
SQL) must reconcile each one:

1. **`cartridge_meta` mixed ownership.** 0018 seeds quickgrin-scoped
   keys (`cartridge_id`, `starting_location_id`, `currency_item_id`,
   `default_class_id`) alongside what later migrations turn into engine
   defaults (`world_clock_minutes_per_turn` in 0115;
   `local_density_caps` in 0107). The clean baseline must drop the
   cartridge-scoped seed and keep only engine-default knobs. The
   FEAT-CART-LIB pipeline + `cartridge_meta_scoped` already owns the
   cartridge-scoped keys via the per-cartridge scoping mechanism.
2. **0125 cartridges backfill.** The first cartridge-library migration
   backfills `cartridges` from `cartridge_meta.cartridge_id` so existing
   dev/prod DBs gain a registry row for their active cartridge. On a
   clean baseline that backfill has no source and is a no-op; the
   future baseline must drop the backfill INSERT lines and leave
   `cartridges` empty until a cartridge is installed.
3. **Schema-only migrations that also seed cartridge content** (0029,
   0032, 0033, 0034). The baseline must take their schema and drop their
   authored-content INSERT/UPDATE lines. Mikka's Trust seed (0029),
   Wanderer class seed (0032), atmosphere defaults (0033), surfaces
   defaults (0034) all belong in the cartridge artifact.
4. **i18n table split.** 0040 creates the i18n tables AND seeds engine
   mechanical vocab. 0062-0064 add more engine vocab translations. The
   baseline keeps both. 0065-0072 + 0023 + 0024 seed cartridge entity
   i18n — those must move into the cartridge artifact.
5. **Cross-cutting `runtime_fields` registrations** (0026, 0027, 0028,
   0033, 0034) emit one row per existing person/location entity. On a
   clean baseline `entities` is empty so these UPDATE/INSERT loops touch
   zero rows; the **field registration** rows themselves (in
   `runtime_fields`) are engine-owned and must be in the baseline.
6. **`grinhaven-full` cartridge** (0082, 0084) and the **obsidian
   world patches** (0117, 0122) together contain the canonical
   Greenhaven world. They are huge (≈2700 cumulative inserts) and must
   be replaced by an Obsidian-vault compile (FEAT-ENGINE-BASELINE-4).
7. **Density rebuild repair chain** (0091-0094). These were
   one-shot runtime repairs against a populated cartridge. On a clean
   baseline they have nothing to repair. Archive.
8. **`memory_palace_loop_packets` backfill** (0085) uses a derived-from-
   tags backfill. Schema is engine; the backfill is naturally a no-op on
   empty `npc_memories`. Keep schema, drop backfill UPDATE.
9. **`dynamic_item_materialization`** (0073) adds `items.legacy_entity_id`
   and copies dynamic entities into the `items` catalogue. The column
   itself is transitional; the future baseline should either keep it
   for forward compatibility with old cartridges or drop it entirely.
   Flagged as `dev_repair_audit` and queued for review during
   BASELINE-2 schema reconciliation.
10. **`obsolete_compatibility` markers** (0081, 0083). These switch the
    "active cartridge" pointer between quickgrin and grinhaven-full.
    The clean baseline ships with `cartridges` empty, so neither
    activation makes sense; archive both.

## Coverage

The list above is verified mechanically against
`packages/web-server/migrations/*.sql` by
`packages/web-server/src/__tests__/scripts/engineBaselineMigrationInventory.test.ts`,
which fails CI if any migration file is missing from the inventory or has
an unknown classification.
