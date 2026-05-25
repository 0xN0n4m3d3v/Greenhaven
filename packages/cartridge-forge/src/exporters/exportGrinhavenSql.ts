import path from 'node:path';
import {mkdir, readdir, writeFile} from 'node:fs/promises';
import type {
  CurrencyBridgeArtifact,
  CurrencyBridgeCoin,
  EntityKind,
  IngestRecord,
  LoadedProject,
} from '../core/types.js';
import {repoRoot} from '../core/paths.js';

export interface GrinhavenSqlExportReport {
  ok: true;
  path: string;
  records: number;
  runtimeFields: number;
  counts: Record<string, number>;
  /** OWV-17: number of currency items the export upserted into the
   *  runtime `items` catalog. 0 when the project carries no
   *  `audit/currency-rates.json` bridge artifact.
   */
  currencyItems: number;
  /** OWV-17: number of merchant offers committed into the
   *  `forge_merchant_contracts` cartridge_meta document. 0 when the
   *  project carries no `audit/merchant-contracts.jsonl` artifact.
   */
  merchantOffers: number;
  /** OWV-17: number of authored materializer rows committed into
   *  the `forge_materializer_bridge` cartridge_meta document. 0
   *  when the project carries no `audit/materializes.jsonl`
   *  artifact.
   */
  materializerEntries: number;
  /** OWV-17: number of authored scene-instruction rows committed
   *  into the `forge_scene_instructions` cartridge_meta document.
   *  0 when the project carries no `audit/scene-instructions.jsonl`
   *  artifact.
   */
  sceneInstructions: number;
  /** OWV-17: number of authored visual-asset rows committed into
   *  the `forge_visual_assets` cartridge_meta document. 0 when the
   *  project carries no `audit/visual-assets.jsonl` artifact.
   */
  visualAssets: number;
}

interface DbRecord {
  id: number;
  kind: string;
  displayName: string;
  summary: string | null;
  profile: Record<string, unknown>;
  tags: string[];
  record: IngestRecord;
  // ARCH-19 Phase 4 prereq: normalized columns travel on the row,
  // NOT through the emitted JSONB profile. `cartridgeId` /
  // `dynamicOrigin` ride the entity INSERT directly; `topologyParentId`
  // is plumbed into a generated child→parent id map that the
  // post-INSERT UPDATE consumes instead of `profile->>'topology_parent_id'`.
  cartridgeId: string | null;
  dynamicOrigin: boolean;
  topologyParentId: number | null;
}

interface DbRuntimeField {
  ownerId: number;
  key: string;
  type: string;
  defaultValue: unknown;
  allowedValues: unknown;
  scope: string;
  description: string | null;
}

interface SlugIndex {
  any: Map<string, number | null>;
  byKind: Map<string, number>;
}

const NEW_ID_BASE: Record<EntityKind, number> = {
  location: 901000,
  item: 911000,
  faction: 921000,
  person: 931000,
  quest: 941000,
  scene: 951000,
  activity: 961000,
  dialogue: 971000,
  event: 981000,
  relationship: 991000,
  world_fact: 995000,
};

export async function exportGrinhavenSql(
  loaded: LoadedProject,
  outFile?: string,
): Promise<GrinhavenSqlExportReport> {
  const destination = path.resolve(outFile ?? (await defaultSqlPath(loaded.project.project_slug)));
  const records = buildDbRecords(loaded);
  finalizeLocationDensity(records);
  const runtimeFields = uniqueRuntimeFields(records.flatMap(row => buildRuntimeFields(row)));
  const currencyItems = buildCurrencyItemRows(loaded, records);
  const sql = renderSql(loaded, records, runtimeFields, currencyItems);
  await mkdir(path.dirname(destination), {recursive: true});
  await writeFile(destination, sql, 'utf8');
  return {
    ok: true,
    path: destination,
    records: records.length,
    runtimeFields: runtimeFields.length,
    counts: countBy(records, row => row.kind),
    currencyItems: currencyItems.length,
    merchantOffers: loaded.bridge?.merchants?.offers.length ?? 0,
    materializerEntries: loaded.bridge?.materializers?.rows.length ?? 0,
    sceneInstructions: loaded.bridge?.sceneInstructions?.rows.length ?? 0,
    visualAssets: loaded.bridge?.visualAssets?.rows.length ?? 0,
  };
}

