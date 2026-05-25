-- 0020_full_npc_reset.sql — extend reset_runtime_overrides so
-- /api/debug/reset-world fully restores NPC HP and status flags, not
-- just their mood/scene-state.
--
-- The previous list (0018 + 0019) only force-wrote 4 fields:
--   2101 mikka.mood   → 'pricing'
--   2102 lamp_state   → 'dark'
--   2300 borek.mood   → 'tired'
--   2310 borek.hp     → 15
--
-- Missing: Mikka's current_hp + stunned flag, so a wounded or stunned
-- Mikka stayed wounded across resets. This adds them.
--
-- Engine-side reset of npc_stats (current ← base) lives in
-- src/index.ts /api/debug/reset-world — it's cartridge-agnostic and
-- doesn't need a meta hint.

UPDATE cartridge_meta
   SET value = '[
         {"field_id":2101,"value":"pricing"},
         {"field_id":2102,"value":"dark"},
         {"field_id":2200,"value":12},
         {"field_id":2204,"value":false},
         {"field_id":2300,"value":"tired"},
         {"field_id":2310,"value":15}
       ]'::jsonb,
       updated_at = now()
 WHERE key = 'reset_runtime_overrides';
