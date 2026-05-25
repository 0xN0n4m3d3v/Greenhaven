import {evaluateObjective} from '../quest/objectiveEvaluators.js';
import {query} from '../db.js';
import {
  activeCartridgeEntityPredicate,
} from '../cartridgeScope.js';
import {qualitySqlPredicate} from '../contentQuality.js';
import {
  loc,
  locNestedProfileText,
  locQuestStageField,
} from '../i18n.js';
import {telemetry} from '../telemetry/index.js';
import {getEntityRuntimeContext} from '../tools/runtimeContext.js';
import {
  buildQuestDirectorPacket,
  renderQuestDirectorPacket,
} from '../quest/questDirectorPacket.js';
import {
  renderInstructions,
  renderRuntime,
} from './entitySections.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';
/**
 * Cartridge-stable AVAILABLE QUESTS block — quests whose giver / scene
 * / location matches the player's current frame but which haven't been
 * started yet. The recipe text is the cartridge author's canonical
 * "if the player commits, here's how the quest unfolds" — the model
 * needs it BEFORE start_quest fires. Static because availability
 * doesn't change mid-conversation; the moment a player commits, the
 * row jumps into ACTIVE QUESTS (see renderActiveQuestsState).
 */
export async function renderAvailableQuests(
  playerId: number,
  currentLocationId: number | null,
  currentSceneId: number | null,
  lang = 'en',
): Promise<string> {
  const cartridgeId = await resolveActivePlayerCartridgeId(playerId);
  const availableRowsRaw = await query<{
    id: number;
    display_name: string;
    summary: string | null;
    i18n: Record<string, Record<string, unknown>> | null;
  }>(
    `WITH current_location AS (
       SELECT profile
         FROM entities
        WHERE id = $2
          AND kind IN ('location', 'district')
     ),
     density_people AS (
       -- M-5: safe_to_bigint filters malformed and bigint-overflow ids
       -- to NULL so a garbage id in local_density/scene/activity JSON
       -- can no longer abort the available-quest resolution.
       -- M-6: safe_jsonb_array hardens the array-shape guard.
       SELECT safe_to_bigint(value) AS id
         FROM current_location
         CROSS JOIN LATERAL jsonb_array_elements_text(
           safe_jsonb_array(profile->'local_density'->'npc_ids')
         ) AS value
        WHERE safe_to_bigint(value) IS NOT NULL
     ),
     scene_people AS (
       SELECT safe_to_bigint(value) AS id
         FROM entities s
         CROSS JOIN LATERAL jsonb_array_elements_text(
           safe_jsonb_array(s.profile->'participant_entity_ids')
         ) AS value
        WHERE s.kind = 'scene'
          AND ${activeCartridgeEntityPredicate('s', '$4')}
          AND s.profile->>'location_id' = $2::text
          AND safe_to_bigint(value) IS NOT NULL
     ),
     activity_people AS (
       SELECT safe_to_bigint(a.profile->>'npc_entity_id') AS id
         FROM entities a
        WHERE a.kind = 'activity'
          AND ${activeCartridgeEntityPredicate('a', '$4')}
          AND a.profile->>'location_id' = $2::text
          AND safe_to_bigint(a.profile->>'npc_entity_id') IS NOT NULL
     ),
     present_people AS (
       SELECT p.id
         FROM entities p
        WHERE p.kind = 'person'
          AND ${activeCartridgeEntityPredicate('p', '$4')}
          AND ${qualitySqlPredicate('p')}
          AND (
            p.profile->>'home_id' = $2::text
            OR p.profile->>'current_location_id' = $2::text
            OR p.profile->>'location_id' = $2::text
            OR p.id IN (SELECT id FROM density_people)
            OR p.id IN (SELECT id FROM scene_people)
            OR p.id IN (SELECT id FROM activity_people)
          )
          AND NOT EXISTS (
            SELECT 1 FROM actor_statuses s
             WHERE s.player_id = $1
               AND s.actor_entity_id = p.id
               AND s.intensity > 0
               AND s.status_kind IN ('dead', 'missing')
          )
     )
     SELECT q.id, q.display_name, q.summary, q.i18n
       FROM entities q
      WHERE q.kind = 'quest'
        AND ${activeCartridgeEntityPredicate('q', '$4')}
        AND q.id NOT IN (
          SELECT quest_entity_id FROM player_quests WHERE player_id = $1
        )
        AND (
          (q.profile->>'giver_entity_id') IN (SELECT id::text FROM present_people)
          OR (q.profile->>'giver_id') IN (SELECT id::text FROM present_people)
          OR (q.profile->>'quest_giver_id') IN (SELECT id::text FROM present_people)
          OR (q.profile->>'source_entity_id') IN (SELECT id::text FROM present_people)
          OR ($3::bigint IS NOT NULL AND safe_to_bigint(q.profile->>'scene_id') = $3::bigint)
          OR ($2::bigint IS NOT NULL AND safe_to_bigint(q.profile->>'location_id') = $2::bigint)
        )`,
    [playerId, currentLocationId, currentSceneId, cartridgeId],
  );
  const availableRows = {
    rows: availableRowsRaw.rows.map(r => ({
      id: r.id,
      display_name: r.display_name,
      summary: loc(r as never, lang, 'summary', r.summary),
    })),
  };

  if (availableRows.rows.length === 0) return '';

  const out: string[] = [];
  out.push('## AVAILABLE QUESTS HERE');
  out.push(
    '> These quests are NOT yet active for this player but their giver / scene / location is in the current frame. ' +
      'Their `instructions` are the cartridge-authored recipes — read them now so you know how to handle a player who acts on the quest hooks (payments, requests, refusals). ' +
      'When the player commits to one (offers gold, agrees to a task), call `start_quest` to activate it AND execute the recipe steps in the same turn.',
  );
  for (const q of availableRows.rows) {
    out.push(`### ${q.display_name} (id ${q.id}, status: available)`);
    if (q.summary) out.push(`> ${q.summary}`);
    const ctx = await getEntityRuntimeContext(q.id, playerId);
    const ins = renderInstructions(ctx);
    if (ins) out.push(ins);
  }
  return out.join('\n');
}