function buildDbRecords(loaded: LoadedProject): DbRecord[] {
  const used = new Set<number>();
  const recordToId = new Map<IngestRecord, number>();
  const sorted = [...loaded.records].sort((a, b) => a.kind.localeCompare(b.kind) || a.slug.localeCompare(b.slug));

  for (const record of sorted) {
    const existing = numericPayload(record, 'db_entity_id');
    const id = existing && !used.has(existing) ? existing : allocateId(record, used);
    used.add(id);
    recordToId.set(record, id);
  }

  const slugIndex = buildSlugIndex(sorted, recordToId);
  return sorted.map(record => {
    const id = recordToId.get(record)!;
    const rawProfile = profileFor(record);
    const kind = dbKind(record);
    // ARCH-19 Phase 4 prereq: derive the normalized column values
    // BEFORE we strip the legacy JSONB keys from the emitted profile.
    // `cartridge_id`, `topology_parent_id`, and `origin` are retired
    // from the profile shape; their values live on the `DbRecord` row
    // and ride the SQL INSERT / post-INSERT UPDATE through dedicated
    // columns.
    const rawCartridgeId = rawProfile.cartridge_id;
    const cartridgeId =
      typeof rawCartridgeId === 'string' && rawCartridgeId.trim().length > 0
        ? rawCartridgeId
        : loaded.project.target_cartridge_id || null;
    const rawTopologyParent = rawProfile.topology_parent_id;
    const inheritedTopologyParentId =
      typeof rawTopologyParent === 'number' && Number.isInteger(rawTopologyParent)
        ? rawTopologyParent
        : null;
    const tags = uniqueStrings([kind, loaded.project.target_cartridge_id, ...record.tags]);
    const dynamicOrigin =
      rawProfile.origin === 'dynamic' || tags.includes('dynamic');
    const profile = {...rawProfile};
    delete profile.cartridge_id;
    delete profile.topology_parent_id;
    delete profile.origin;
    profile.source_slug = stringPayload(record, 'source_slug') ?? record.slug;
    profile.source_category = String(profile.source_category ?? 'forge-roundtrip');
    copyIfPresent(profile, record.payload, 'source_path');
    copyIfPresent(profile, record.payload, 'source_markdown');
    copyIfPresent(profile, record.payload, 'canonical_mention');
    const editable = mergeEditableFields(profile, record, slugIndex);
    return {
      id,
      kind,
      displayName: record.canonical_name,
      summary: record.summary || null,
      profile,
      tags,
      record,
      cartridgeId,
      dynamicOrigin,
      // Prefer a freshly-resolved parent_slug (location records only)
      // over any legacy donor-stored numeric pointer; both produce a
      // valid `entities.topology_parent_id` for the post-INSERT UPDATE.
      topologyParentId: editable.topologyParentId ?? inheritedTopologyParentId,
    };
  });
}

interface EditableResult {
  topologyParentId: number | null;
}

