import path from 'node:path';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import type {
  CurrencyBridgeArtifact,
  CurrencyBridgeCoin,
  CurrencyBridgeWorldFact,
  ForgeProject,
  IngestRecord,
  LoadedProject,
  MaterializerBridgeArtifact,
  MaterializerBridgeRow,
  MerchantBridgeCoinRequirement,
  MerchantBridgeOffer,
  MerchantContractsBridgeArtifact,
  RuntimeBridge,
  SceneInstructionMediaCommand,
  SceneInstructionRow,
  SceneInstructionStateField,
  SceneInstructionVisualAsset,
  SceneInstructionsBridgeArtifact,
  SourceRecord,
  VisualAssetRow,
  VisualAssetsBridgeArtifact,
} from './types.js';
import {createHash} from 'node:crypto';
import {projectRoot, projectsRoot} from './paths.js';
import {readJsonl, writeJsonl} from './jsonl.js';
import {draftRecord} from './defaults.js';
import {recordFileName} from './recordFiles.js';

export async function initProject(slug: string): Promise<ForgeProject> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('project slug must be kebab-case');
  }
  const root = projectRoot(slug);
  await mkdir(path.join(root, 'records'), {recursive: true});
  await mkdir(path.join(root, 'audit'), {recursive: true});
  await mkdir(path.join(root, 'export'), {recursive: true});
  const project: ForgeProject = {
    schema_version: 'greenhaven.cartridge_forge_project.v1',
    project_slug: slug,
    pack_slug: slug,
    target_cartridge_id: 'grinhaven-full',
    mode: 'append_patch',
    source_language: 'en',
    created_at: new Date().toISOString(),
    density_goal: {
      power_centers: ['tavern', 'guild', 'authority'],
      minimum_hooks_per_location: 3,
    },
    provider: {
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      api_key_env: 'DEEPSEEK_API_KEY',
    },
  };
  await writeFile(path.join(root, 'forge.project.json'), JSON.stringify(project, null, 2), 'utf8');
  await writeJsonl<SourceRecord>(path.join(root, 'sources.jsonl'), [
    {
      source_id: 'src:greenhaven:internal',
      title: 'Greenhaven internal canon',
      retrieved_at: new Date().toISOString().slice(0, 10),
      license: 'internal',
      robots_status: 'internal',
      notes: 'Original project canon and game-master authored content.',
    },
  ]);
  await writeFile(path.join(root, 'audit', 'agent-notes.md'), `# ${slug}\n\n`, 'utf8');
  await writeJsonl(path.join(root, 'audit', 'dedupe-candidates.jsonl'), []);
  await writeJsonl(path.join(root, 'audit', 'rejected-ideas.jsonl'), []);
  return project;
}

export async function loadProject(slugOrPath: string): Promise<LoadedProject> {
  const root = path.isAbsolute(slugOrPath) ? slugOrPath : projectRoot(slugOrPath);
  const project = JSON.parse(
    await readFile(path.join(root, 'forge.project.json'), 'utf8'),
  ) as ForgeProject;
  const sources = await readJsonl<SourceRecord>(path.join(root, 'sources.jsonl'));
  const records = await readAllRecords(root);
  const bridge = await readRuntimeBridge(root);
  return {root, project, sources, records, bridge};
}

/** OWV-17: read every optional generated runtime-bridge artifact under
 *  `audit/`. Missing files leave the matching field undefined so legacy
 *  projects (no Obsidian compiler ever pointed at them) still load
 *  without error. Currency is the first artifact; future artifacts —
 *  scene instructions, materializer blueprints, visual assets — will
 *  layer onto the same `RuntimeBridge` shape.
 */
