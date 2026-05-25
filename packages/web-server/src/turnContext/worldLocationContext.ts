import {query} from '../db.js';
import {
  activeCartridgeEntityPredicate,
  activeCartridgeId,
} from '../cartridgeScope.js';
import {qualitySqlPredicate} from '../contentQuality.js';
import {getCartridgeMeta, getMeta} from '../cartridge.js';
import {loadPresentPeopleAtLocation} from '../locationPresence.js';
import {loadVisibleReachableLocations} from '../locationGraph.js';
import {bandFor} from '../tools/strings.js';
import {
  localizeEntity,
  renderCheck,
  renderSocialDcs,
  type EntityRow,
} from './entitySections.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';
import {
  listMaterializerEntries,
  type MaterializerEntry,
} from '../services/MaterializerBridgeService.js';

export async function renderAtmosphere(
  playerId: number | null = null,
): Promise<string | null> {
  const worldEntityId = await worldEntityIdForPlayer(playerId);
  if (worldEntityId == null) return null;
  const atmosRows = await query<{field_key: string; value: unknown}>(
    `SELECT rf.field_key, rv.value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = $1
        AND rf.field_key IN ('time_of_day', 'weather')`,
    [worldEntityId],
  );
  const atmosMap: Record<string, string> = {};
  for (const row of atmosRows.rows) {
    if (typeof row.value === 'string') atmosMap[row.field_key] = row.value;
  }
  if (!atmosMap['time_of_day'] && !atmosMap['weather']) return null;
  const time = atmosMap['time_of_day'] ?? 'unknown';
  const weather = atmosMap['weather'] ?? 'clear';
  return `## ATMOSPHERE\nTime: ${time} - Weather: ${weather}`;
}

export async function worldEntityIdForPlayer(
  playerId: number | null = null,
): Promise<number | null> {
  if (playerId != null) {
    try {
      const cartridgeId = await resolveActivePlayerCartridgeId(playerId);
      return (
        (await getCartridgeMeta<number | null>(
          cartridgeId,
          'world_entity_id',
          null,
        )) ?? null
      );
    } catch {
      // Clean baseline / no launched cartridge yet: world context is
      // optional, so retain the legacy fail-open behaviour.
    }
  }
  return (await getMeta<number | null>('world_entity_id', null)) ?? null;
}

export async function renderActiveSurfaces(
  locationId: number,
): Promise<string | null> {
  const surfacesRow = await query<{value: unknown}>(
    `SELECT rv.value FROM runtime_values rv
       JOIN runtime_fields rf ON rf.id = rv.field_id
      WHERE rf.owner_entity_id = $1 AND rf.field_key = 'active_surfaces'`,
    [locationId],
  );
  const surfaces = Array.isArray(surfacesRow.rows[0]?.value)
    ? (surfacesRow.rows[0]!.value as Array<Record<string, unknown>>)
    : [];
  if (surfaces.length === 0) return null;
  const list = surfaces
    .map(
      surface =>
        `${surface['type']}(${surface['severity'] ?? 1}, ${surface['area'] ?? 'scattered'})`,
    )
    .join(', ');
  return `## ACTIVE SURFACES\n${list}`;
}