function mergeEditableFields(
  profile: Record<string, unknown>,
  record: IngestRecord,
  slugIndex: SlugIndex,
): EditableResult {
  const payload = record.payload;
  let topologyParentId: number | null = null;

  if (record.kind === 'location') {
    topologyParentId = idFor(payload.parent_slug, slugIndex, 'location') ?? null;
    setIdArray(profile, 'exits', payload.exits, slugIndex, 'location');
    const density = isRecord(profile.local_density) ? {...profile.local_density} : {};
    setDensityIds(density, 'scene_ids', payload.scene_slugs, slugIndex, 'scene');
    setDensityIds(density, 'npc_ids', payload.resident_npc_slugs, slugIndex, 'person');
    setDensityIds(density, 'event_ids', payload.event_slugs, slugIndex, 'event');
    setDensityIds(density, 'activity_ids', payload.activity_slugs, slugIndex, 'activity');
    setDensityIds(density, 'quest_ids', payload.quest_slugs, slugIndex, 'quest');
    setDensityIds(density, 'child_location_ids', payload.child_location_slugs, slugIndex, 'location');
    profile.local_density = density;
    copyIfPresent(profile, payload, 'location_kind');
    copyIfPresent(profile, payload, 'location_brief');
    copyIfPresent(profile, payload, 'location_canon');
    copyIfPresent(profile, payload, 'narrator_brief');
    copyIfPresent(profile, payload, 'mood_axes');
    copyIfPresent(profile, payload, 'default_hooks');
    // OWV-7: `location/hidden-exit` materializers mark their
    // target location as initially hidden in
    // `compile_vault_to_forge.py`. Carry the gate string through
    // so `move_player.validateMovementReachability` rejects pre-
    // action travel until `apply_materializer_bridge` clears it.
    copyIfPresent(profile, payload, 'hidden_until_stage');
  }

  if (record.kind === 'person') {
    setId(profile, 'home_id', payload.home_slug, slugIndex, 'location');
    copyIfPresent(profile, payload, 'identity');
    copyIfPresent(profile, payload, 'appearance');
    copyIfPresent(profile, payload, 'sexual_appearance');
    copyIfPresent(profile, payload, 'voice');
    copyIfPresent(profile, payload, 'relationship');
    copyIfPresent(profile, payload, 'romance');
    copyIfPresent(profile, payload, 'skills');
    copyIfPresent(profile, payload, 'behavior');
    copyIfPresent(profile, payload, 'inventory');
    copyIfPresent(profile, payload, 'merchant_offers');
    copyIfPresent(profile, payload, 'materializes');
    copyIfPresent(profile, payload, 'npc_scene_slugs');
    copyIfPresent(profile, payload, 'quest_slugs');
    copyIfPresent(profile, payload, 'registers');
    copyIfPresent(profile, payload, 'visual_assets');
    const source = isRecord(profile.source) ? {...profile.source} : {};
    copyIfPresent(source, payload, 'species');
    copyIfPresent(source, payload, 'pronouns');
    copyIfPresent(source, payload, 'occupation');
    copyIfPresent(source, payload, 'archetype');
    copyIfPresent(source, payload, 'speech_style');
    copyIfPresent(source, payload, 'registers');
    if (typeof payload.faction_slug === 'string') source.faction = payload.faction_slug;
    profile.source = source;
  }

  if (record.kind === 'quest') {
    setId(profile, 'giver_entity_id', payload.giver_slug, slugIndex, 'person');
    setId(profile, 'location_id', payload.start_location_slug, slugIndex, 'location');
    copyIfPresent(profile, payload, 'quest_type');
    copyIfPresent(profile, payload, 'quest_source_slug');
    copyIfPresent(profile, payload, 'hook');
    copyIfPresent(profile, payload, 'quest_objective');
    copyIfPresent(profile, payload, 'quest_stages');
    copyIfPresent(profile, payload, 'quest_rewards');
    copyIfPresent(profile, payload, 'objective');
    copyIfPresent(profile, payload, 'rewards');
    copyIfPresent(profile, payload, 'prepared_entity_slugs');
    copyIfPresent(profile, payload, 'materializes');
    if (Array.isArray(payload.stages)) {
      const originalStages = Array.isArray(profile.stages)
        ? profile.stages.filter(isRecord)
        : [];
      profile.stages = payload.stages.map((stage, index) => {
        if (!isRecord(stage)) return stage;
        const original = originalStages[index] ?? {};
        const out = {...original, ...stage};
        const stageId = String(out.id ?? stage.stage_slug ?? `stage_${index + 1}`);
        out.id = stageId;
        if (typeof out.name !== 'string' || !out.name.trim()) out.name = stageTitle(stageId);
        if (typeof out.description !== 'string' || !out.description.trim()) {
          out.description = String(stage.goal ?? `Complete quest stage ${index + 1}.`);
        }
        const locationId = idFor(stage.location_slug, slugIndex, 'location');
        if (locationId) out.location_id = locationId;
        return out;
      });
    }
  }

  if (record.kind === 'scene') {
    setId(profile, 'location_id', payload.location_slug, slugIndex, 'location');
    setIdArray(profile, 'participant_entity_ids', payload.participant_slugs, slugIndex, 'person');
    copyIfPresent(profile, payload, 'owner_npc_slug');
    copyIfPresent(profile, payload, 'participant_slugs');
    copyIfPresent(profile, payload, 'scene_trigger');
    copyIfPresent(profile, payload, 'scene_behavior');
    copyIfPresent(profile, payload, 'scene_state');
    copyIfPresent(profile, payload, 'scene_do_not');
    copyIfPresent(profile, payload, 'voice');
    copyIfPresent(profile, payload, 'trigger');
    copyIfPresent(profile, payload, 'priority');
    copyIfPresent(profile, payload, 'behavior');
    copyIfPresent(profile, payload, 'model_instructions');
    copyIfPresent(profile, payload, 'visual_assets');
  }

  if (record.kind === 'item') {
    setId(profile, 'holder_id', payload.holder_slug, slugIndex);
    setId(profile, 'location_id', payload.location_slug, slugIndex, 'location');
    copyIfPresent(profile, payload, 'item_kind');
    copyIfPresent(profile, payload, 'use_contract');
    copyIfPresent(profile, payload, 'item_description');
    copyIfPresent(profile, payload, 'item_usage');
    copyIfPresent(profile, payload, 'item_canon');
    copyIfPresent(profile, payload, 'description');
    copyIfPresent(profile, payload, 'currency_value');
    copyIfPresent(profile, payload, 'stackable');
    copyIfPresent(profile, payload, 'merchant_offers');
    copyIfPresent(profile, payload, 'materializes');
    copyIfPresent(profile, payload, 'visual_assets');
  }

  setId(profile, 'location_id', payload.location_slug, slugIndex, 'location');
  setIdArray(profile, 'participant_entity_ids', payload.participant_slugs, slugIndex, 'person');
  return {topologyParentId};
}

function buildRuntimeFields(row: DbRecord): DbRuntimeField[] {
  const fields = row.record.payload.state_fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter(isRecord).map(field => ({
    ownerId: row.id,
    key: String(field.key ?? '').trim(),
    type: normalizeRuntimeValueType(field.type),
    defaultValue: field.default ?? null,
    allowedValues: field.allowed ?? null,
    scope: String(field.scope ?? 'session').trim(),
    description: typeof field.description === 'string' ? field.description : null,
  })).filter(field => field.key.length > 0);
}

function normalizeRuntimeValueType(value: unknown): string {
  const raw = String(value ?? 'json').trim().toLowerCase();
  const aliases: Record<string, string> = {
    boolean: 'bool',
    integer: 'int',
    number: 'float',
    text: 'string',
    str: 'string',
    object: 'json',
    array: 'json',
    entity: 'entity_ref',
    entityref: 'entity_ref',
    entity_reference: 'entity_ref',
  };
  const normalized = aliases[raw] ?? raw;
  return [
    'int',
    'float',
    'bool',
    'string',
    'enum',
    'entity_ref',
    'json',
    'dice',
  ].includes(normalized)
    ? normalized
    : 'json';
}

function uniqueRuntimeFields(fields: DbRuntimeField[]): DbRuntimeField[] {
  const byKey = new Map<string, DbRuntimeField>();
  for (const field of fields) {
    byKey.set(`${field.ownerId}\0${field.key}`, field);
  }
  return [...byKey.values()].sort((a, b) => a.ownerId - b.ownerId || a.key.localeCompare(b.key));
}

