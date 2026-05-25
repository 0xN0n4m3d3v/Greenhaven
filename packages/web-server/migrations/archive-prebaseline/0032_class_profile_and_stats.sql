-- Spec 27 — Class profile schema + skill-name-keyed proficiency.
--
-- Existing player_stats (0002_litrpg.sql) is long-format
-- (player_id, stat_key, base, current). We don't reshape it; the new
-- character/:id/stats endpoint writes 6 rows in one round-trip.
-- The 5e proficiency bonus is hard-coded to 2 at level 1; spec 36
-- replaces with the xp_thresholds lookup (deferred, per cross-cutting
-- registry).
--
-- NEW table: player_proficient_skills, keyed by skill_name (D&D 5e
-- canonical 18 skills). Avoids the existing player_skills' dependence
-- on cartridge skill_entity_ids that we don't author here.

-- Class 600 (Fighter) — backfill profile.
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
 WHERE id = 600 AND kind = 'class';

-- Class 601 (Rogue) — seed if missing.
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
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS player_proficient_skills (
  player_id BIGINT NOT NULL REFERENCES players(entity_id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  proficiency_level INTEGER NOT NULL DEFAULT 1, -- 1=proficient, 2=expertise
  PRIMARY KEY (player_id, skill_name)
);