/**
 * Per-turn ACTIVE QUESTS block — current phase, completed objectives,
 * runtime fields. Mutates as the player progresses through the recipe,
 * so always lives in the dynamic context.
 */
export async function renderActiveQuestsState(playerId: number, lang = 'en'): Promise<string> {
  const cartridgeId = await resolveActivePlayerCartridgeId(playerId);
  const activeRows = await query<{
    quest_entity_id: number;
    display_name: string;
    summary: string | null;
    i18n: Record<string, Record<string, unknown>> | null;
    status: string;
    current_phase: number | null;
    current_stage_id: string | null;
    profile: unknown;
    accumulated_state: unknown;
  }>(
    `SELECT pq.quest_entity_id, e.display_name, e.summary, pq.status,
            pq.current_phase, pq.current_stage_id, e.profile, e.i18n,
            pq.accumulated_state
       FROM player_quests pq
       JOIN entities e ON e.id = pq.quest_entity_id
      WHERE pq.player_id = $1
        AND pq.status = 'active'
        AND ${activeCartridgeEntityPredicate('e', '$2')}
      ORDER BY pq.started_at`,
    [playerId, cartridgeId],
  );
  if (activeRows.rows.length === 0) return '';

  const out: string[] = [];

  // Spec 49 — Quest Pacer signals from players.metadata.quest_pacer.
  // Surfaced ABOVE active quests so broker reads them before any
  // per-quest detail. Each signal carries a concrete suggestion.
  try {
    const pacerRow = await query<{pacer: Record<string, unknown> | null}>(
      `SELECT (metadata->'quest_pacer') AS pacer FROM players WHERE entity_id = $1`,
      [playerId],
    );
    const pacer = pacerRow.rows[0]?.pacer;
    if (
      pacer &&
      typeof pacer === 'object' &&
      Array.isArray((pacer as Record<string, unknown>)['signals'])
    ) {
      const signals = (pacer as Record<string, unknown>)['signals'] as Array<
        Record<string, unknown>
      >;
      if (signals.length > 0) {
        out.push('## QUEST PACER');
        for (const s of signals) {
          const type = String(s['signal_type'] ?? '');
          const title = (s['quest_title'] as string) ?? '';
          const details = (s['details'] as string) ?? '';
          const suggestion = (s['suggestion'] as string) ?? '';
          const titlePart = title ? ` @${title}` : '';
          out.push(`- [${type}]${titlePart}: ${details} — ${suggestion}`);
        }
        out.push('');
      }
    }
  } catch (err) {
    telemetry.record({
      channel: 'gameplay',
      name: 'turn_context.quest_pacer.surface_failed',
      playerId,
      error: err,
      data: {
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }

  out.push('## ACTIVE QUESTS');
  for (const q of activeRows.rows) {
    const profile = (q.profile ?? {}) as Record<string, unknown>;
    const stages = Array.isArray(profile['stages'])
      ? (profile['stages'] as Array<Record<string, unknown>>)
      : [];
    const currentStage = stages.find(s => s['id'] === q.current_stage_id);
    const questRecord = {
      i18n: q.i18n ?? null,
    };
    const questName = q.display_name;
    const questSummary = loc(questRecord, lang, 'summary', q.summary);
    const stageName = currentStage
      ? locQuestStageField(
          questRecord,
          lang,
          currentStage,
          'name',
          currentStage['name'],
        )
      : null;
    const stageHeader =
      currentStage != null && typeof stageName === 'string'
        ? `, stage *${stageName}*`
        : `, phase ${q.current_phase ?? '?'}`;
    out.push(
      `### ${questName} (id ${q.quest_entity_id}${stageHeader}, status ${q.status})`,
    );
    if (questSummary) out.push(`> ${questSummary}`);
    try {
      const director = await buildQuestDirectorPacket({
        playerId,
        questId: q.quest_entity_id,
      });
      if (director) out.push(renderQuestDirectorPacket(director));
    } catch (err) {
      telemetry.record({
        channel: 'gameplay',
        name: 'turn_context.quest_director.packet_failed',
        playerId,
        error: err,
        data: {
          questId: q.quest_entity_id,
          currentStageId: q.current_stage_id,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
    const partyLine = await renderQuestPartyLine(profile, playerId);
    if (partyLine) out.push(partyLine);
    const questItemLines = await renderQuestItemLines(profile, playerId);
    if (questItemLines) out.push(questItemLines);
    if (typeof profile['goal'] === 'string' && profile['goal'].trim()) {
      out.push(`  Goal: ${profile['goal'].trim()}`);
    }
    if (currentStage) {
      const desc = locQuestStageField(
        questRecord,
        lang,
        currentStage,
        'description',
        currentStage['description'],
      );
      if (typeof desc === 'string' && desc.length > 0) out.push(`  ${desc}`);

      // Spec 25 — timer + choice indicators on the stage.
      const accState = (q.accumulated_state ?? {}) as Record<string, unknown>;
      if (typeof accState['turns_remaining'] === 'number') {
        out.push(`  ⏳ ${accState['turns_remaining']} turn(s) remaining`);
      }
      const ns = currentStage['next_stage'] as
        | Record<string, unknown>
        | string
        | null
        | undefined;
      if (
        ns &&
        typeof ns === 'object' &&
        !Array.isArray(ns) &&
        ns['kind'] === 'choice' &&
        Array.isArray(ns['options'])
      ) {
        const labels = (ns['options'] as Array<Record<string, unknown>>)
          .map(o => {
            const optionId =
              typeof o['id'] === 'string'
                ? o['id']
                : typeof o['key'] === 'string'
                  ? o['key']
                  : typeof o['slug'] === 'string'
                    ? o['slug']
                    : null;
            const label = o['label'];
            if (optionId && typeof label === 'string') {
              return locNestedProfileText(
                questRecord,
                lang,
                [
                  'stages',
                  String(currentStage['id']),
                  'next_stage',
                  'options',
                  optionId,
                  'label',
                ],
                label,
              );
            }
            return String(label ?? '');
          })
          .filter(s => s.length > 0)
          .join(' / ');
        out.push(`  ⚡ choice required: ${labels}`);
      }

      const objectives = Array.isArray(currentStage['objectives'])
        ? (currentStage['objectives'] as Array<Record<string, unknown>>)
        : [];
      for (const obj of objectives) {
        const r = await evaluateObjective(obj, {
          playerId,
          sessionId: '',
          recentToolCalls: [],
        });
        const mark = r.satisfied ? '✓' : '☐';
        const detail = r.detail ? ` (${r.detail})` : '';
        out.push(`  ${mark} ${describeObjective(obj)}${detail}`);
      }
    }
    const ctx = await getEntityRuntimeContext(q.quest_entity_id, playerId);
    const rt = renderRuntime(ctx);
    if (rt) out.push(rt);
    const ins = renderInstructions(ctx);
    if (ins) out.push(ins);
  }
  return out.join('\n');
}

/**
 * Spec 21 — turn an objective JSON object into a human-readable line
 * for the preamble. Spec 22 will reuse this when it adds the ✓/☐
 * status markers; keep the formatter centralised here.
 */
export function describeObjective(obj: Record<string, unknown>): string {
  const kind = obj['kind'];
  if (kind === 'tool_called') {
    const tool = obj['tool'] ?? '<tool>';
    const args = (obj['args_match'] ?? {}) as Record<string, unknown>;
    const argsList = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    return `Call \`${tool}\`${argsList ? ` with ${argsList}` : ''}`;
  }
  if (kind === 'field_threshold') {
    return `${obj['field_key']} on entity ${obj['owner_entity_id']} ${obj['op']} ${JSON.stringify(obj['value'])}`;
  }
  if (kind === 'string_threshold') {
    return `Earn strings on @${obj['npc']} ${obj['op']} ${obj['value']}`;
  }
  if (kind === 'condition_present') {
    return `Apply condition \`${obj['tag']}\` to entity ${obj['owner_entity_id']}`;
  }
  if (kind === 'narrate_text_match') {
    return `Narrate text matches /${obj['regex']}/`;
  }
  return `Objective: ${JSON.stringify(obj)}`;
}

async function renderQuestPartyLine(
  profile: Record<string, unknown>,
  playerId: number,
): Promise<string | null> {
  const giverId = readQuestEntityId(
    profile['giver_entity_id'] ??
      profile['giver_id'] ??
      profile['source_entity_id'] ??
      profile['quest_giver_id'],
  );
  const beneficiaryId = readQuestEntityId(profile['beneficiary_entity_id']);
  if (giverId == null && beneficiaryId == null) return null;

  const ids = [giverId, beneficiaryId]
    .filter((id): id is number => id != null)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  const names = ids.length
    ? await query<{id: number; display_name: string}>(
        `SELECT id, display_name FROM entities WHERE id = ANY($1::bigint[])`,
        [ids],
      )
    : {rows: [] as Array<{id: number; display_name: string}>};
  const byId = new Map(names.rows.map(row => [Number(row.id), row.display_name]));
  const parts: string[] = [];
  if (giverId != null) {
    parts.push(`Giver/source: @${byId.get(giverId) ?? giverId} (id ${giverId})`);
  }
  if (beneficiaryId != null) {
    const label =
      beneficiaryId === playerId
        ? 'active player'
        : `@${byId.get(beneficiaryId) ?? beneficiaryId}`;
    parts.push(`Beneficiary: ${label} (id ${beneficiaryId})`);
  }
  return parts.length ? `  ${parts.join('; ')}` : null;
}

interface QuestItemRef {
  entityId: number;
  label: string | null;
  slug: string | null;
}

interface QuestItemRow {
  entity_id: number;
  display_name: string;
  item_id: number | null;
  slug: string | null;
  player_quantity: number | string;
}

interface QuestItemHolderRow {
  item_entity_id: number;
  holder_entity_id: number;
  holder_name: string;
  count: number | string;
}

async function renderQuestItemLines(
  profile: Record<string, unknown>,
  playerId: number,
): Promise<string | null> {
  const refs = readQuestItemRefs(profile['quest_items']);
  if (refs.length === 0) return null;
  const entityIds = refs.map(ref => ref.entityId);
  const rows = await query<QuestItemRow>(
    `SELECT e.id AS entity_id, e.display_name, i.id AS item_id, i.slug,
            COALESCE(SUM(pi.quantity), 0)::int AS player_quantity
       FROM entities e
       LEFT JOIN items i ON i.legacy_entity_id = e.id
       LEFT JOIN player_inventory pi
              ON pi.item_id = i.id
             AND pi.player_id = $2
      WHERE e.id = ANY($1::bigint[])
      GROUP BY e.id, e.display_name, i.id, i.slug
      ORDER BY e.id`,
    [entityIds, playerId],
  );
  const holderRows = await query<QuestItemHolderRow>(
    `SELECT ie.item_entity_id, ie.holder_entity_id,
            h.display_name AS holder_name, ie.count
       FROM inventory_entries ie
       JOIN entities h ON h.id = ie.holder_entity_id
      WHERE ie.item_entity_id = ANY($1::bigint[])
        AND ie.count > 0
      ORDER BY ie.item_entity_id, ie.holder_entity_id`,
    [entityIds],
  );
  const holderByItem = new Map<number, QuestItemHolderRow[]>();
  for (const row of holderRows.rows) {
    const list = holderByItem.get(Number(row.item_entity_id)) ?? [];
    list.push(row);
    holderByItem.set(Number(row.item_entity_id), list);
  }
  const refById = new Map(refs.map(ref => [ref.entityId, ref]));
  const lines = [
    '  Quest items (authoritative state; use inventory_transfer before carry/delivery/hand-off narration):',
  ];
  for (const row of rows.rows) {
    const ref = refById.get(Number(row.entity_id));
    const name = ref?.label ?? row.display_name;
    const slug = row.slug ?? ref?.slug ?? null;
    const playerQty = Number(row.player_quantity ?? 0);
    const holders = holderByItem.get(Number(row.entity_id)) ?? [];
    const holderText: string[] = [];
    if (playerQty > 0) holderText.push(`active player x${playerQty}`);
    for (const holder of holders) {
      holderText.push(
        `@${holder.holder_name} (id ${holder.holder_entity_id}) x${Number(holder.count)}`,
      );
    }
    lines.push(
      `    - @${name} (entity ${row.entity_id}${slug ? `, slug ${slug}` : ''}): ` +
        (holderText.length > 0 ? holderText.join('; ') : 'not currently held'),
    );
  }
  return lines.join('\n');
}

function readQuestItemRefs(value: unknown): QuestItemRef[] {
  if (!Array.isArray(value)) return [];
  const refs: QuestItemRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const entityId = readQuestEntityId(record['entity_id']);
    if (entityId == null) continue;
    refs.push({
      entityId,
      label:
        typeof record['display_name'] === 'string' && record['display_name'].trim()
          ? record['display_name'].trim()
          : null,
      slug:
        typeof record['slug'] === 'string' && record['slug'].trim()
          ? record['slug'].trim()
          : null,
    });
  }
  return refs.slice(0, 8);
}

function readQuestEntityId(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}