async function readRuntimeBridge(root: string): Promise<RuntimeBridge> {
  const bridge: RuntimeBridge = {};
  const currencyPath = path.join(root, 'audit', 'currency-rates.json');
  try {
    const raw = await readFile(currencyPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeCurrencyBridge(parsed);
    if (normalized) bridge.currency = normalized;
  } catch (err) {
    if (!isMissingFileError(err)) {
      // Malformed JSON is a soft failure; the SQL export simply skips
      // the currency slice instead of crashing the project load.
    }
  }
  const merchantsPath = path.join(root, 'audit', 'merchant-contracts.jsonl');
  try {
    const raw = await readFile(merchantsPath, 'utf8');
    const merchants = normalizeMerchantBridge(raw);
    if (merchants) bridge.merchants = merchants;
  } catch (err) {
    if (!isMissingFileError(err)) {
      // Same soft-failure policy as currency: a malformed JSONL line
      // is skipped and the merchant bridge stays undefined.
    }
  }
  const materializersPath = path.join(root, 'audit', 'materializes.jsonl');
  try {
    const raw = await readFile(materializersPath, 'utf8');
    const materializers = normalizeMaterializerBridge(raw);
    if (materializers) bridge.materializers = materializers;
  } catch (err) {
    if (!isMissingFileError(err)) {
      // Same soft-failure policy: a malformed materializer row is
      // skipped and the materializer bridge stays undefined.
    }
  }
  const sceneInstructionsPath = path.join(
    root,
    'audit',
    'scene-instructions.jsonl',
  );
  try {
    const raw = await readFile(sceneInstructionsPath, 'utf8');
    const sceneInstructions = normalizeSceneInstructionsBridge(raw);
    if (sceneInstructions) bridge.sceneInstructions = sceneInstructions;
  } catch (err) {
    if (!isMissingFileError(err)) {
      // Same soft-failure policy: malformed JSONL lines skipped, the
      // scene-instructions bridge stays undefined on hard failures.
    }
  }
  const visualAssetsPath = path.join(root, 'audit', 'visual-assets.jsonl');
  try {
    const raw = await readFile(visualAssetsPath, 'utf8');
    const visualAssets = normalizeVisualAssetsBridge(raw);
    if (visualAssets) bridge.visualAssets = visualAssets;
  } catch (err) {
    if (!isMissingFileError(err)) {
      // Same soft-failure policy as the other bridges: a malformed
      // JSONL line is skipped and the artifact stays undefined.
    }
  }
  return bridge;
}

function normalizeCurrencyBridge(value: unknown): CurrencyBridgeArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== 'greenhaven.currency_rates.v1') return null;
  const source_project =
    typeof raw.source_project === 'string' ? raw.source_project : '';
  const coins = Array.isArray(raw.coins)
    ? raw.coins
        .map(coin => normalizeCoin(coin))
        .filter((coin): coin is CurrencyBridgeCoin => coin !== null)
    : [];
  const world_currency_facts = Array.isArray(raw.world_currency_facts)
    ? raw.world_currency_facts
        .map(fact => normalizeWorldFact(fact))
        .filter((fact): fact is CurrencyBridgeWorldFact => fact !== null)
    : [];
  return {
    schema_version: 'greenhaven.currency_rates.v1',
    source_project,
    coins,
    world_currency_facts,
  };
}

function normalizeCoin(value: unknown): CurrencyBridgeCoin | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  if (!slug) return null;
  const mention = typeof raw.mention === 'string' ? raw.mention : `@${slug}`;
  const copperRaw =
    typeof raw.copper_value === 'number'
      ? raw.copper_value
      : typeof raw.copper_value === 'string'
        ? Number(raw.copper_value)
        : NaN;
  const copper_value = Number.isFinite(copperRaw) ? Math.trunc(copperRaw) : 1;
  const source_path = typeof raw.source_path === 'string' ? raw.source_path : '';
  return {slug, mention, copper_value, source_path};
}

function normalizeWorldFact(value: unknown): CurrencyBridgeWorldFact | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  if (!slug) return null;
  const rates: Record<string, number> = {};
  if (raw.rates && typeof raw.rates === 'object' && !Array.isArray(raw.rates)) {
    for (const [key, val] of Object.entries(raw.rates as Record<string, unknown>)) {
      const num = typeof val === 'number' ? val : typeof val === 'string' ? Number(val) : NaN;
      if (Number.isFinite(num)) rates[key] = Math.trunc(num);
    }
  }
  return {
    slug,
    mention: typeof raw.mention === 'string' ? raw.mention : null,
    source_path: typeof raw.source_path === 'string' ? raw.source_path : null,
    rates,
  };
}