interface CurrencyItemRow {
  slug: string;
  category: 'currency';
  weightKg: number;
  stackable: true;
  maxStack: number;
  behaviour: Record<string, unknown>;
  legacyEntityId: number | null;
}

function buildCurrencyItemRows(
  loaded: LoadedProject,
  records: DbRecord[],
): CurrencyItemRow[] {
  const bridge = loaded.bridge?.currency;
  if (!bridge || !Array.isArray(bridge.coins) || bridge.coins.length === 0) {
    return [];
  }
  const byItemSlug = new Map<string, DbRecord>();
  for (const row of records) {
    if (row.record.kind === 'item') byItemSlug.set(row.record.slug, row);
  }
  const rows: CurrencyItemRow[] = bridge.coins.map(coin =>
    buildCurrencyItemRow(coin, byItemSlug.get(coin.slug) ?? null),
  );
  rows.sort(
    (a, b) =>
      a.behaviour.copper_value === b.behaviour.copper_value
        ? a.slug.localeCompare(b.slug)
        : Number(a.behaviour.copper_value) - Number(b.behaviour.copper_value),
  );
  return rows;
}

function buildCurrencyItemRow(
  coin: CurrencyBridgeCoin,
  match: DbRecord | null,
): CurrencyItemRow {
  return {
    slug: coin.slug,
    category: 'currency',
    weightKg: 0,
    stackable: true,
    maxStack: 9999,
    behaviour: {
      canonical_mention: coin.mention,
      source_slug: coin.slug,
      source_path: coin.source_path,
      copper_value: coin.copper_value,
      bridge: 'greenhaven.currency_rates.v1',
    },
    legacyEntityId: match ? match.id : null,
  };
}

function renderCurrencyItemValues(row: CurrencyItemRow): string {
  return `(${[
    sqlString(row.slug),
    sqlString(row.category),
    row.weightKg.toFixed(2),
    row.stackable ? 'TRUE' : 'FALSE',
    String(row.maxStack),
    `${sqlString(JSON.stringify(row.behaviour))}::jsonb`,
    row.legacyEntityId === null ? 'NULL' : String(row.legacyEntityId),
  ].join(', ')})`;
}

