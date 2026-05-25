-- Spec 28 §A.1 — Origin templates (BG3-style preset gate).
--
-- Cartridge author ships 3-5 archetypes; the wizard gates the Identity
-- step on a "pick an Origin or build custom" choice. Click an Origin →
-- preset applied to all wizard state slots → jump to Confirm.
--
-- Storage: cartridge_meta JSONB (matches spec 33's surface_combo_rules
-- pattern). The wizard reads via /api/character/origins.

INSERT INTO cartridge_meta (key, value, description) VALUES (
  'origin_templates',
  jsonb_build_array(
    jsonb_build_object(
      'id', 'tiefling-charmer',
      'label', 'The Charmer',
      'blurb', 'Tiefling born with succubus heritage too close to the surface. Trades in attention.',
      'preset', jsonb_build_object(
        'identity', jsonb_build_object(
          'race', 'Tiefling',
          'gender_expression', 'feminine',
          'pronouns', 'she/her',
          'anatomy', 'female body + functional penis + vagina (intersex)',
          'attractions', 'pansexual, drawn to confidence',
          'age', 24
        ),
        'physical', jsonb_build_object(
          'build', '1.78m, athletic',
          'skin', 'lavender, smooth',
          'eyes', 'gold, slit pupils',
          'hair', 'black, braided',
          'voice', 'low, melodic',
          'distinguishing_marks', 'curling horns, brand on left shoulder'
        ),
        'background', jsonb_build_object(
          'origin_paragraph', 'Raised in a brothel-temple at the edge of the Lavender Quarter, sold a debt-tally to a fixer at fourteen, working it off a coin at a time.',
          'motivation', 'Pay off the debt, then disappear',
          'temperament', 'wry, deliberate, easily nettled',
          'notable_skills', jsonb_build_array('fluent in Infernal', 'trained for melee')
        ),
        'starting_class_id', 600,
        'stats', jsonb_build_object('STR', 12, 'DEX', 14, 'CON', 13, 'INT', 10, 'WIS', 11, 'CHA', 16),
        'stat_method', 'standard_array',
        'skills', jsonb_build_array('Persuasion', 'Deception', 'Insight', 'Performance')
      )
    ),
    jsonb_build_object(
      'id', 'goblin-fixer',
      'label', 'The Fixer',
      'blurb', 'Quickgrin Lane local. Knows where every coin lands. Few qualms.',
      'preset', jsonb_build_object(
        'identity', jsonb_build_object(
          'race', 'Goblin',
          'gender_expression', 'androgynous',
          'pronouns', 'they/them',
          'anatomy', 'small frame, male body, scarred',
          'attractions', 'transactional; affection comes after coin',
          'age', 31
        ),
        'physical', jsonb_build_object(
          'build', '1.30m, wiry',
          'skin', 'mottled green-grey',
          'eyes', 'amber, narrow',
          'hair', 'tied black tuft',
          'voice', 'rasping, fast',
          'distinguishing_marks', 'missing left ear, three-fingered right hand'
        ),
        'background', jsonb_build_object(
          'origin_paragraph', 'Born in the under-stalls. Ran errands for cutpurses by seven; ran the cutpurses by twelve. Owns no property, holds two dozen markers.',
          'motivation', 'Buy the lane outright before someone else does',
          'temperament', 'sharp, transactional, suddenly tender',
          'notable_skills', jsonb_build_array('lockpicking', 'bargaining', 'street alchemy')
        ),
        'starting_class_id', 600,
        'stats', jsonb_build_object('STR', 10, 'DEX', 16, 'CON', 12, 'INT', 14, 'WIS', 13, 'CHA', 11),
        'stat_method', 'standard_array',
        'skills', jsonb_build_array('Sleight of Hand', 'Stealth', 'Investigation', 'Insight')
      )
    ),
    jsonb_build_object(
      'id', 'human-veteran',
      'label', 'The Veteran',
      'blurb', 'Survived a portal-war. Slow to anger, slower to forgive.',
      'preset', jsonb_build_object(
        'identity', jsonb_build_object(
          'race', 'Human',
          'gender_expression', 'masculine',
          'pronouns', 'he/him',
          'anatomy', 'large male body, scarred from old wounds',
          'attractions', 'private; falls hard, slowly',
          'age', 42
        ),
        'physical', jsonb_build_object(
          'build', '1.92m, broad, weathered',
          'skin', 'sun-darkened, lined',
          'eyes', 'grey, tired',
          'hair', 'iron, cropped',
          'voice', 'low, gravelled',
          'distinguishing_marks', 'long scar from temple to jaw, missing two fingers (right hand)'
        ),
        'background', jsonb_build_object(
          'origin_paragraph', 'Drafted into the Crown levy at nineteen, came back from the Riftgate Wars with a captain''s pension and night-terrors. Drinks alone, sleeps light.',
          'motivation', 'Find the comrades who survived; bury the ones who didn''t',
          'temperament', 'patient, quiet, deadly when slighted',
          'notable_skills', jsonb_build_array('cavalry', 'field medicine', 'reading enemy formations')
        ),
        'starting_class_id', 600,
        'stats', jsonb_build_object('STR', 16, 'DEX', 12, 'CON', 15, 'INT', 11, 'WIS', 13, 'CHA', 10),
        'stat_method', 'standard_array',
        'skills', jsonb_build_array('Athletics', 'Survival', 'Medicine', 'Intimidation')
      )
    )
  ),
  'BG3-style origin templates surfaced before the Identity step. Wizard StepOrigin reads this via GET /api/character/origins. Cartridge author can extend the array.'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