function isMissingFileError(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as {code?: string}).code === 'ENOENT';
}

function normalizeMerchantBridge(
  raw: string,
): MerchantContractsBridgeArtifact | null {
  const offers: MerchantBridgeOffer[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const offer = normalizeMerchantOffer(parsed);
    if (offer) offers.push(offer);
  }
  if (offers.length === 0) return null;
  // Deterministic order: same vault → same forge_merchant_contracts
  // meta payload byte-for-byte across re-exports.
  offers.sort((a, b) => {
    if (a.source_slug !== b.source_slug) {
      return a.source_slug.localeCompare(b.source_slug);
    }
    if (a.copper_value !== b.copper_value) return a.copper_value - b.copper_value;
    if (a.line !== b.line) return a.line.localeCompare(b.line);
    return a.offer_id.localeCompare(b.offer_id);
  });
  return {
    schema_version: 'greenhaven.merchant_contracts.v1',
    source_project: '',
    offers,
  };
}

function normalizeMerchantOffer(value: unknown): MerchantBridgeOffer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const source_slug = typeof raw.source_slug === 'string' ? raw.source_slug.trim() : '';
  const line = typeof raw.line === 'string' ? raw.line.trim() : '';
  if (!source_slug || !line) return null;
  const coins = Array.isArray(raw.coins)
    ? raw.coins
        .map(coin => normalizeMerchantCoin(coin))
        .filter((coin): coin is MerchantBridgeCoinRequirement => coin !== null)
    : [];
  if (coins.length === 0) return null;
  const copper_value =
    typeof raw.copper_value === 'number' && Number.isFinite(raw.copper_value)
      ? Math.max(0, Math.trunc(raw.copper_value))
      : coins.reduce((sum, c) => sum + c.amount, 0);
  return {
    offer_id: merchantOfferId(source_slug, line),
    source_slug,
    source_mention: typeof raw.source_mention === 'string' ? raw.source_mention : `@${source_slug}`,
    source_kind: typeof raw.source_kind === 'string' ? raw.source_kind : 'person',
    source_path: typeof raw.source_path === 'string' ? raw.source_path : '',
    line,
    coins,
    copper_value,
  };
}

function normalizeMerchantCoin(value: unknown): MerchantBridgeCoinRequirement | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const coin = typeof raw.coin === 'string' ? raw.coin.trim() : '';
  if (!coin) return null;
  const amountRaw =
    typeof raw.amount === 'number'
      ? raw.amount
      : typeof raw.amount === 'string'
        ? Number(raw.amount)
        : NaN;
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) return null;
  return {coin, amount: Math.trunc(amountRaw)};
}

/** Stable per-line offer id. ``sha256(source_slug + "|" + line)``
 *  truncated to 16 hex chars; same authored line always yields the
 *  same id so player state that points at this offer survives a
 *  re-export. */
