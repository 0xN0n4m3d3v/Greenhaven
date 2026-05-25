import {
  activeCartridgeEntityPredicate,
  activeCartridgeId,
} from './cartridgeScope.js';
import {qualitySqlPredicate} from './contentQuality.js';
import {query} from './db.js';

/**
 * Compact list of NPC entity ids physically present at a location.
 * Drives `chat_messages.witness_entity_ids` so the per-NPC scoped
 * dialogue history can include messages spoken in the NPC's presence
 * (not just messages authored by the NPC or the active dialogue partner).
 * Backed by the same union query as `loadPresentPeopleAtLocation`, but
 * returns only the ids and is cheap enough to call on every narrate.
 */
export async function loadWitnessIdsForLocation(
  locationId: number | null,
  cartridgeId?: string,
): Promise<number[]> {
  if (locationId == null || !Number.isFinite(locationId)) return [];
  const cid = cartridgeId ?? (await activeCartridgeId());
  const rows = await loadPresentPeopleAtLocation({
    locationId,
    playerId: null,
    cartridgeId: cid,
    limit: 24,
  });
  return rows.map(r => r.id);
}

export interface PresentPersonRow {
  id: number;
  kind: string;
  display_name: string;
  summary: string | null;
  profile: Record<string, unknown> | null;
  tags: string[] | null;
  i18n?: Record<string, Record<string, unknown>> | null;
}

export interface LoadPresentPeopleOptions {
  locationId: number;
  playerId?: number | null;
  cartridgeId: string;
  companionIds?: number[];
  limit?: number;
  includeI18n?: boolean;
}

/**
 * Runtime presence resolver for a location.
 *
 * The cartridge has several valid ways to say that an NPC is physically present
 * in a place: direct home/current/location fields, precomputed
 * local_density.npc_ids, activity npc links, and quest givers. Authored scene
 * participants are intentionally excluded here: a scene can mention remote or
 * historical actors, and treating every potential scene participant as always
 * standing in the location leaks NPCs into the rail/map/profile surfaces.
 */
export async function loadPresentPeopleAtLocation({
  locationId,
  playerId = null,
  cartridgeId,
  companionIds = [],
  limit = 24,
  includeI18n = false,
}: LoadPresentPeopleOptions): Promise<PresentPersonRow[]> {
  const selectI18n = includeI18n ? ', e.i18n' : '';
  const rows = await query<PresentPersonRow>(
    `WITH current_location AS (
       SELECT profile
         FROM entities
        WHERE id = $1
          AND kind IN ('location', 'district')
     ),
     density_people AS (
       -- M-5: safe_to_bigint filters malformed and bigint-overflow ids
       -- to NULL so a single garbage entry can no longer abort the
       -- whole presence query.
       -- M-6: safe_jsonb_array hardens the array-shape guard against
       -- missing keys and non-array authored payloads.
       SELECT safe_to_bigint(value) AS id
         FROM current_location
         CROSS JOIN LATERAL jsonb_array_elements_text(
           safe_jsonb_array(profile->'local_density'->'npc_ids')
         ) AS value
        WHERE safe_to_bigint(value) IS NOT NULL
     ),
     activity_people AS (
       SELECT safe_to_bigint(a.profile->>'npc_entity_id') AS id
         FROM entities a
        WHERE a.kind = 'activity'
          AND ${activeCartridgeEntityPredicate('a', '$4')}
          AND a.profile->>'location_id' = $1::text
          AND safe_to_bigint(a.profile->>'npc_entity_id') IS NOT NULL
     ),
     quest_people AS (
       SELECT safe_to_bigint(giver.value) AS id
         FROM entities q
         CROSS JOIN LATERAL (
           VALUES
             (q.profile->>'giver_entity_id'),
             (q.profile->>'giver_id'),
             (q.profile->>'quest_giver_id'),
             (q.profile->>'source_entity_id')
         ) AS giver(value)
        WHERE q.kind = 'quest'
          AND ${activeCartridgeEntityPredicate('q', '$4')}
          AND q.profile->>'location_id' = $1::text
          AND safe_to_bigint(giver.value) IS NOT NULL
     ),
     linked_people AS (
       SELECT id FROM density_people
       UNION SELECT id FROM activity_people
       UNION SELECT id FROM quest_people
     )
     SELECT e.id, e.kind, e.display_name, e.summary, e.profile, e.tags${selectI18n}
       FROM entities e
      WHERE e.kind = 'person'
        AND (e.profile->>'hidden_until_stage') IS NULL
        AND ${activeCartridgeEntityPredicate('e', '$4')}
        AND ${qualitySqlPredicate('e')}
        AND (
          e.profile->>'home_id' = $1::text
          OR e.profile->>'current_location_id' = $1::text
          OR e.profile->>'location_id' = $1::text
          OR e.id IN (SELECT id FROM linked_people)
          OR e.id = ANY($3::bigint[])
        )
        AND (
          $2::bigint IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM actor_statuses s
             WHERE s.player_id = $2::bigint
               AND s.actor_entity_id = e.id
               AND s.intensity > 0
               AND s.status_kind IN ('dead', 'missing')
          )
        )
      ORDER BY CASE
                 WHEN e.profile->>'location_id' = $1::text THEN 0
                 WHEN e.profile->>'current_location_id' = $1::text THEN 1
                 WHEN e.profile->>'home_id' = $1::text THEN 2
                 WHEN e.id IN (SELECT id FROM density_people) THEN 3
                 WHEN e.id IN (SELECT id FROM activity_people) THEN 4
                 WHEN e.id IN (SELECT id FROM quest_people) THEN 5
                 WHEN e.id = ANY($3::bigint[]) THEN 6
                 ELSE 7
               END,
               e.display_name
      LIMIT $5`,
    [locationId, playerId, companionIds, cartridgeId, limit],
  );
  return rows.rows;
}