function renderSql(
  loaded: LoadedProject,
  records: DbRecord[],
  runtimeFields: DbRuntimeField[],
  currencyItems: CurrencyItemRow[],
): string {
  // ARCH-19 Phase 2A — derive normalized columns inline per row. The
  // forge cannot include topology_parent_id directly in the INSERT
  // because the parent row may live later in the same VALUES list
  // (the FK fires per row); we emit a post-INSERT UPDATE that joins
  // a generated child→parent id map once every row exists.
  // `cartridge_id` and `dynamic_origin` have no FK so they ride the
  // INSERT directly.
  //
  // ARCH-19 Phase 4 prereq: the post-INSERT UPDATE no longer reads
  // `child.profile->>'topology_parent_id'`. The forge already knows
  // every child→parent edge at compile time, so we emit a `VALUES
  // (child_id, parent_id)` map joined to `entities parent`. The
  // emitted profile JSONB no longer carries the retired
  // `cartridge_id`, `topology_parent_id`, or `origin` keys.
  const entityRows = records.map(
    row => `(${[
      row.id,
      sqlString(row.kind),
      sqlString(row.displayName),
      row.summary === null ? 'NULL' : sqlString(row.summary),
      `${sqlString(JSON.stringify(row.profile))}::jsonb`,
      sqlArray(row.tags),
      row.cartridgeId === null ? 'NULL' : sqlString(row.cartridgeId),
      row.dynamicOrigin ? 'TRUE' : 'FALSE',
    ].join(', ')})`,
  );
  const topologyEdges = records
    .filter(row => row.topologyParentId !== null)
    .map(row => `(${row.id}, ${row.topologyParentId})`);

  const fieldRows = runtimeFields.map(field => `(${[
    field.ownerId,
    sqlString(field.key),
    sqlString(field.type),
    `${sqlString(JSON.stringify(field.defaultValue))}::jsonb`,
    `${sqlString(JSON.stringify(field.allowedValues))}::jsonb`,
    sqlString(field.scope),
    field.description === null ? 'NULL' : sqlString(field.description),
  ].join(', ')})`);

  const meta = {
    project_slug: loaded.project.project_slug,
    pack_slug: loaded.project.pack_slug,
    target_cartridge_id: loaded.project.target_cartridge_id,
    starting_location_slug: loaded.project.starting_location_slug ?? null,
    exported_at: new Date().toISOString(),
    records: records.length,
    runtime_fields: runtimeFields.length,
  };
  const startLocation = startingLocationRecord(loaded, records);
  const metaRows = [
    `  ('forge_last_sql_export', ${sqlString(JSON.stringify(meta))}::jsonb, 'Last Cartridge Forge SQL export')`,
  ];
  if (startLocation) {
    metaRows.push(
      `  ('starting_location_id', '${startLocation.id}'::jsonb, 'Start location exported by Cartridge Forge.')`,
    );
    if (loaded.project.target_cartridge_id === 'grinhaven-full') {
      metaRows.push(
        `  ('grinhaven_full_starting_location_id', '${startLocation.id}'::jsonb, 'Grinhaven full start location exported by Cartridge Forge.')`,
      );
    }
  }
  // OWV-17: merchant runtime-bridge meta. Same shape contract as the
  // currency bridge — namespaced cartridge_meta key, sorted offer
  // list, no production keys touched. The runtime
  // `MerchantContractService` reads this row through `getMeta` and
  // joins coin mentions to the currency catalog at query time.
  const merchantBridge = loaded.bridge?.merchants;
  if (merchantBridge && merchantBridge.offers.length > 0) {
    const offers = [...merchantBridge.offers]
      .map(offer => ({
        offer_id: offer.offer_id,
        source_slug: offer.source_slug,
        source_mention: offer.source_mention,
        source_kind: offer.source_kind,
        source_path: offer.source_path,
        line: offer.line,
        coins: offer.coins.map(c => ({coin: c.coin, amount: c.amount})),
        copper_value: offer.copper_value,
      }))
      .sort((a, b) => {
        if (a.source_slug !== b.source_slug) {
          return a.source_slug.localeCompare(b.source_slug);
        }
        if (a.copper_value !== b.copper_value) return a.copper_value - b.copper_value;
        if (a.line !== b.line) return a.line.localeCompare(b.line);
        return a.offer_id.localeCompare(b.offer_id);
      });
    const merchantMeta = {
      schema_version: merchantBridge.schema_version,
      source_project: loaded.project.project_slug,
      exported_at: meta.exported_at,
      offers,
    };
    metaRows.push(
      `  ('forge_merchant_contracts', ${sqlString(JSON.stringify(merchantMeta))}::jsonb, 'OWV-17 merchant offer contracts exported by Cartridge Forge.')`,
    );
  }
  // OWV-17: materializer runtime-bridge meta. Same shape contract as
  // the currency / merchant bridges — namespaced cartridge_meta key,
  // sorted row list, no production keys touched. The runtime
  // `MaterializerBridgeService` reads this row through `getMeta` and
  // resolves source/target/scope mentions to entity ids at query
  // time.
  const materializerBridge = loaded.bridge?.materializers;
  if (materializerBridge && materializerBridge.rows.length > 0) {
    const rows = [...materializerBridge.rows]
      .map(row => ({
        materializer_id: row.materializer_id,
        source_slug: row.source_slug,
        source_mention: row.source_mention,
        source_kind: row.source_kind,
        source_path: row.source_path,
        entity: row.entity,
        entity_slug: row.entity_slug,
        target_status: row.target_status,
        trigger_condition: row.trigger_condition,
        trigger_source: row.trigger_source,
        type: row.type,
        scope: row.scope,
        effect: row.effect,
      }))
      .sort((a, b) => {
        if (a.source_slug !== b.source_slug) {
          return a.source_slug.localeCompare(b.source_slug);
        }
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        if (a.entity_slug !== b.entity_slug) {
          return a.entity_slug.localeCompare(b.entity_slug);
        }
        if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
        return a.materializer_id.localeCompare(b.materializer_id);
      });
    const materializerMeta = {
      schema_version: materializerBridge.schema_version,
      source_project: loaded.project.project_slug,
      exported_at: meta.exported_at,
      rows,
    };
    metaRows.push(
      `  ('forge_materializer_bridge', ${sqlString(JSON.stringify(materializerMeta))}::jsonb, 'OWV-17 materializer bridge exported by Cartridge Forge.')`,
    );
  }
  // OWV-17: visual-assets runtime-bridge meta. Same shape contract
  // as the other bridges. The runtime serves these asset files
  // from a configured vault root via a dedicated read route; we do
  // not embed any binary in the SQL.
  const visualAssetsBridge = loaded.bridge?.visualAssets;
  if (visualAssetsBridge && visualAssetsBridge.rows.length > 0) {
    const rows = [...visualAssetsBridge.rows]
      .map(row => ({
        kind: row.kind,
        slug: row.slug,
        mention: row.mention,
        role: row.role,
        path: row.path,
        source_path: row.source_path,
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
        if (a.slug !== b.slug) return a.slug.localeCompare(b.slug);
        if (a.role !== b.role) return a.role.localeCompare(b.role);
        return a.path.localeCompare(b.path);
      });
    const visualAssetsMeta = {
      schema_version: visualAssetsBridge.schema_version,
      source_project: loaded.project.project_slug,
      exported_at: meta.exported_at,
      rows,
    };
    metaRows.push(
      `  ('forge_visual_assets', ${sqlString(JSON.stringify(visualAssetsMeta))}::jsonb, 'OWV-17 visual-assets bridge exported by Cartridge Forge.')`,
    );
  }
  // OWV-17: scene-instructions runtime-bridge meta. Same shape
  // contract as the other bridges — namespaced cartridge_meta key,
  // sorted row list, no production keys touched. The runtime
  // `SceneInstructionBridgeService` reads this row through
  // `getMeta` and resolves location/owner/participant slugs to
  // entity ids at query time.
  const sceneInstructionsBridge = loaded.bridge?.sceneInstructions;
  if (sceneInstructionsBridge && sceneInstructionsBridge.rows.length > 0) {
    const rows = [...sceneInstructionsBridge.rows]
      .map(row => ({
        scene_slug: row.scene_slug,
        scene_mention: row.scene_mention,
        source_kind: row.source_kind,
        source_path: row.source_path,
        location_slug: row.location_slug,
        owner_npc_slug: row.owner_npc_slug,
        participant_slugs: [...row.participant_slugs],
        trigger: row.trigger,
        priority: row.priority,
        hook: row.hook,
        beat_by_beat: row.beat_by_beat,
        player_choices: row.player_choices,
        memory_and_string_changes: row.memory_and_string_changes,
        success_result: row.success_result,
        failure_result: row.failure_result,
        behavior: row.behavior,
        do_not: row.do_not,
        voice: row.voice,
        model_instructions: [...row.model_instructions],
        state_fields: [...row.state_fields],
        media_script: [...row.media_script],
        visual_asset: row.visual_asset,
      }))
      .sort((a, b) => {
        const aLoc = a.location_slug ?? '';
        const bLoc = b.location_slug ?? '';
        if (aLoc !== bLoc) return aLoc.localeCompare(bLoc);
        const aOwner = a.owner_npc_slug ?? '';
        const bOwner = b.owner_npc_slug ?? '';
        if (aOwner !== bOwner) return aOwner.localeCompare(bOwner);
        if (a.scene_slug !== b.scene_slug) {
          return a.scene_slug.localeCompare(b.scene_slug);
        }
        return a.source_path.localeCompare(b.source_path);
      });
    const sceneInstructionsMeta = {
      schema_version: sceneInstructionsBridge.schema_version,
      source_project: loaded.project.project_slug,
      exported_at: meta.exported_at,
      rows,
    };
    metaRows.push(
      `  ('forge_scene_instructions', ${sqlString(JSON.stringify(sceneInstructionsMeta))}::jsonb, 'OWV-17 scene-instructions bridge exported by Cartridge Forge.')`,
    );
  }
  // OWV-17: currency runtime-bridge meta. Records the bridge document
  // so downstream tooling can see *which* coins the latest SQL export
  // committed without re-reading the audit artifact. Deliberately
  // separate from `currency_item_id` / `starting_currency_count` —
  // those production keys are out of scope for this slice.
  const currencyBridge = loaded.bridge?.currency;
  if (currencyBridge && currencyItems.length > 0) {
    const bridgeMeta = {
      schema_version: currencyBridge.schema_version,
      source_project: currencyBridge.source_project,
      coins: currencyItems.map(row => ({
        slug: row.slug,
        copper_value: Number(row.behaviour.copper_value),
        legacy_entity_id: row.legacyEntityId,
      })),
      world_currency_facts: currencyBridge.world_currency_facts,
      exported_at: meta.exported_at,
    };
    metaRows.push(
      `  ('forge_currency_bridge', ${sqlString(JSON.stringify(bridgeMeta))}::jsonb, 'OWV-17 currency item-catalog bridge exported by Cartridge Forge.')`,
    );
  }

  return [
    `-- Forge SQL export for ${loaded.project.project_slug}`,
    '-- Generated by Cartridge Forge. Safe to re-run.',
    '',
    entityRows.length > 0
      ? [
          'INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id, dynamic_origin) VALUES',
          `${entityRows.join(',\n')}`,
          'ON CONFLICT (id) DO UPDATE SET',
          '  kind = EXCLUDED.kind,',
          '  display_name = EXCLUDED.display_name,',
          '  summary = EXCLUDED.summary,',
          '  profile = gh_forge_merge_entity_profile(entities.profile, EXCLUDED.profile),',
          '  tags = EXCLUDED.tags,',
          '  updated_at = now();',
          '-- ARCH-19 Phase 2A → Phase 4 prereq: project topology_parent_id',
          '-- from a generated child→parent id map. The forge already',
          '-- knows every edge at compile time, so the UPDATE no longer',
          '-- reads `child.profile->>\'topology_parent_id\'` — the retired',
          '-- JSONB key is gone from the emitted profile entirely. We',
          '-- still only set `topology_parent_id` when it IS NULL so an',
          '-- existing pointer is preserved through re-imports.',
          topologyEdges.length > 0
            ? `UPDATE entities child
   SET topology_parent_id = edge.parent_id
  FROM (VALUES ${topologyEdges.join(', ')}) AS edge(child_id, parent_id)
  JOIN entities parent ON parent.id = edge.parent_id
 WHERE child.id = edge.child_id
   AND child.topology_parent_id IS NULL
   AND parent.kind IN ('location', 'district');`
            : '-- No topology edges to project.',
        ].join('\n')
      : '-- No entity rows.',
    '',
    fieldRows.length > 0
      ? [
          'INSERT INTO runtime_fields (owner_entity_id, field_key, value_type, default_value, allowed_values, scope, description) VALUES',
          `${fieldRows.join(',\n')}`,
          'ON CONFLICT (owner_entity_id, field_key) DO UPDATE SET',
          '  value_type = EXCLUDED.value_type,',
          '  default_value = EXCLUDED.default_value,',
          '  allowed_values = EXCLUDED.allowed_values,',
          '  scope = EXCLUDED.scope,',
          '  description = EXCLUDED.description;',
          '',
          'INSERT INTO runtime_values (field_id, value, source)',
          'SELECT id, COALESCE(default_value, \'null\'::jsonb), \'forge_roundtrip\'',
          'FROM runtime_fields',
          `WHERE owner_entity_id IN (${uniqueNumbers(runtimeFields.map(field => field.ownerId)).join(', ')})`,
          'ON CONFLICT (field_id) DO NOTHING;',
        ].join('\n')
      : '-- No runtime fields.',
    '',
    // OWV-17: upsert authored currency coins into the runtime `items`
    // catalog. Idempotent across re-runs (ON CONFLICT on slug). The
    // existing `legacy_entity_id` link is preserved once set so player
    // inventory references survive a re-export.
    currencyItems.length > 0
      ? [
          'INSERT INTO items (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id) VALUES',
          currencyItems.map(renderCurrencyItemValues).join(',\n'),
          'ON CONFLICT (slug) DO UPDATE SET',
          '  category = EXCLUDED.category,',
          '  weight_kg = EXCLUDED.weight_kg,',
          '  stackable = EXCLUDED.stackable,',
          '  max_stack = EXCLUDED.max_stack,',
          '  behaviour = EXCLUDED.behaviour,',
          '  legacy_entity_id = COALESCE(items.legacy_entity_id, EXCLUDED.legacy_entity_id);',
        ].join('\n')
      : '-- No currency bridge items.',
    '',
    'INSERT INTO cartridge_meta (key, value, description) VALUES',
    metaRows.join(',\n'),
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now();',
    '',
    `SELECT setval(pg_get_serial_sequence('entities', 'id'), GREATEST((SELECT MAX(id) FROM entities), ${Math.max(...records.map(row => row.id), 1)}));`,
    '',
  ].join('\n');
}

function finalizeLocationDensity(records: DbRecord[]) {
  const locations = records
    .filter(row => row.kind === 'location' || row.kind === 'district')
    .sort((a, b) => a.id - b.id);
  const byId = new Map(locations.map(row => [row.id, row]));

  for (const location of locations) {
    const density = {
      child_location_ids: cappedIds(
        records,
        row =>
          (row.kind === 'location' || row.kind === 'district') &&
          row.topologyParentId === location.id,
        24,
      ),
      npc_ids: cappedIds(
        records,
        row => row.kind === 'person' && numberProfile(row, 'home_id') === location.id,
        16,
      ),
      scene_ids: cappedIds(
        records,
        row => row.kind === 'scene' && numberProfile(row, 'location_id') === location.id,
        12,
      ),
      event_ids: cappedIds(
        records,
        row => row.kind === 'event' && numberProfile(row, 'location_id') === location.id,
        12,
      ),
      activity_ids: cappedIds(
        records,
        row => row.kind === 'activity' && numberProfile(row, 'location_id') === location.id,
        12,
      ),
      quest_ids: cappedIds(
        records,
        row => row.kind === 'quest' && numberProfile(row, 'location_id') === location.id,
        8,
      ),
    };
    location.profile.local_density = density;
    location.profile.local_density_summary = densitySummary(density);
  }

  for (const location of locations) {
    const descendants = descendantsFor(location, byId);
    const summary = {
      npc_count: 0,
      scene_count: 0,
      event_count: 0,
      activity_count: 0,
      quest_count: 0,
      descendant_location_count: 0,
      max_depth: 0,
    };
    for (const {row, depth} of descendants) {
      const local = isRecord(row.profile.local_density_summary)
        ? row.profile.local_density_summary
        : {};
      summary.npc_count += numberRecordValue(local, 'npc_count');
      summary.scene_count += numberRecordValue(local, 'scene_count');
      summary.event_count += numberRecordValue(local, 'event_count');
      summary.activity_count += numberRecordValue(local, 'activity_count');
      summary.quest_count += numberRecordValue(local, 'quest_count');
      if (depth > 0) summary.descendant_location_count += 1;
      summary.max_depth = Math.max(summary.max_depth, depth);
    }
    location.profile.transitive_density_summary = summary;
  }
}

function cappedIds(
  records: DbRecord[],
  predicate: (row: DbRecord) => boolean,
  cap: number,
): number[] {
  return records
    .filter(predicate)
    .map(row => row.id)
    .sort((a, b) => a - b)
    .slice(0, cap);
}

function densitySummary(density: {
  child_location_ids: number[];
  npc_ids: number[];
  scene_ids: number[];
  event_ids: number[];
  activity_ids: number[];
  quest_ids: number[];
}) {
  return {
    child_location_count: density.child_location_ids.length,
    npc_count: density.npc_ids.length,
    scene_count: density.scene_ids.length,
    event_count: density.event_ids.length,
    activity_count: density.activity_ids.length,
    quest_count: density.quest_ids.length,
  };
}

function descendantsFor(
  root: DbRecord,
  byId: Map<number, DbRecord>,
): Array<{row: DbRecord; depth: number}> {
  const out: Array<{row: DbRecord; depth: number}> = [];
  const queue: Array<{row: DbRecord; depth: number}> = [{row: root, depth: 0}];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.row.id)) continue;
    seen.add(current.row.id);
    out.push(current);
    if (current.depth >= 8) continue;
    const density = isRecord(current.row.profile.local_density)
      ? current.row.profile.local_density
      : {};
    const childIds = Array.isArray(density.child_location_ids)
      ? density.child_location_ids
      : [];
    for (const childId of childIds) {
      if (typeof childId !== 'number') continue;
      const child = byId.get(childId);
      if (child) queue.push({row: child, depth: current.depth + 1});
    }
  }
  return out;
}