export function merchantOfferId(sourceSlug: string, line: string): string {
  return createHash('sha256')
    .update(`${sourceSlug}|${line}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function normalizeMaterializerBridge(
  raw: string,
): MaterializerBridgeArtifact | null {
  const rows: MaterializerBridgeRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const row = normalizeMaterializerRow(parsed);
    if (row) rows.push(row);
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => {
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
  return {
    schema_version: 'greenhaven.materializers.v1',
    source_project: '',
    rows,
  };
}

function normalizeMaterializerRow(value: unknown): MaterializerBridgeRow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const source_slug =
    typeof raw.source_slug === 'string' ? raw.source_slug.trim() : '';
  const entity_slug =
    typeof raw.entity_slug === 'string' ? raw.entity_slug.trim() : '';
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  const scope = typeof raw.scope === 'string' ? raw.scope.trim() : '';
  const effect = typeof raw.effect === 'string' ? raw.effect.trim() : '';
  if (!source_slug || !entity_slug || !type) return null;
  return {
    materializer_id: materializerEntryId(
      source_slug,
      entity_slug,
      type,
      scope,
      effect,
    ),
    source_slug,
    source_mention:
      typeof raw.source_mention === 'string'
        ? raw.source_mention
        : `@${source_slug}`,
    source_kind: typeof raw.source_kind === 'string' ? raw.source_kind : 'person',
    source_path: typeof raw.source_path === 'string' ? raw.source_path : '',
    entity: typeof raw.entity === 'string' ? raw.entity : `@${entity_slug}`,
    entity_slug,
    target_status:
      typeof raw.target_status === 'string' ? raw.target_status : 'existing',
    trigger_condition:
      typeof raw.trigger_condition === 'string' ? raw.trigger_condition.trim() : '',
    trigger_source:
      typeof raw.trigger_source === 'string' ? raw.trigger_source.trim() : 'manual_only',
    type,
    scope,
    effect,
  };
}

function normalizeSceneInstructionsBridge(
  raw: string,
): SceneInstructionsBridgeArtifact | null {
  const rows: SceneInstructionRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const row = normalizeSceneInstructionRow(parsed);
    if (row) rows.push(row);
  }
  if (rows.length === 0) return null;
  rows.sort(sceneInstructionRowOrder);
  return {
    schema_version: 'greenhaven.scene_instructions.v1',
    source_project: '',
    rows,
  };
}

function sceneInstructionRowOrder(
  a: SceneInstructionRow,
  b: SceneInstructionRow,
): number {
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
}

function normalizeSceneInstructionRow(value: unknown): SceneInstructionRow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== 'greenhaven.scene_instructions.v1') return null;
  const scene_slug =
    typeof raw.scene_slug === 'string' ? raw.scene_slug.trim().toLowerCase() : '';
  if (!scene_slug) return null;
  const source_path = typeof raw.source_path === 'string' ? raw.source_path : '';
  const scene_mention =
    typeof raw.scene_mention === 'string' ? raw.scene_mention : `@${scene_slug}`;
  const source_kind = typeof raw.source_kind === 'string' ? raw.source_kind : 'scene';
  const location_slug =
    typeof raw.location_slug === 'string' && raw.location_slug.trim()
      ? raw.location_slug.trim().toLowerCase()
      : null;
  const owner_npc_slug =
    typeof raw.owner_npc_slug === 'string' && raw.owner_npc_slug.trim()
      ? raw.owner_npc_slug.trim().toLowerCase()
      : null;
  const participant_slugs = Array.isArray(raw.participant_slugs)
    ? Array.from(
        new Set(
          raw.participant_slugs
            .filter((s): s is string => typeof s === 'string')
            .map(s => s.trim().toLowerCase())
            .filter(s => s.length > 0),
        ),
      )
    : [];
  const priority = normalizeScenePriority(raw.priority);
  const trigger = typeof raw.trigger === 'string' ? raw.trigger : '';
  const hook = typeof raw.hook === 'string' ? raw.hook : '';
  const beat_by_beat =
    typeof raw.beat_by_beat === 'string' ? raw.beat_by_beat : '';
  const player_choices =
    typeof raw.player_choices === 'string' ? raw.player_choices : '';
  const memory_and_string_changes =
    typeof raw.memory_and_string_changes === 'string'
      ? raw.memory_and_string_changes
      : '';
  const success_result =
    typeof raw.success_result === 'string' ? raw.success_result : '';
  const failure_result =
    typeof raw.failure_result === 'string' ? raw.failure_result : '';
  const behavior = typeof raw.behavior === 'string' ? raw.behavior : '';
  const do_not = typeof raw.do_not === 'string' ? raw.do_not : '';
  const voice = typeof raw.voice === 'string' ? raw.voice : '';
  const model_instructions = Array.isArray(raw.model_instructions)
    ? raw.model_instructions
        .filter((s): s is string => typeof s === 'string')
        .map(s => s.trim())
        .filter(s => s.length > 0)
    : [];
  const state_fields = Array.isArray(raw.state_fields)
    ? raw.state_fields
        .map(normalizeSceneInstructionStateField)
        .filter((f): f is SceneInstructionStateField => f !== null)
    : [];
  const media_script = Array.isArray(raw.media_script)
    ? raw.media_script
        .map(normalizeSceneInstructionMediaCommand)
        .filter((f): f is SceneInstructionMediaCommand => f !== null)
    : [];
  const visual_asset = normalizeSceneInstructionVisualAsset(raw.visual_asset);
  return {
    scene_slug,
    scene_mention,
    source_kind,
    source_path,
    location_slug,
    owner_npc_slug,
    participant_slugs,
    trigger,
    priority,
    hook,
    beat_by_beat,
    player_choices,
    memory_and_string_changes,
    success_result,
    failure_result,
    behavior,
    do_not,
    voice,
    model_instructions,
    state_fields,
    media_script,
    visual_asset,
  };
}

function normalizeScenePriority(value: unknown): string {
  if (typeof value !== 'string') return 'normal';
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'low' || trimmed === 'high') return trimmed;
  return 'normal';
}

function normalizeSceneInstructionStateField(
  value: unknown,
): SceneInstructionStateField | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key) return null;
  const out: SceneInstructionStateField = {
    key,
    type: typeof raw.type === 'string' ? raw.type : 'string',
  };
  if (raw.default !== undefined) out.default = raw.default;
  if (typeof raw.scope === 'string') out.scope = raw.scope;
  if (typeof raw.description === 'string') out.description = raw.description;
  return out;
}

function normalizeSceneInstructionVisualAsset(
  value: unknown,
): SceneInstructionVisualAsset | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!path) return null;
  const out: SceneInstructionVisualAsset = {path};
  if (typeof raw.role === 'string') out.role = raw.role;
  return out;
}

function normalizeSceneInstructionMediaCommand(
  value: unknown,
): SceneInstructionMediaCommand | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : '';
  if (!action) return null;
  const out: SceneInstructionMediaCommand = {action};
  if (typeof raw.asset_role === 'string' && raw.asset_role.trim()) {
    out.asset_role = raw.asset_role.trim().toLowerCase();
  }
  if (typeof raw.label === 'string' && raw.label.trim()) {
    out.label = raw.label.trim();
  }
  if (typeof raw.loop === 'boolean') out.loop = raw.loop;
  if (typeof raw.volume === 'number' && Number.isFinite(raw.volume)) {
    out.volume = Math.max(0, Math.min(1, raw.volume));
  }
  return out;
}

function normalizeVisualAssetsBridge(
  raw: string,
): VisualAssetsBridgeArtifact | null {
  const rows: VisualAssetRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const row = normalizeVisualAssetRow(parsed);
    if (row) rows.push(row);
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.slug !== b.slug) return a.slug.localeCompare(b.slug);
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return a.path.localeCompare(b.path);
  });
  return {
    schema_version: 'greenhaven.visual_assets.v1',
    source_project: '',
    rows,
  };
}

function normalizeVisualAssetRow(value: unknown): VisualAssetRow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
  const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : '';
  const role = typeof raw.role === 'string' ? raw.role.trim().toLowerCase() : '';
  const filePath = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!kind || !slug || !role || !filePath) return null;
  return {
    kind,
    slug,
    mention: typeof raw.mention === 'string' ? raw.mention : `@${slug}`,
    role,
    path: filePath,
    source_path: typeof raw.source_path === 'string' ? raw.source_path : '',
  };
}

/** Stable per-row materializer id.
 *  ``sha256(source_slug + "|" + entity_slug + "|" + type +
 *  "|" + scope + "|" + effect)`` truncated to 16 hex chars; same
 *  authored row always yields the same id so player runtime state
 *  that records an applied materializer survives a re-export. */
export function materializerEntryId(
  sourceSlug: string,
  entitySlug: string,
  type: string,
  scope: string,
  effect: string,
): string {
  return createHash('sha256')
    .update(
      `${sourceSlug}|${entitySlug}|${type}|${scope}|${effect}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, 16);
}

