import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';

interface Args {
  sourceSql?: string;
  outVault?: string;
  dbDir?: string;
  keepDb: boolean;
  force: boolean;
}

interface EntityRow {
  id: number;
  kind: string;
  display_name: string;
  summary: string | null;
  profile: unknown;
  tags: string[];
  topology_parent_id: number | null;
  cartridge_id: string | null;
}

interface Entity {
  id: number;
  kind: string;
  displayName: string;
  summary: string | null;
  profile: Record<string, unknown>;
  tags: string[];
  topologyParentId: number | null;
  cartridgeId: string | null;
}

interface RuntimeField {
  ownerEntityId: number;
  fieldKey: string;
  valueType: string;
  defaultValue: unknown;
  allowedValues: unknown;
  scope: string;
  description: string | null;
}

interface ExportContext {
  rows: Entity[];
  byId: Map<number, Entity>;
  bySlug: Map<string, Entity>;
  runtimeByOwner: Map<number, RuntimeField[]>;
  pathById: Map<number, string>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const migrationsDir = path.resolve(
  __dirname,
  '..',
  '..',
  'migrations',
  'archive-prebaseline',
);
const generatedPreviewSql = path.join(
  repoRoot,
  'GreenhavenWorld',
  '.greenhaven-agent-manual',
  'generated',
  'cartridge-forge-project',
  'audit',
  'obsidian-world-preview.sql',
);
const fallbackMigrationSql = path.join(
  migrationsDir,
  '0117_obsidian_world_patch.sql',
);

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const sourceSql = path.resolve(args.sourceSql ?? (await defaultSourceSql()));
  const outVault = path.resolve(
    args.outVault ??
      (await mkdtemp(path.join(os.tmpdir(), 'greenhaven-db-export-vault-'))),
  );
  const dbDir = path.resolve(
    args.dbDir ??
      (await mkdtemp(path.join(os.tmpdir(), 'greenhaven-obsidian-db-'))),
  );
  const ownsDbDir = args.dbDir === undefined;

  await assertEmptyOrCreate(outVault, args.force);