function numberProfile(row: DbRecord, key: string): number | null {
  const value = row.profile[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function numberRecordValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function startingLocationRecord(loaded: LoadedProject, records: DbRecord[]): DbRecord | null {
  const slug = loaded.project.starting_location_slug?.trim();
  if (!slug) return null;
  return records.find(row => row.record.kind === 'location' && row.record.slug === slug) ?? null;
}

async function defaultSqlPath(projectSlug: string): Promise<string> {
  const dir = path.join(repoRoot, 'packages', 'web-server', 'migrations');
  const entries = await readdir(dir).catch(() => []);
  const safeSlug = projectSlug.replace(/-/g, '_');
  const existingProjectPatch = entries
    .map(entry => ({entry, match: entry.match(new RegExp(`^(\\d+)_forge_${safeSlug}_patch\\.sql$`))}))
    .filter((row): row is {entry: string; match: RegExpMatchArray} => Boolean(row.match))
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))[0];
  if (existingProjectPatch) return path.join(dir, existingProjectPatch.entry);

  const max = Math.max(
    0,
    ...entries
      .map(entry => Number(entry.match(/^(\d+)_/)?.[1] ?? 0))
      .filter(Number.isFinite),
  );
  const prefix = String(max + 1).padStart(4, '0');
  return path.join(dir, `${prefix}_forge_${safeSlug}_patch.sql`);
}

