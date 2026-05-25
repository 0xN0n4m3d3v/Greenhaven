-- Spec 110 - normalize Examiner class NPC hooks.
-- Older class seed data stored language-specific profile keys
-- (`npc_hook_en`, `npc_hook_ru`). Runtime localization expects one stable
-- profile key with translations in entities.i18n, so collapse them into
-- `npc_hook` before authoring the full class packs.

UPDATE entities
   SET profile = jsonb_set(
         COALESCE(profile, '{}'::jsonb) - 'npc_hook_en' - 'npc_hook_ru',
         '{npc_hook}',
         to_jsonb(profile->>'npc_hook_en'),
         true
       ),
       i18n = COALESCE(i18n, '{}'::jsonb) || jsonb_build_object(
         'npc_hook',
         jsonb_build_object(
           'en', profile->>'npc_hook_en',
           'ru', profile->>'npc_hook_ru'
         )
       )
 WHERE kind = 'class'
   AND id BETWEEN 602 AND 611
   AND profile ? 'npc_hook_en';