export async function renderWorldCatalogue(
  excludeLocationId: number | null,
  lang: string,
  playerId: number | null = null,
): Promise<string> {
  const cartridgeId =
    playerId != null
      ? await resolveActivePlayerCartridgeId(playerId)
      : await activeCartridgeId();
  const rows = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, i18n
       FROM entities
      WHERE kind IN ('location', 'scene', 'person', 'item', 'quest', 'district')
        AND (profile->>'hidden_until_stage') IS NULL
        AND ($1::bigint IS NULL OR id <> $1::bigint)
        AND ${activeCartridgeEntityPredicate('entities', '$2')}
        AND ${qualitySqlPredicate('entities')}
      ORDER BY kind, id
      LIMIT 80`,
    [excludeLocationId, cartridgeId],
  );

  const localized = rows.rows.map(row => localizeEntity(row, lang));
  const byKind = new Map<string, EntityRow[]>();
  for (const entity of localized) {
    const list = byKind.get(entity.kind) ?? [];
    list.push(entity);
    byKind.set(entity.kind, list);
  }

  const formatList = (list: EntityRow[]): string =>
    list
      .map(entity => {
        const dyn = (entity.tags ?? []).includes('dynamic') ? '[dyn]' : '';
        return `@${entity.display_name} (${entity.id})${dyn}`;
      })
      .join(', ');

  const lines: string[] = [
    '## WORLD CATALOGUE - off-stage entities (use exact `@Name` in narrate / create_quest; query_entity(name) for details)',
  ];
  const order: Array<[string, string]> = [
    ['location', 'Locations'],
    ['district', 'Districts'],
    ['scene', 'Scenes'],
    ['person', 'People'],
    ['item', 'Items'],
    ['quest', 'Quests (start_quest by name - do NOT re-create)'],
  ];
  for (const [kind, label] of order) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    lines.push(`- ${label}: ${formatList(list)}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function renderNeighbours(
  locationId: number,
  playerId: number | null,
  lang = 'en',
): Promise<string> {
  const cartridgeId =
    playerId != null
      ? await resolveActivePlayerCartridgeId(playerId)
      : await activeCartridgeId();
  const companionIds = await loadCompanionIds(playerId);
  const companionIdSet = new Set(companionIds);
  const npcs = (await loadPresentPeopleAtLocation({
    locationId,
    playerId,
    cartridgeId,
    companionIds,
    limit: 32,
    includeI18n: true,
  })).map(row => localizeEntity(row as EntityRow, lang));

  const npcHp = new Map<number, {current: number; max: number}>();
  const npcCombat = new Map<number, {ac?: number; prof?: number}>();
  const npcStats = new Map<
    number,
    Array<{stat: string; cur: number; mod: number}>
  >();
  await loadNpcCombatSummaries(npcs, npcHp, npcCombat, npcStats);

  const npcConditions = await loadNpcConditions(npcs);
  const npcStrings = await loadNpcStrings(npcs, playerId);
  const npcHeldItems = await loadNpcHeldItems(npcs, cartridgeId);
  const npcStatuses = await loadNpcStatuses(npcs, playerId);

  const items = await query<EntityRow & {count: number}>(
    `SELECT e.id, e.kind, e.display_name, e.summary, e.profile, e.tags, i.count, e.i18n
      FROM inventory_entries i
       JOIN entities e ON e.id = i.item_entity_id
      WHERE i.holder_entity_id = $1 AND i.count > 0
        AND (e.profile->>'hidden_until_stage') IS NULL
        AND ${activeCartridgeEntityPredicate('e', '$2')}
        AND ${qualitySqlPredicate('e')}`,
    [locationId, cartridgeId],
  );
  const exits = (await loadVisibleReachableLocations(locationId)).map(row =>
    localizeEntity(row, lang),
  );
  const localHooks = await loadLocalHooks(locationId, cartridgeId, lang);
  const materializers = await loadLocalMaterializers({
    locationId,
    playerId,
    cartridgeId,
    localEntityIds: [
      locationId,
      ...npcs.map(npc => npc.id),
      ...items.rows.map(item => item.id),
      ...localHooks.map(hook => hook.id),
    ],
  });

  return [
    renderPeopleHere(
      npcs,
      npcHp,
      npcCombat,
      npcStats,
      npcConditions,
      npcStrings,
      npcHeldItems,
      companionIdSet,
      npcStatuses,
    ),
    renderItemsHere(items.rows.map(row => localizeEntity(row, lang))),
    renderExits(exits),
    renderLocalHooks(localHooks),
    renderMaterializerHooks(materializers),
  ].filter(Boolean).join('\n\n');
}

async function loadLocalMaterializers(input: {
  locationId: number;
  playerId: number | null;
  cartridgeId: string;
  localEntityIds: number[];
}): Promise<MaterializerEntry[]> {
  const entries = await listMaterializerEntries({cartridgeId: input.cartridgeId});
  if (entries.length === 0) return [];
  const localIds = new Set(input.localEntityIds);
  const appliedIds = await loadAppliedMaterializerIds(input.playerId);
  const visible: MaterializerEntry[] = [];
  for (const entry of entries) {
    if (appliedIds.has(entry.materializerId)) continue;
    const scopedHere = entry.scopeMentions.some(
      mention => mention.entityId === input.locationId,
    );
    const sourcedHere =
      entry.sourceEntityId != null && localIds.has(entry.sourceEntityId);
    if (!scopedHere && !sourcedHere) continue;
    visible.push(entry);
    if (visible.length >= 8) break;
  }
  return visible;
}

async function loadAppliedMaterializerIds(
  playerId: number | null,
): Promise<Set<string>> {
  if (playerId == null) return new Set();
  const rows = await query<{materializer_id: string}>(
    `SELECT metadata->>'materializer_id' AS materializer_id
       FROM npc_memories
      WHERE about_entity_id = $1
        AND memory_kind = 'materializer_applied'
        AND source_tool = 'apply_materializer_bridge'
        AND metadata ? 'materializer_id'`,
    [playerId],
  );
  return new Set(
    rows.rows
      .map(row => row.materializer_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}

async function loadLocalHooks(
  locationId: number,
  cartridgeId: string,
  lang: string,
): Promise<EntityRow[]> {
  const current = await query<{power_center_id: string | null}>(
    `SELECT profile->>'power_center_id' AS power_center_id
       FROM entities
      WHERE id = $1`,
    [locationId],
  );
  const powerCenterId = readPositiveId(current.rows[0]?.power_center_id);
  const scopeIds = powerCenterId != null && powerCenterId !== locationId
    ? [locationId, powerCenterId]
    : [locationId];
  const rows = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, i18n
       FROM entities
      WHERE kind IN ('scene', 'event', 'activity', 'quest')
        AND (profile->>'hidden_until_stage') IS NULL
        AND ${activeCartridgeEntityPredicate('entities', '$2')}
        AND ${qualitySqlPredicate('entities')}
        AND (
          profile->>'location_id' = ANY($1::text[])
          OR profile->>'home_id' = ANY($1::text[])
          OR profile->>'power_center_id' = ANY($1::text[])
        )
      ORDER BY CASE kind
                 WHEN 'quest' THEN 1
                 WHEN 'event' THEN 2
                 WHEN 'scene' THEN 3
                 WHEN 'activity' THEN 4
                 ELSE 5
               END,
               id
      LIMIT 64`,
    [scopeIds.map(String), cartridgeId],
  );
  const byKind = new Map<string, EntityRow[]>();
  for (const row of rows.rows.map(row => localizeEntity(row, lang))) {
    const list = byKind.get(row.kind) ?? [];
    if (list.length < 4) list.push(row);
    byKind.set(row.kind, list);
  }
  return [...byKind.values()].flat();
}

function readPositiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function loadCompanionIds(playerId: number | null): Promise<number[]> {
  if (playerId == null) return [];
  const rows = await query<{companions: number[] | null}>(
    `SELECT (metadata->'companions') AS companions
       FROM players WHERE entity_id = $1`,
    [playerId],
  );
  return Array.isArray(rows.rows[0]?.companions)
    ? (rows.rows[0]!.companions as number[])
    : [];
}

async function loadNpcCombatSummaries(
  npcs: EntityRow[],
  npcHp: Map<number, {current: number; max: number}>,
  npcCombat: Map<number, {ac?: number; prof?: number}>,
  npcStats: Map<number, Array<{stat: string; cur: number; mod: number}>>,
): Promise<void> {
  if (npcs.length === 0) return;
  const ids = npcs.map(row => row.id);
  const hpRows = await query<{
    owner_entity_id: number;
    field_key: string;
    effective_value: unknown;
  }>(
    `SELECT f.owner_entity_id, f.field_key,
            COALESCE(rv.value, f.default_value) AS effective_value
       FROM runtime_fields f
       LEFT JOIN runtime_values rv ON rv.field_id = f.id
      WHERE f.owner_entity_id = ANY($1::bigint[])
        AND f.field_key IN ('current_hp', 'max_hp', 'armor_class', 'proficiency_bonus')`,
    [ids],
  );
  for (const row of hpRows.rows) {
    const value = Number(row.effective_value);
    if (row.field_key === 'current_hp' || row.field_key === 'max_hp') {
      const existing = npcHp.get(row.owner_entity_id) ?? {current: 0, max: 0};
      if (row.field_key === 'current_hp') existing.current = value;
      else existing.max = value;
      npcHp.set(row.owner_entity_id, existing);
    } else {
      const existing = npcCombat.get(row.owner_entity_id) ?? {};
      if (row.field_key === 'armor_class') existing.ac = value;
      else if (row.field_key === 'proficiency_bonus') existing.prof = value;
      npcCombat.set(row.owner_entity_id, existing);
    }
  }

  const statRows = await query<{
    npc_entity_id: number;
    stat_key: string;
    current: number;
  }>(
    `SELECT npc_entity_id, stat_key, current
       FROM npc_stats
      WHERE npc_entity_id = ANY($1::bigint[])
      ORDER BY npc_entity_id,
        CASE stat_key WHEN 'STR' THEN 1 WHEN 'DEX' THEN 2 WHEN 'CON' THEN 3
                      WHEN 'INT' THEN 4 WHEN 'WIS' THEN 5 WHEN 'CHA' THEN 6 END`,
    [ids],
  );
  for (const row of statRows.rows) {
    const list = npcStats.get(row.npc_entity_id) ?? [];
    list.push({
      stat: row.stat_key,
      cur: row.current,
      mod: Math.floor((row.current - 10) / 2),
    });
    npcStats.set(row.npc_entity_id, list);
  }
}

async function loadNpcConditions(
  npcs: EntityRow[],
): Promise<Map<number, Array<{tag: string; severity: number}>>> {
  const out = new Map<number, Array<{tag: string; severity: number}>>();
  if (npcs.length === 0) return out;
  const ids = npcs.map(row => row.id);
  const condRows = await query<{owner_entity_id: number; value: unknown}>(
    `SELECT rf.owner_entity_id, rv.value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = ANY($1::bigint[])
        AND rf.field_key = 'conditions'`,
    [ids],
  );
  for (const row of condRows.rows) {
    if (!Array.isArray(row.value)) continue;
    const list = (row.value as Array<Record<string, unknown>>)
      .map(condition => ({
        tag: typeof condition['tag'] === 'string' ? condition['tag'] : '?',
        severity:
          typeof condition['severity'] === 'number'
            ? (condition['severity'] as number)
            : 1,
      }))
      .filter(condition => condition.tag !== '?');
    if (list.length > 0) out.set(row.owner_entity_id, list);
  }
  return out;
}

async function loadNpcStrings(
  npcs: EntityRow[],
  playerId: number | null,
): Promise<Map<number, {count: number; band: string}>> {
  const out = new Map<number, {count: number; band: string}>();
  if (npcs.length === 0 || playerId == null) return out;
  const ids = npcs.map(row => row.id);
  const strRows = await query<{owner_entity_id: number; value: unknown}>(
    `SELECT rf.owner_entity_id, rv.value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = ANY($1::bigint[])
        AND rf.field_key = 'strings'`,
    [ids],
  );
  for (const row of strRows.rows) {
    if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) {
      continue;
    }
    const map = row.value as Record<string, number>;
    const count = Number(map[String(playerId)] ?? 0);
    if (count !== 0) {
      out.set(row.owner_entity_id, {count, band: bandFor(count)});
    }
  }
  return out;
}

async function loadNpcHeldItems(
  npcs: EntityRow[],
  cartridgeId: string,
): Promise<Map<number, Array<{name: string; id: number; count: number}>>> {
  const out = new Map<number, Array<{name: string; id: number; count: number}>>();
  if (npcs.length === 0) return out;
  const ids = npcs.map(row => row.id);
  const rows = await query<{
    holder_entity_id: number;
    item_entity_id: number;
    display_name: string;
    count: number | string;
  }>(
    `SELECT ie.holder_entity_id, ie.item_entity_id,
            e.display_name, ie.count
       FROM inventory_entries ie
       JOIN entities e ON e.id = ie.item_entity_id
      WHERE ie.holder_entity_id = ANY($1::bigint[])
        AND ie.count > 0
        AND (e.profile->>'hidden_until_stage') IS NULL
        AND ${activeCartridgeEntityPredicate('e', '$2')}
        AND ${qualitySqlPredicate('e')}
      ORDER BY ie.holder_entity_id, e.display_name
      LIMIT 40`,
    [ids, cartridgeId],
  );
  for (const row of rows.rows) {
    const list = out.get(Number(row.holder_entity_id)) ?? [];
    if (list.length < 6) {
      list.push({
        name: row.display_name,
        id: Number(row.item_entity_id),
        count: Number(row.count),
      });
    }
    out.set(Number(row.holder_entity_id), list);
  }
  return out;
}

async function loadNpcStatuses(
  npcs: EntityRow[],
  playerId: number | null,
): Promise<Map<number, Array<{kind: string; value: string; intensity: number}>>> {
  const out = new Map<
    number,
    Array<{kind: string; value: string; intensity: number}>
  >();
  if (npcs.length === 0 || playerId == null) return out;
  const ids = npcs.map(row => row.id);
  const rows = await query<{
    actor_entity_id: number;
    status_kind: string;
    status_value: string;
    intensity: number;
  }>(
    `SELECT actor_entity_id, status_kind, status_value, intensity
       FROM actor_statuses
      WHERE player_id = $1
        AND actor_entity_id = ANY($2::bigint[])
        AND intensity > 0
      ORDER BY actor_entity_id, updated_at DESC
      LIMIT 80`,
    [playerId, ids],
  );
  for (const row of rows.rows) {
    const list = out.get(row.actor_entity_id) ?? [];
    if (list.length < 6) {
      list.push({
        kind: row.status_kind,
        value: row.status_value,
        intensity: Number(row.intensity ?? 0),
      });
    }
    out.set(row.actor_entity_id, list);
  }
  return out;
}

export function renderPeopleHere(
  npcs: EntityRow[],
  npcHp: Map<number, {current: number; max: number}>,
  npcCombat: Map<number, {ac?: number; prof?: number}>,
  npcStats: Map<number, Array<{stat: string; cur: number; mod: number}>>,
  npcConditions: Map<number, Array<{tag: string; severity: number}>>,
  npcStrings: Map<number, {count: number; band: string}>,
  npcHeldItems: Map<number, Array<{name: string; id: number; count: number}>>,
  companionIds: Set<number>,
  npcStatuses: Map<number, Array<{kind: string; value: string; intensity: number}>>,
): string {
  const lines: string[] = ['## PEOPLE HERE'];
  if (npcs.length === 0) {
    lines.push('  (nobody - the place is quiet)');
    return lines.join('\n');
  }
  // Hint for venue-side NPCs (innkeepers, vendors, owners): companions
  // of the player are full first-class actors in your scene. They can
  // rent rooms from you, buy services, deliver letters, accept deals,
  // share quests, occupy seats. When you see a companion-tag in this
  // list, treat any room/coin/item ask FROM that companion as a real
  // transaction request and canonize it with tools (record_location_memory,
  // inventory_transfer, set_actor_status) the same way you would for
  // the player. Otherwise the next conversation will look like
  // amnesia. See state-canonization.md.
  if (npcs.some(n => companionIds.has(n.id))) {
    lines.push(
      '  (note: companion-tagged NPCs in this list transact at this venue ' +
        'as first-class actors — canonize their asks with tools)',
    );
  }
  for (const npc of npcs) {
    const brief = npc.profile?.['narrator_brief'];
    const speech = npc.profile?.['speech_style'];
    const hp = npcHp.get(npc.id);
    const combat = npcCombat.get(npc.id);
    const stats = npcStats.get(npc.id) ?? [];
    const conditions = npcConditions.get(npc.id) ?? [];
    const strings = npcStrings.get(npc.id);
    const heldItems = npcHeldItems.get(npc.id) ?? [];
    const statuses = npcStatuses.get(npc.id) ?? [];
    const unavailable = unavailableStatus(statuses);
    if (unavailable) {
      lines.push(
        `  - **${npc.display_name}** (id ${npc.id})  - unavailable: ${unavailable.kind}=${unavailable.value}(${unavailable.intensity.toFixed(2)})${npc.summary ? ` - ${npc.summary}` : ''}`,
      );
      continue;
    }
    lines.push(
      `  - **${npc.display_name}** (id ${npc.id})${formatCompanion(companionIds, npc.id)}${formatStatuses(statuses)}${formatHp(hp)}${formatCombat(combat)}${formatConditions(conditions)}${formatStrings(strings)}${formatHeldItems(heldItems)}${npc.summary ? ` - ${npc.summary}` : ''}${formatStatsBlock(stats)}${renderSocialDcs(npc.profile)}` +
        (typeof brief === 'string' ? `\n      brief: ${brief}` : '') +
        (typeof speech === 'string' ? `\n      speech: ${speech}` : '') +
        renderNpcFrame(npc.profile),
    );
  }
  return lines.join('\n');
}

function renderNpcFrame(profile: Record<string, unknown> | null): string {
  if (!profile) return '';
  const entries: Array<[string, unknown]> = [
    ['role', profile['role']],
    ['want', profile['want']],
    ['fear', profile['fear']],
    ['pressure', profile['secret_pressure']],
    ['routine', profile['routine']],
    ['relationship_triggers', profile['relationship_triggers']],
    ['memory_hooks', profile['memory_hooks']],
    ['companion_rules', profile['companion_rules']],
    ['skills', profile['skills']],
    ['behavior', profile['behavior']],
  ];
  const lines = entries.flatMap(([label, value]) => {
    if (typeof value !== 'string' || value.trim().length === 0) return [];
    return [`      ${label}: ${clipNpcFrameText(value)}`];
  });
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

function clipNpcFrameText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= 520) return compact;
  return `${compact.slice(0, 519).trimEnd()}...`;
}

export function renderItemsHere(
  items: Array<EntityRow & {count?: number}>,
): string {
  const lines: string[] = ['## ITEMS HERE'];
  if (items.length === 0) {
    lines.push('  (nothing notable)');
    return lines.join('\n');
  }
  for (const item of items) {
    const checkStr = renderCheck(item.profile);
    const itemFrame = renderItemFrame(item.profile);
    lines.push(
      `  - **${item.display_name}** (id ${item.id})${item.summary ? ` - ${item.summary}` : ''}${
        item.count && item.count > 1 ? ` x${item.count}` : ''
      }${checkStr}${itemFrame}`,
    );
  }
  return lines.join('\n');
}

function renderItemFrame(profile: Record<string, unknown> | null): string {
  if (!profile) return '';
  const entries: Array<[string, unknown]> = [
    ['canon', profile['item_canon']],
    ['usage', profile['item_usage'] ?? profile['use_contract']],
    ['threat', profile['threat_profile']],
    ['cross_hub', profile['cross_hub_reach']],
    ['do_not', profile['do_not_do_here']],
  ];
  const lines = entries.flatMap(([label, value]) => {
    if (typeof value !== 'string' || value.trim().length === 0) return [];
    return [`      ${label}: ${clipItemFrameText(value)}`];
  });
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

function clipItemFrameText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= 600) return compact;
  return `${compact.slice(0, 599).trimEnd()}...`;
}

function renderExits(exits: EntityRow[]): string {
  const lines: string[] = ['## EXITS'];
  if (exits.length === 0) {
    lines.push('  (no labelled exits - the player can still narratively leave)');
    return lines.join('\n');
  }
  for (const exit of exits) {
    lines.push(
      `  - **${exit.display_name}** (id ${exit.id})${exit.summary ? ` - ${exit.summary}` : ''}`,
    );
  }
  return lines.join('\n');
}

export function renderLocalHooks(hooks: EntityRow[]): string | null {
  if (hooks.length === 0) return null;
  const lines: string[] = [
    '## LOCAL HOOKS',
    '  Use these as nearby playable material; surface one or two when the player explores or looks ready for trouble.',
  ];
  const labels: Record<string, string> = {
    quest: 'quest',
    event: 'event',
    scene: 'scene',
    activity: 'routine',
  };
  for (const hook of hooks) {
    const label = labels[hook.kind] ?? hook.kind;
    lines.push(
      `  - ${label}: **${hook.display_name}** (id ${hook.id})${hook.summary ? ` - ${hook.summary}` : ''}${renderHookFrame(hook)}`,
    );
  }
  return lines.join('\n');
}

function renderHookFrame(hook: EntityRow): string {
  if (hook.kind === 'scene') return renderSceneHookFrame(hook.profile);
  if (hook.kind === 'quest') return renderQuestHookFrame(hook.profile);
  return '';
}

function renderSceneHookFrame(profile: Record<string, unknown> | null): string {
  if (!profile) return '';
  const entries: Array<[string, unknown]> = [
    ['trigger', profile['scene_trigger'] ?? profile['trigger']],
    ['hook', profile['hook']],
    ['beats', profile['beat_by_beat']],
    ['choices', profile['player_choices']],
    ['state', profile['scene_state']],
    ['memory_strings', profile['memory_and_string_changes']],
    ['success', profile['success_result']],
    ['failure', profile['failure_result']],
    ['do_not', profile['scene_do_not']],
  ];
  return renderIndentedFrame(entries);
}

function renderQuestHookFrame(profile: Record<string, unknown> | null): string {
  if (!profile) return '';
  const entries: Array<[string, unknown]> = [
    ['objective', profile['objective'] ?? profile['quest_objective']],
    ['hook', profile['hook']],
    ['success', profile['success_result']],
    ['failure', profile['failure_result']],
    ['reward', profile['reward_and_consequence'] ?? profile['rewards']],
    ['do_not', profile['do_not_do_here'] ?? profile['quest_failure']],
  ];
  const frame = renderIndentedFrame(entries);
  const stages = Array.isArray(profile['stages'])
    ? (profile['stages'] as Array<Record<string, unknown>>)
    : [];
  if (stages.length === 0) return frame;
  const stageSummary = stages
    .slice(0, 5)
    .map(stage => {
      const id = typeof stage['id'] === 'string' ? stage['id'] : '?';
      const title = typeof stage['title'] === 'string'
        ? stage['title']
        : typeof stage['goal'] === 'string'
          ? stage['goal']
          : '';
      const next = stage['next_stage'];
      const nextLabel = typeof next === 'string'
        ? ` -> ${next}`
        : next && typeof next === 'object'
          ? ' -> choice'
          : '';
      return `${id}: ${clipHookFrameText(title)}${nextLabel}`;
    })
    .join('; ');
  return `${frame}\n      stages: ${stageSummary}`;
}

function renderIndentedFrame(entries: Array<[string, unknown]>): string {
  const lines = entries.flatMap(([label, value]) => {
    if (typeof value !== 'string' || value.trim().length === 0) return [];
    return [`      ${label}: ${clipHookFrameText(value)}`];
  });
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

function clipHookFrameText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= 360) return compact;
  return `${compact.slice(0, 359).trimEnd()}...`;
}

export function renderMaterializerHooks(
  entries: MaterializerEntry[],
): string | null {
  if (entries.length === 0) return null;
  const lines = [
    '## MATERIALIZER HOOKS',
    '  These are authored world-change rules available near the player. If the player satisfies the trigger, call apply_materializer_bridge with the exact materializer_id; do not invent the effect in prose.',
  ];
  for (const entry of entries) {
    lines.push(
      `  - id=${entry.materializerId} trigger_source=${entry.triggerSource} trigger=${clipMaterializerText(entry.triggerCondition || 'manual check')} source=${entry.sourceMention} target=${entry.entity} type=${entry.type} scope=${entry.scope || 'local'} effect=${clipMaterializerText(entry.effect || 'apply authored world change')}`,
    );
  }
  return lines.join('\n');
}

function clipMaterializerText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= 220) return compact;
  return `${compact.slice(0, 219).trimEnd()}...`;
}

function formatHp(hp?: {current: number; max: number}): string {
  return hp && hp.max > 0 ? `  - hp ${hp.current}/${hp.max}` : '';
}

function formatCombat(combat?: {ac?: number; prof?: number}): string {
  if (!combat) return '';
  return `${combat.ac != null ? `  - AC ${combat.ac}` : ''}${
    combat.prof != null ? `  - prof +${combat.prof}` : ''
  }`;
}

function formatConditions(
  conditions: Array<{tag: string; severity: number}>,
): string {
  return conditions.length > 0
    ? `  - conditions: ${conditions.map(c => `${c.tag}(${c.severity})`).join(', ')}`
    : '';
}

function formatHeldItems(
  items: Array<{name: string; id: number; count: number}>,
): string {
  if (items.length === 0) return '';
  const list = items
    .map(item => `@${item.name} (${item.id})${item.count > 1 ? ` x${item.count}` : ''}`)
    .join(', ');
  return `  - holds: ${list}`;
}

function formatCompanion(companionIds: Set<number>, npcId: number): string {
  return companionIds.has(npcId) ? '  - companion: following' : '';
}

function formatStatuses(
  statuses: Array<{kind: string; value: string; intensity: number}>,
): string {
  const list = statuses
    .filter(status => status.kind !== 'companion')
    .map(status => `${status.kind}=${status.value}(${status.intensity.toFixed(2)})`);
  return list.length > 0 ? `  - status: ${list.join(', ')}` : '';
}

function unavailableStatus(
  statuses: Array<{kind: string; value: string; intensity: number}>,
): {kind: string; value: string; intensity: number} | null {
  return (
    statuses.find(
      status =>
        status.intensity > 0 &&
        (status.kind === 'dead' || status.kind === 'missing'),
    ) ?? null
  );
}

function formatStrings(strings?: {count: number; band: string}): string {
  return strings ? `  - strings: ${strings.count} (band: ${strings.band})` : '';
}

function formatStatsBlock(
  stats: Array<{stat: string; cur: number; mod: number}>,
): string {
  return stats.length > 0 ? `\n      stats: ${formatStats(stats)}` : '';
}

function formatStats(
  stats: Array<{stat: string; cur: number; mod: number}>,
): string {
  return stats
    .map(stat => `${stat.stat} ${stat.cur} (${stat.mod >= 0 ? '+' : ''}${stat.mod})`)
    .join(', ');
}
