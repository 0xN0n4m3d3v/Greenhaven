-- Spec 34 — initiative tuning for the cartridge's two seeded NPCs.
-- Mikka leans aggressive (high counter-strike drive); Borek the
-- innkeeper is patient. Cartridge author can override per-NPC.

UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
         'aggression', 0.7,
         'initiative_cooldown_turns', 2
       )
 WHERE id = 200 AND kind = 'person';

UPDATE entities
   SET profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object(
         'aggression', 0.3,
         'initiative_cooldown_turns', 3
       )
 WHERE id = 220 AND kind = 'person';