function profileFor(record: IngestRecord): Record<string, unknown> {
  const raw = record.payload.db_profile_json;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) return {...parsed};
    } catch {
      // fall through to a new profile
    }
  }
  return {};
}

function dbKind(record: IngestRecord): string {
  return typeof record.payload.db_kind === 'string' && record.payload.db_kind.trim()
    ? record.payload.db_kind
    : record.kind;
}

function allocateId(record: IngestRecord, used: Set<number>): number {
  const base = NEW_ID_BASE[record.kind];
  let candidate = base + (hash(record.slug) % 9000);
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

function numericPayload(record: IngestRecord, key: string): number | null {
  const value = record.payload[key];
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

function stringPayload(record: IngestRecord, key: string): string | null {
  const value = record.payload[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function buildSlugIndex(records: IngestRecord[], recordToId: Map<IngestRecord, number>): SlugIndex {
  const any = new Map<string, number | null>();
  const byKind = new Map<string, number>();
  for (const record of records) {
    const id = recordToId.get(record);
    if (!id) continue;
    byKind.set(kindSlugKey(record.kind, record.slug), id);
    if (!any.has(record.slug)) any.set(record.slug, id);
    else any.set(record.slug, null);
  }
  return {any, byKind};
}

function setId(
  profile: Record<string, unknown>,
  key: string,
  value: unknown,
  slugIndex: SlugIndex,
  expectedKind?: EntityKind,
) {
  const id = idFor(value, slugIndex, expectedKind);
  if (id) profile[key] = id;
}

function setIdArray(
  profile: Record<string, unknown>,
  key: string,
  value: unknown,
  slugIndex: SlugIndex,
  expectedKind?: EntityKind,
) {
  const ids = idsFor(value, slugIndex, expectedKind);
  if (ids.length > 0) profile[key] = ids;
}

function setDensityIds(
  density: Record<string, unknown>,
  key: string,
  value: unknown,
  slugIndex: SlugIndex,
  expectedKind: EntityKind,
) {
  const ids = idsFor(value, slugIndex, expectedKind);
  if (ids.length > 0) density[key] = ids;
}

function idFor(value: unknown, slugIndex: SlugIndex, expectedKind?: EntityKind): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (expectedKind) {
    const typed = slugIndex.byKind.get(kindSlugKey(expectedKind, value));
    if (typed) return typed;
  }
  const any = slugIndex.any.get(value);
  return typeof any === 'number' ? any : null;
}

function idsFor(value: unknown, slugIndex: SlugIndex, expectedKind?: EntityKind): number[] {
  if (!Array.isArray(value)) return [];
  return uniqueNumbers(
    value.map(item => idFor(item, slugIndex, expectedKind)).filter((item): item is number => item !== null),
  );
}

function kindSlugKey(kind: EntityKind, slug: string): string {
  return `${kind}\0${slug}`;
}

function copyIfPresent(target: Record<string, unknown>, source: Record<string, unknown>, key: string) {
  if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
}

function stageTitle(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Stage';
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlArray(values: string[]): string {
  return `ARRAY[${values.map(sqlString).join(', ')}]`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function countBy<T>(items: T[], fn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[fn(item)] = (out[fn(item)] ?? 0) + 1;
  return out;
}

function hash(value: string): number {
  let out = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    out ^= value.charCodeAt(i);
    out = Math.imul(out, 16777619);
  }
  return out >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
