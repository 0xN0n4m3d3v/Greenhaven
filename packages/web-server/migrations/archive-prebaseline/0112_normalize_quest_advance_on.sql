-- QE-6 — normalize legacy quest stage `advance_on` values.
--
-- Migration 0078 (`robot_empty_world_cartridge.sql`) seeded three
-- quest stages with `advance_on: 'manual_or_watcher'`. The runtime
-- always silently treated that as the default AND semantics
-- (`all_objectives_complete`), but the QE-6 cartridge validator now
-- rejects any value outside the four allowed aliases. Rewrite the
-- persisted seed rows in place so existing dev / prod databases do
-- not fail `cartridge:i18n:check` after the upgrade.
--
-- This migration is idempotent: re-running it is a no-op once every
-- stage has been normalized. It only touches stage objects whose
-- current `advance_on` is the literal `'manual_or_watcher'`.

UPDATE entities
   SET profile = jsonb_set(
         profile,
         '{stages}',
         (
           SELECT jsonb_agg(
             CASE
               WHEN stage ? 'advance_on'
                AND stage->>'advance_on' = 'manual_or_watcher'
                 THEN jsonb_set(stage, '{advance_on}', '"all_objectives_complete"'::jsonb)
               ELSE stage
             END
             ORDER BY ord
           )
           FROM jsonb_array_elements(profile->'stages')
                WITH ORDINALITY AS s(stage, ord)
         )
       )
 WHERE kind = 'quest'
   AND jsonb_typeof(profile->'stages') = 'array'
   AND EXISTS (
     SELECT 1
       FROM jsonb_array_elements(profile->'stages') AS s(stage)
      WHERE s.stage->>'advance_on' = 'manual_or_watcher'
   );
