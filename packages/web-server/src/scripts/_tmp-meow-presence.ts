import {loadPresentPeopleAtLocation} from '../locationPresence.js';
import {activeCartridgeId} from '../cartridgeScope.js';
import {query, closeDb} from '../db.js';

const cartridgeId = await activeCartridgeId();
console.log('cartridge:', cartridgeId);

const meow = 201012;
const ale = 201019;

for (const [name, id] of [['Meow Meow Paradise', meow], ['Ale & Eats', ale]] as const) {
  console.log('\n=====', name, id, '=====');

  const direct = await query(
    `SELECT id, display_name,
            profile->>'home_id' AS home_id,
            profile->>'current_location_id' AS curr,
            profile->>'location_id' AS loc
       FROM entities
      WHERE kind='person'
        AND (profile->>'home_id'=$1 OR profile->>'current_location_id'=$1 OR profile->>'location_id'=$1)`,
    [String(id)],
  );
  console.log('direct field match:', direct.rows.length);
  for (const r of direct.rows) console.log(' ', JSON.stringify(r));

  const density = await query(
    `SELECT profile->'local_density'->'npc_ids' AS npc_ids,
            profile->'local_density_summary' AS summary
       FROM entities WHERE id=$1`,
    [id],
  );
  console.log('local_density.npc_ids:', JSON.stringify(density.rows[0]?.npc_ids));
  console.log('summary:', JSON.stringify(density.rows[0]?.summary));

  const sceneParticipants = await query(
    `SELECT s.id AS scene_id, s.display_name AS scene_name,
            s.profile->'participant_entity_ids' AS participants
       FROM entities s
      WHERE s.kind='scene' AND s.profile->>'location_id'=$1`,
    [String(id)],
  );
  console.log('scenes here:', sceneParticipants.rows.length);
  for (const r of sceneParticipants.rows) console.log(' scene', r.scene_id, r.scene_name, 'participants:', JSON.stringify(r.participants));

  const present = await loadPresentPeopleAtLocation({
    locationId: id,
    cartridgeId,
    includeI18n: false,
  });
  console.log('loadPresentPeopleAtLocation returned:', present.length);
  for (const p of present) console.log(' ', p.id, p.display_name);
}

await closeDb();
