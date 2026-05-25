-- Spec 120 follow-up: the first robot scene must not leave a new player
-- staring at ambience only. Keep the guidance diegetic and DB-authored.

UPDATE entities
   SET profile = jsonb_set(
     profile,
     '{narrator_brief}',
     to_jsonb(
       'This scene is not a tutorial card. It is the first live protocol: invitation, assignment, execution, verification. Keep the player inside the action and surface state consequences. On the first uncertain player turn, end with a concrete diegetic next move: ask Klapaucius to issue the module, inspect the Prepared Task Module, or give Trurl a precise new task.'::text
     ),
     true
   ),
       updated_at = now()
 WHERE id = 12011
   AND kind = 'scene';
