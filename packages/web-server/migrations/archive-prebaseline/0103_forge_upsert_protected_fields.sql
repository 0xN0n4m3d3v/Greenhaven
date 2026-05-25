-- 0103_forge_upsert_protected_fields.sql
--
-- M-2 — protect computed/runtime profile fields from cartridge forge re-import.
--
-- Cartridge Forge has historically upserted entity rows with
--   ON CONFLICT (id) DO UPDATE SET ... profile = EXCLUDED.profile, ...
-- which clobbers runtime/computed profile fields that later migrations or
-- live gameplay have written (topology_parent_id, local_density,
-- local_density_summary). Migration 0094 was a per-record repair pass
-- after this damage; with this helper, the damage no longer happens on
-- re-import.
--
-- The applied immutable 0084 forge migration is left untouched (per the
-- CLAUDE.md migration-immutability rule). The forge exporter
-- (packages/cartridge-forge/src/exporters/exportGrinhavenSql.ts) now
-- emits  profile = gh_forge_merge_entity_profile(entities.profile,
-- EXCLUDED.profile)  instead of  profile = EXCLUDED.profile  on
-- ON CONFLICT, so every subsequent forge re-import goes through this
-- helper. 0094 is retained for historic state — DO NOT delete or edit it.

CREATE OR REPLACE FUNCTION gh_forge_merge_entity_profile(
  existing_profile jsonb,
  incoming_profile jsonb
) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
  -- Start from the cartridge-author payload (or '{}' when nothing was
  -- supplied) and re-apply runtime/computed fields from the existing row
  -- so they win over the incoming cartridge values. The CASE arms only
  -- emit a key when the existing row actually had it set; this keeps the
  -- merge null/missing-key safe -- we never introduce JSON nulls for
  -- protected fields the existing row never carried.
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

COMMENT ON FUNCTION gh_forge_merge_entity_profile(jsonb, jsonb) IS
  'M-2: merge an incoming cartridge profile with the existing entities.profile, '
  'preserving runtime/computed fields (topology_parent_id, local_density, '
  'local_density_summary). Missing protected keys on the existing row are '
  'not introduced as JSON nulls; incoming non-protected keys are kept as-is. '
  'Used by Cartridge Forge re-imports so 0094-style repair passes are no longer '
  'needed in fresh environments.';