  const db = await PGlite.create(dbDir);
  try {
    await createHostSchema(db);
    const sql = await readFile(sourceSql, 'utf8');
    await applyImportSql(db, sql);
    const rows = await loadEntities(db);
    const runtimeFields = await loadRuntimeFields(db);
    const startingLocationId = await loadStartingLocationId(db);
    const exportReport = await exportVault({
      outVault,
      sourceSql,
      dbDir,
      rows,
      runtimeFields,
      startingLocationId,
    });

    process.stdout.write(`${JSON.stringify(exportReport, null, 2)}\n`);
    return 0;
  } finally {
    await db.close();
    if (ownsDbDir && !args.keepDb && isInside(os.tmpdir(), dbDir)) {
      await rm(dbDir, {recursive: true, force: true});
    }
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {keepDb: false, force: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source-sql') {
      args.sourceSql = requireValue(argv, ++index, arg);
    } else if (arg === '--out-vault') {
      args.outVault = requireValue(argv, ++index, arg);
    } else if (arg === '--db-dir') {
      args.dbDir = requireValue(argv, ++index, arg);
    } else if (arg === '--keep-db') {
      args.keepDb = true;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  process.stdout.write(`Usage:
  npm --prefix packages/web-server run obsidian:roundtrip-smoke -- \\
    --source-sql <obsidian-world-preview.sql> \\
    --out-vault <temporary-vault-dir>

Imports the generated Obsidian SQL into a temporary PGlite DB, reads the DB
rows back, and exports a human Obsidian vault into the output directory.
`);
}

async function defaultSourceSql(): Promise<string> {
  if (await fileExists(generatedPreviewSql)) return generatedPreviewSql;
  return fallbackMigrationSql;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function assertEmptyOrCreate(outVault: string, force: boolean) {
  await mkdir(outVault, {recursive: true});
  if (force) return;
  const entries = await readdir(outVault);
  if (entries.length > 0) {
    throw new Error(
      `Output vault is not empty: ${outVault}. Pass --force only for an explicit temp/staging directory.`,
    );
  }
}

async function applyImportSql(db: PGlite, sql: string): Promise<void> {
  await db.exec(`BEGIN; ${sql}; COMMIT;`);
  await db.query(
    `INSERT INTO schema_migrations (name)
     VALUES ('obsidian-roundtrip-smoke.sql')
     ON CONFLICT (name) DO NOTHING`,
  );
}

async function loadEntities(db: PGlite): Promise<Entity[]> {
  const result = await db.query<EntityRow>(`
    SELECT id::int AS id,
           kind,
           display_name,
           summary,
           profile,
           tags,
           topology_parent_id::int AS topology_parent_id,
           cartridge_id
      FROM entities
     ORDER BY kind, display_name, id
  `);
  return result.rows.map(row => ({
    id: Number(row.id),
    kind: row.kind,
    displayName: row.display_name,
    summary: row.summary,
    profile: asRecord(row.profile),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    topologyParentId:
      row.topology_parent_id === null ? null : Number(row.topology_parent_id),
    cartridgeId: row.cartridge_id,
  }));
}

async function loadRuntimeFields(db: PGlite): Promise<RuntimeField[]> {
  const result = await db.query<{
    owner_entity_id: number;
    field_key: string;
    value_type: string;
    default_value: unknown;
    allowed_values: unknown;
    scope: string;
    description: string | null;
  }>(`
    SELECT owner_entity_id::int AS owner_entity_id,
           field_key,
           value_type,
           default_value,
           allowed_values,
           scope,
           description
      FROM runtime_fields
     ORDER BY owner_entity_id, field_key
  `);
  return result.rows.map(row => ({
    ownerEntityId: Number(row.owner_entity_id),
    fieldKey: row.field_key,
    valueType: row.value_type,
    defaultValue: row.default_value,
    allowedValues: row.allowed_values,
    scope: row.scope,
    description: row.description,
  }));
}

async function loadStartingLocationId(db: PGlite): Promise<number | null> {
  const result = await db.query<{value: unknown}>(`
    SELECT value
      FROM cartridge_meta
     WHERE key = 'starting_location_id'
  `);
  const value = result.rows[0]?.value;
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
  return Number.isInteger(numeric) ? numeric : null;
}

async function exportVault(input: {
  outVault: string;
  sourceSql: string;
  dbDir: string;
  rows: Entity[];
  runtimeFields: RuntimeField[];
  startingLocationId: number | null;
}) {
  const runtimeByOwner = groupByOwner(input.runtimeFields);
  const byId = new Map(input.rows.map(row => [row.id, row]));
  const bySlug = buildSlugMap(input.rows);
  const pathById = new Map<number, string>();
  const ctx: ExportContext = {
    rows: input.rows,
    byId,
    bySlug,
    runtimeByOwner,
    pathById,
  };

  for (const row of input.rows) {
    pathById.set(row.id, notePathFor(row, ctx));
  }

  for (const row of input.rows) {
    const relativePath = pathById.get(row.id);
    if (!relativePath) continue;
    const target = resolveInside(input.outVault, relativePath);
    await writeText(target, renderEntityNote(row, ctx));
  }

  await writeText(
    path.join(input.outVault, 'WORLD_MANIFEST.md'),
    renderManifest(input.startingLocationId, ctx),
  );

  const counts = countBy(input.rows, row => row.kind);
  const missingSourcePath = input.rows
    .filter(row => !sourcePath(row))
    .map(row => `${row.kind}:${row.displayName}`);
  const report = {
    ok: true,
    sourceSql: input.sourceSql,
    tempDbDir: input.dbDir,
    outVault: input.outVault,
    records: input.rows.length,
    runtimeFields: input.runtimeFields.length,
    counts,
    startingLocationId: input.startingLocationId,
    exportedFiles: input.rows.length + 1,
    warnings: {
      missingSourcePath,
    },
  };
  const reportDir = path.join(
    input.outVault,
    '.greenhaven-agent-manual',
    'generated',
  );
  await writeText(
    path.join(reportDir, 'db-roundtrip-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeText(
    path.join(reportDir, 'db-roundtrip-report.md'),
    renderReport(report),
  );
  return report;
}

function groupByOwner(fields: RuntimeField[]): Map<number, RuntimeField[]> {
  const out = new Map<number, RuntimeField[]>();
  for (const field of fields) {
    const list = out.get(field.ownerEntityId) ?? [];
    list.push(field);
    out.set(field.ownerEntityId, list);
  }
  return out;
}

function buildSlugMap(rows: Entity[]): Map<string, Entity> {
  const out = new Map<string, Entity>();
  for (const row of rows) {
    const slug = stringProfile(row, 'source_slug');
    if (slug) out.set(slug, row);
    out.set(slugify(row.displayName), row);
  }
  return out;
}

function notePathFor(row: Entity, ctx: ExportContext): string {
  const existing = sourcePath(row);
  if (existing) return existing;

  if (row.kind === 'location') {
    return `${locationFolder(row, ctx)}/${mindFile(row.displayName)}`;
  }

  if (row.kind === 'person') {
    const home = entityIdProfile(row, 'home_id', ctx);
    const folder = home ? locationFolder(home, ctx) : 'GreenHavenWorld/NPC';
    return `${folder}/npc/${atFolder(row.displayName)}/${mindFile(row.displayName)}`;
  }

  if (row.kind === 'item') {
    if (stringProfile(row, 'item_kind') === 'currency') {
      return `GreenHavenWorld/Economy/items/${atFolder(row.displayName)}/${mindFile(
        row.displayName,
      )}`;
    }
    const location = entityIdProfile(row, 'location_id', ctx);
    const folder = location ? locationFolder(location, ctx) : 'GreenHavenWorld/items';
    return `${folder}/items/${atFolder(row.displayName)}/${mindFile(row.displayName)}`;
  }

  if (row.kind === 'quest') {
    const source = slugProfile(row, 'quest_source_slug', ctx);
    if (source) {
      const sourceNote = notePathFor(source, ctx);
      const sourceFolder = path.posix.dirname(toPosix(sourceNote));
      return `${sourceFolder}/quests/${safeFileName(row.displayName)}.md`;
    }
    const location = entityIdProfile(row, 'location_id', ctx);
    const folder = location ? locationFolder(location, ctx) : 'GreenHavenWorld/quests';
    return `${folder}/quests/${safeFileName(row.displayName)}.md`;
  }

  if (row.kind === 'scene') {
    const owner = slugProfile(row, 'owner_npc_slug', ctx);
    if (owner) {
      const ownerNote = notePathFor(owner, ctx);
      const ownerFolder = path.posix.dirname(toPosix(ownerNote));
      return `${ownerFolder}/scenes/${atFile(row.displayName)}`;
    }
    const location = entityIdProfile(row, 'location_id', ctx);
    const folder = location ? locationFolder(location, ctx) : 'GreenHavenWorld/scenes';
    return `${folder}/scenes/${atFile(row.displayName)}`;
  }

  if (row.kind === 'world_fact' && /currency/i.test(row.displayName)) {
    return 'GreenHavenWorld/Economy/Currency.md';
  }

  return `GreenHavenWorld/world/${safeFileName(row.displayName)}.md`;
}

function locationFolder(row: Entity, ctx: ExportContext): string {
  const existing = sourcePath(row);
  if (existing) return path.posix.dirname(existing);
  const parent = topologyParent(row, ctx);
  const parentFolder = parent
    ? locationFolder(parent, ctx)
    : 'GreenHavenWorld/Locations';
  return `${parentFolder}/${atFolder(row.displayName)}`;
}

function topologyParent(row: Entity, ctx: ExportContext): Entity | null {
  // ARCH-19 Phase 4 prereq: prefer the normalized
  // `entities.topology_parent_id` column over the retired
  // `profile.topology_parent_id` JSONB key. Fresh exports no longer
  // carry the JSONB key at all; older donor cartridges still do, so
  // we keep the profile fallback for backward-compat reads.
  if (typeof row.topologyParentId === 'number') {
    return ctx.byId.get(row.topologyParentId) ?? null;
  }
  return entityIdProfile(row, 'topology_parent_id', ctx);
}

function renderEntityNote(row: Entity, ctx: ExportContext): string {
  const sourceMarkdown = stringProfile(row, 'source_markdown');
  if (sourceMarkdown) return `${sourceMarkdown.replace(/\s+$/u, '')}\n`;
  if (row.kind === 'person') return renderPerson(row);
  if (row.kind === 'location') return renderLocation(row, ctx);
  if (row.kind === 'item') return renderItem(row);
  if (row.kind === 'quest') return renderQuest(row);
  if (row.kind === 'scene') {
    return renderScene(row, ctx.runtimeByOwner.get(row.id) ?? []);
  }
  return renderWorldFact(row);
}

function renderPerson(row: Entity): string {
  const source = recordProfile(row, 'source');
  return joinSections([
    title(row, true),
    section(
      'Identity',
      firstText(
        stringProfile(row, 'identity'),
        stringProfile(row, 'archetype'),
        stringRecord(source, 'archetype'),
        row.summary,
      ),
    ),
    section('Appearance', stringProfile(row, 'appearance')),
    section('Sexual Appearance', stringProfile(row, 'sexual_appearance')),
    section(
      'Voice',
      firstText(
        stringProfile(row, 'voice'),
        stringProfile(row, 'speech_style'),
        stringRecord(source, 'speech_style'),
      ),
    ),
    section('Relationship', stringProfile(row, 'relationship')),
    section('Romance', stringProfile(row, 'romance')),
    section('Skills', stringProfile(row, 'skills')),
    section('Behavior', stringProfile(row, 'behavior')),
    section('Merchant', renderMerchantOffers(row.profile.merchant_offers)),
    section('Inventory', stringProfile(row, 'inventory')),
    section('Materializes', renderMaterializes(row.profile.materializes)),
    section('Visuals', renderVisuals(row.profile.visual_assets)),
  ]);
}

function renderLocation(row: Entity, ctx: ExportContext): string {
  const children = childLocations(row, ctx).map(child => `- [[${displayMention(child)}]]`);
  return joinSections([
    title(row, true),
    section('Location Brief', firstText(stringProfile(row, 'location_brief'), row.summary)),
    section(
      'Location Canon',
      firstText(stringProfile(row, 'location_canon'), stringProfile(row, 'narrator_brief')),
    ),
    section('Exits', children.join('\n')),
    section('Visuals', renderVisuals(row.profile.visual_assets)),
  ]);
}

function renderItem(row: Entity): string {
  const currencyValue = row.profile.currency_value;
  return joinSections([
    title(row, true),
    section(
      'Item Description',
      firstText(stringProfile(row, 'item_description'), stringProfile(row, 'description'), row.summary),
    ),
    section('Item Kind', stringProfile(row, 'item_kind')),
    section(
      'Currency Value',
      typeof currencyValue === 'number' ? `${currencyValue} copper units` : '',
    ),
    section(
      'Use Contract',
      firstText(
        stringProfile(row, 'item_usage'),
        stringProfile(row, 'item_canon'),
        stringProfile(row, 'use_contract'),
      ),
    ),
    section('Merchant', renderMerchantOffers(row.profile.merchant_offers)),
    section('Materializes', renderMaterializes(row.profile.materializes)),
    section('Visuals', renderVisuals(row.profile.visual_assets)),
  ]);
}

function renderQuest(row: Entity): string {
  return joinSections([
    title(row, false),
    section('Hook', firstText(stringProfile(row, 'hook'), row.summary)),
    section(
      'Objective',
      firstText(stringProfile(row, 'quest_objective'), stringProfile(row, 'objective')),
    ),
    section('Stages', firstText(stringProfile(row, 'quest_stages'), renderStages(row.profile.stages))),
    section(
      'Rewards',
      firstText(stringProfile(row, 'quest_rewards'), stringProfile(row, 'rewards')),
    ),
    section('Materializes', renderMaterializes(row.profile.materializes)),
  ]);
}

function renderScene(row: Entity, runtimeFields: RuntimeField[]): string {
  return joinSections([
    title(row, true),
    section(
      'Trigger',
      firstText(stringProfile(row, 'scene_trigger'), stringProfile(row, 'trigger'), row.summary),
    ),
    section('Priority', stringProfile(row, 'priority')),
    section(
      'Behavior',
      firstText(stringProfile(row, 'scene_behavior'), stringProfile(row, 'behavior')),
    ),
    section(
      'State Fields',
      firstText(stringProfile(row, 'scene_state'), renderRuntimeFields(runtimeFields)),
    ),
    section('Voice', stringProfile(row, 'voice')),
    section('Do Not', stringProfile(row, 'scene_do_not')),
    section('Model Instructions', renderStringList(row.profile.model_instructions)),
    section('Visuals', renderVisuals(row.profile.visual_assets)),
  ]);
}

function renderWorldFact(row: Entity): string {
  return joinSections([
    title(row, false),
    section('Canon', row.summary),
    section('Materializes', renderMaterializes(row.profile.materializes)),
  ]);
}

function title(row: Entity, mention: boolean): string {
  return `# ${mention ? displayMention(row) : row.displayName}`;
}

function section(name: string, body: string | null | undefined): string {
  const text = body?.trim();
  return text ? `## ${name}\n\n${text}` : '';
}

function joinSections(parts: Array<string | null | undefined>): string {
  return `${parts.filter(part => part && part.trim()).join('\n\n')}\n`;
}

function renderMerchantOffers(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter(isRecord)
    .map(offer => {
      const line = stringRecord(offer, 'line');
      const copper = numberRecord(offer, 'copper_value');
      if (line && copper !== null) return `- ${line} (${copper} copper units)`;
      if (line) return `- ${line}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function renderMaterializes(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter(isRecord)
    .map(item =>
      [
        `- Entity: ${stringRecord(item, 'entity') ?? ''}`,
        `  Type: ${stringRecord(item, 'type') ?? ''}`,
        `  Scope: ${stringRecord(item, 'scope') ?? ''}`,
        `  Effect: ${stringRecord(item, 'effect') ?? ''}`,
      ].join('\n'),
    )
    .join('\n');
}

function renderVisuals(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter(isRecord)
    .map(asset => {
      const role = stringRecord(asset, 'role') ?? 'asset';
      const assetPath = stringRecord(asset, 'path') ?? '';
      return assetPath ? `- ${role}: ${assetPath}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function renderStages(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter(isRecord)
    .map((stage, index) => {
      const name = stringRecord(stage, 'name') ?? `Stage ${index + 1}`;
      const description =
        stringRecord(stage, 'description') ?? stringRecord(stage, 'goal') ?? '';
      return `- ${name}: ${description}`.trimEnd();
    })
    .join('\n');
}

function renderRuntimeFields(fields: RuntimeField[]): string {
  return fields
    .map(field => {
      const defaultValue =
        field.defaultValue === null || field.defaultValue === undefined
          ? 'null'
          : JSON.stringify(field.defaultValue);
      const description = field.description ? ` - ${field.description}` : '';
      return `- ${field.fieldKey}: ${field.valueType}, ${field.scope}, default ${defaultValue}${description}`;
    })
    .join('\n');
}

function renderStringList(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map(item => `- ${String(item).trim()}`).join('\n');
}

function renderManifest(
  startingLocationId: number | null,
  ctx: ExportContext,
): string {
  const start = startingLocationId ? ctx.byId.get(startingLocationId) : undefined;
  const link = start ? wikiLink(start, ctx) : 'not set';
  return joinSections([
    '# Greenhaven World Manifest',
    section(
      'Start Location',
      start ? `${link}\n\nThe hero starts in ${displayMention(start)}.` : link,
    ),
    section(
      'Authoring Contract',
      [
        'This vault was exported from a Greenhaven database snapshot.',
        'Edit human prose sections, keep canonical @Name mentions unchanged, then compile back through the Greenhaven human-world transformer.',
      ].join('\n\n'),
    ),
  ]);
}

function wikiLink(row: Entity, ctx: ExportContext): string {
  const notePath = ctx.pathById.get(row.id);
  if (!notePath) return displayMention(row);
  return `[[${notePath.replace(/\.md$/i, '')}|${displayMention(row)}]]`;
}

function renderReport(report: {
  sourceSql: string;
  tempDbDir: string;
  outVault: string;
  records: number;
  runtimeFields: number;
  counts: Record<string, number>;
  startingLocationId: number | null;
  warnings: {missingSourcePath: string[]};
}): string {
  const counts = Object.entries(report.counts)
    .map(([kind, count]) => `- ${kind}: ${count}`)
    .join('\n');
  const warnings =
    report.warnings.missingSourcePath.length > 0
      ? report.warnings.missingSourcePath.map(item => `- ${item}`).join('\n')
      : '- none';
  return joinSections([
    '# DB Roundtrip Export Report',
    section('Source SQL', report.sourceSql),
    section('Temporary DB', report.tempDbDir),
    section('Output Vault', report.outVault),
    section('Counts', counts),
    section('Runtime Fields', String(report.runtimeFields)),
    section('Starting Location Id', String(report.startingLocationId ?? 'not set')),
    section('Records Without Source Path', warnings),
  ]);
}

function childLocations(row: Entity, ctx: ExportContext): Entity[] {
  return ctx.rows
    .filter(
      item =>
        item.kind === 'location' &&
        topologyParent(item, ctx)?.id === row.id,
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function entityIdProfile(
  row: Entity,
  key: string,
  ctx: ExportContext,
): Entity | null {
  const value = row.profile[key];
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) ? ctx.byId.get(number) ?? null : null;
}

function slugProfile(row: Entity, key: string, ctx: ExportContext): Entity | null {
  const value = stringProfile(row, key);
  return value ? ctx.bySlug.get(value) ?? null : null;
}

function sourcePath(row: Entity): string | null {
  const value = stringProfile(row, 'source_path')?.replace(/\\/g, '/');
  if (!value || !value.startsWith('GreenHavenWorld/') || !value.endsWith('.md')) {
    return null;
  }
  if (value.includes('../') || value.includes('/..')) return null;
  return value;
}

function displayMention(row: Entity): string {
  const canonical = stringProfile(row, 'canonical_mention');
  if (canonical) return canonical;
  return row.displayName.startsWith('@') ? row.displayName : `@${row.displayName}`;
}

function atFolder(name: string): string {
  return name.startsWith('@') ? safeFileName(name) : `@${safeFileName(name)}`;
}

function atFile(name: string): string {
  return `${atFolder(name)}.md`;
}

function mindFile(name: string): string {
  const stem = name
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${stem || 'Entity'}Mind.md`;
}

function safeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function resolveInside(root: string, relativePath: string): string {
  const normalized = toPosix(relativePath);
  if (path.isAbsolute(normalized) || normalized.includes('../') || normalized.includes('/..')) {
    throw new Error(`Unsafe export path: ${relativePath}`);
  }
  const target = path.resolve(root, normalized);
  if (!isInside(root, target)) {
    throw new Error(`Export path escapes output vault: ${relativePath}`);
  }
  return target;
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function stringProfile(row: Entity, key: string): string | null {
  const value = row.profile[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function recordProfile(row: Entity, key: string): Record<string, unknown> {
  return asRecord(row.profile[key]);
}

function firstText(...values: Array<string | null | undefined>): string {
  return values.find(value => value !== null && value !== undefined && value.trim()) ?? '';
}

function stringRecord(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberRecord(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, text, 'utf8');
}

async function createHostSchema(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE entities (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      summary TEXT,
      profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      tags TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      cartridge_id TEXT,
      topology_parent_id BIGINT REFERENCES entities(id) ON DELETE SET NULL,
      dynamic_origin BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE runtime_fields (
      id BIGSERIAL PRIMARY KEY,
      owner_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      field_key TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK (value_type IN
        ('int','float','bool','string','enum','entity_ref','json','dice')),
      default_value JSONB,
      allowed_values JSONB,
      scope TEXT NOT NULL DEFAULT 'session' CHECK (scope IN
        ('turn','scene','session','journey','permanent')),
      description TEXT,
      UNIQUE (owner_entity_id, field_key)
    );

    CREATE TABLE runtime_values (
      field_id BIGINT PRIMARY KEY REFERENCES runtime_fields(id) ON DELETE CASCADE,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source TEXT
    );

    CREATE TABLE cartridge_meta (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- OWV-14: production migrations also UPSERT canonical currency
    -- rows into the inventory items catalog so the runtime currency
    -- bridge can resolve coin slugs by name. Shape mirrors migration
    -- 0046 plus legacy_entity_id from the consolidation chain.
    CREATE TABLE items (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL CHECK (category IN
        ('weapon','armor','consumable','tool','quest','material','currency')),
      weight_kg NUMERIC(5,2) NOT NULL DEFAULT 0,
      stackable BOOLEAN NOT NULL DEFAULT false,
      max_stack INTEGER NOT NULL DEFAULT 1,
      behaviour JSONB NOT NULL DEFAULT '{}'::jsonb,
      legacy_entity_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION safe_to_bigint(value text)
    RETURNS bigint
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
    BEGIN
      IF value !~ '^-?[0-9]+$' THEN
        RETURN NULL;
      END IF;
      BEGIN
        RETURN value::bigint;
      EXCEPTION
        WHEN numeric_value_out_of_range OR invalid_text_representation THEN
          RETURN NULL;
      END;
    END;
    $$;

    CREATE OR REPLACE FUNCTION gh_forge_merge_entity_profile(
      existing_profile jsonb,
      incoming_profile jsonb
    ) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
      SELECT
        COALESCE(incoming_profile, '{}'::jsonb)
        || CASE
             WHEN existing_profile IS NOT NULL
                  AND existing_profile ? 'topology_parent_id' THEN
               jsonb_build_object(
                 'topology_parent_id',
                 existing_profile -> 'topology_parent_id'
               )
             ELSE '{}'::jsonb
           END
        || CASE
             WHEN existing_profile IS NOT NULL
                  AND existing_profile ? 'local_density' THEN
               jsonb_build_object(
                 'local_density',
                 existing_profile -> 'local_density'
               )
             ELSE '{}'::jsonb
           END
        || CASE
             WHEN existing_profile IS NOT NULL
                  AND existing_profile ? 'local_density_summary' THEN
               jsonb_build_object(
                 'local_density_summary',
                 existing_profile -> 'local_density_summary'
               )
             ELSE '{}'::jsonb
           END
    $$;
  `);
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
