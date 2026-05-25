-- Spec 26 — player profile schema. Lives in entities.profile (where
-- kind='player'). New endpoints in src/routes/profile.ts read/patch
-- this; the wizard fills it; turnContext surfaces every field in the
-- PLAYER preamble.
--
-- Backfill any existing player entities with an empty profile shell
-- so new endpoints don't crash on null reads.

UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
         'identity', '{}'::jsonb,
         'physical', '{}'::jsonb,
         'background', '{}'::jsonb,
         'created', false
       )
 WHERE kind = 'player'
   AND (profile IS NULL OR NOT (profile ? 'created'));