export async function listProjects(): Promise<string[]> {
  await mkdir(projectsRoot(), {recursive: true});
  const entries = await readdir(projectsRoot(), {withFileTypes: true});
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

export async function addSource(root: string, source: SourceRecord): Promise<void> {
  const file = path.join(root, 'sources.jsonl');
  const sources = await readJsonl<SourceRecord>(file);
  if (sources.some(existing => existing.source_id === source.source_id)) {
    throw new Error(`duplicate source_id: ${source.source_id}`);
  }
  sources.push(source);
  await writeJsonl(file, sources);
}

export async function addRecord(root: string, record: IngestRecord): Promise<void> {
  const file = path.join(root, 'records', recordFileName(record.kind));
  const existing = await readJsonl<IngestRecord>(file);
  if (existing.some(row => row.slug === record.slug || row.record_id === record.record_id)) {
    throw new Error(`duplicate record slug or id: ${record.slug}`);
  }
  existing.push(record);
  await writeJsonl(file, existing);
}

export async function upsertRecord(root: string, record: IngestRecord): Promise<void> {
  const file = (await findRecordFile(root, record)) ?? path.join(root, 'records', recordFileName(record.kind));
  const existing = await readJsonl<IngestRecord>(file);
  const idx = existing.findIndex(row => row.slug === record.slug || row.record_id === record.record_id);
  if (idx >= 0) existing[idx] = record;
  else existing.push(record);
  await writeJsonl(file, existing);
}

export async function replaceRecord(
  root: string,
  previous: IngestRecord | undefined,
  record: IngestRecord,
): Promise<void> {
  const oldFile = previous ? await findRecordFile(root, previous) : null;
  const targetFile = path.join(root, 'records', recordFileName(record.kind));
  await mkdir(path.dirname(targetFile), {recursive: true});

  if (oldFile && oldFile !== targetFile && previous) {
    const oldRows = await readJsonl<IngestRecord>(oldFile);
    await writeJsonl(
      oldFile,
      oldRows.filter(row => row.slug !== previous.slug && row.record_id !== previous.record_id),
    );
  }

  const rows = await readJsonl<IngestRecord>(targetFile);
  const previousSlug = previous?.slug;
  const previousId = previous?.record_id;
  const duplicate = rows.find(
    row =>
      (row.slug === record.slug || row.record_id === record.record_id) &&
      row.slug !== previousSlug &&
      row.record_id !== previousId,
  );
  if (duplicate) throw new Error(`duplicate record slug or id: ${record.slug}`);

  const idx = rows.findIndex(
    row =>
      row.slug === previousSlug ||
      row.record_id === previousId ||
      row.slug === record.slug ||
      row.record_id === record.record_id,
  );
  if (idx >= 0) rows[idx] = record;
  else rows.push(record);
  await writeJsonl(targetFile, rows);
}

export function makeRecord(input: {
  kind: IngestRecord['kind'];
  slug: string;
  name: string;
  summary: string;
  tags?: string[];
  payload?: Record<string, unknown>;
  sourceLanguage?: string;
}): IngestRecord {
  return draftRecord(input);
}

async function readAllRecords(root: string): Promise<IngestRecord[]> {
  const dir = path.join(root, 'records');
  await mkdir(dir, {recursive: true});
  const entries = await readdir(dir, {withFileTypes: true});
  const out: IngestRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    out.push(...(await readJsonl<IngestRecord>(path.join(dir, entry.name))));
  }
  return out;
}

async function findRecordFile(root: string, record: Pick<IngestRecord, 'slug' | 'record_id'>): Promise<string | null> {
  const dir = path.join(root, 'records');
  await mkdir(dir, {recursive: true});
  const entries = await readdir(dir, {withFileTypes: true});
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, entry.name);
    const rows = await readJsonl<IngestRecord>(file);
    if (rows.some(row => row.slug === record.slug || row.record_id === record.record_id)) {
      return file;
    }
  }
  return null;
}
