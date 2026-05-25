/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Round-trip text-file exporter/importer for individual cartridge
// entities (NPCs, quests). One file per entity, YAML frontmatter +
// Markdown body. Designed for human editing: open the file, change
// prose or structured data, save, run import to push back to the DB.
//
// Usage:
//   tsx src/scripts/entity-card-io.ts export-npc    --id <id>   [--out <dir>]
//   tsx src/scripts/entity-card-io.ts export-npc    --all       [--out <dir>]
//   tsx src/scripts/entity-card-io.ts export-quest  --id <id>   [--out <dir>]
//   tsx src/scripts/entity-card-io.ts export-quest  --all       [--out <dir>]
//   tsx src/scripts/entity-card-io.ts import        <file.md>   [--dry-run]
//
// File layout under --out (default ./entity-cards/):
//   <out>/npcs/<id>-<slug>.md
//   <out>/quests/<id>-<slug>.md
//
// Frontmatter format: a `kind:` field selects npc | quest. Body sections
// map to specific profile.* keys (see PROSE_SECTIONS). Anything in
// frontmatter overrides the DB on import; anything NOT mentioned in the
// file is left untouched in the DB (no destructive blanket overwrite).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { clearConfigEnv, setConfigEnv } from '../config.js';
import {stripEntityProfileAliases} from '../entities/profileSanitizer.js';

// Allow --pgdata <dir> to point at an arbitrary pglite data directory
// (typically %APPDATA%/GreenHaven/pgdata where the desktop runtime
// stores its DB). Must be parsed BEFORE db.js is imported, because
// db.js reads PGLITE_DATA_DIR / DATABASE_URL on first import.
const pgdataArg = (() => {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pgdata' && argv[i + 1]) return argv[i + 1];
    const eq = argv[i]?.match(/^--pgdata=(.+)$/);
    if (eq) return eq[1];
  }
  return null;
})();
if (pgdataArg) {
  clearConfigEnv('DATABASE_URL');
  setConfigEnv('PGLITE_DATA_DIR', pgdataArg);
}

const { query } = await import('../db.js');
const { selectEntityCardNpcMemoryRows } = await import(
  '../domain/memory/index.js'
);

interface EntityRow {
  id: number;
  kind: string;
  display_name: string;
  summary: string | null;
  profile: Record<string, unknown> | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
}

// Profile keys that render as Markdown body sections (long-form prose).
// Anything not listed here stays in YAML frontmatter (structured data).
const PROSE_SECTIONS_NPC: Array<{ key: string; heading: string }> = [
  { key: 'description', heading: 'Description' },
  { key: 'archetype', heading: 'Archetype' },
  { key: 'role', heading: 'Role' },
  { key: 'personality', heading: 'Personality' },
  { key: 'speech_style', heading: 'Speech style' },
  { key: 'narrator_brief', heading: 'Narrator brief' },
  { key: 'goal', heading: 'Goal' },
  { key: 'consent_register', heading: 'Consent register' },
  { key: 'backstory', heading: 'Backstory' },
  { key: 'system_prompt_overlay', heading: 'System prompt overlay' },
];

const PROSE_SECTIONS_QUEST: Array<{ key: string; heading: string }> = [
  { key: 'description', heading: 'Description' },
  { key: 'hook', heading: 'Hook' },
  { key: 'goal_text', heading: 'Goal' },
  { key: 'accept_condition', heading: 'Accept condition' },
  { key: 'bridge_summary', heading: 'Bridge summary' },
  { key: 'narrator_brief', heading: 'Narrator brief' },
];

async function loadEntity(id: number): Promise<EntityRow | null> {
  const r = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, created_at, updated_at
       FROM entities WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function loadAllByKind(kinds: string[]): Promise<EntityRow[]> {
  const r = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, created_at, updated_at
       FROM entities
      WHERE kind = ANY($1::text[])
      ORDER BY id`,
    [kinds],
  );
  return r.rows;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9а-яёa-zа-я]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

interface CardFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

function renderCard(card: CardFile): string {
  const yaml = stringifyYaml(card.frontmatter, {
    sortMapEntries: false,
    lineWidth: 0,
    indent: 2,
  }).trimEnd();
  return `---\n${yaml}\n---\n\n${card.body.trim()}\n`;
}

function parseCard(text: string): CardFile {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    throw new Error(
      'File does not start with YAML frontmatter (---). Frontmatter is required to identify the entity.',
    );
  }
  const fm = parseYaml(match[1] ?? '') as Record<string, unknown>;
  return { frontmatter: fm ?? {}, body: match[2] ?? '' };
}

function splitBodySections(body: string): Map<string, string> {
  // Sections are level-2 ATX headings ("## Heading"). Treat the part
  // before the first ## as the "Summary" block by default.
  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let currentHeading = 'Summary';
  let buf: string[] = [];
  const flush = () => {
    const txt = buf.join('\n').trim();
    if (txt) sections.set(currentHeading, txt);
    buf = [];
  };
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1) continue; // top-level title is just the display name; skip
    if (h2) {
      flush();
      currentHeading = h2[1] ?? currentHeading;
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

function getProfileString(
  profile: Record<string, unknown>,
  key: string,
): string | null {
  const v = profile[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function isReadonlyProfileKey(key: string): boolean {
  // local_density* is a derived index, not authored content. Same for
  // transitive_density_summary. Round-trip would corrupt the rebuilds in
  // migrations 0091-0095; we leave these in the DB untouched and do not
  // re-emit them from the file.
  return (
    key === 'local_density' ||
    key === 'local_density_summary' ||
    key === 'transitive_density_summary'
  );
}

// ── EXPORT ─────────────────────────────────────────────────────────────

async function exportNpc(npc: EntityRow): Promise<string> {
  const profile = (npc.profile ?? {}) as Record<string, unknown>;
  const summary = npc.summary ?? '';

  // Strings (relationship band) with each player who has interacted.
  // The runtime_values.value JSONB for field_key='strings' is a single
  // {<playerEntityId>: <count>} map per owner — there is no per-player
  // row, just the merged JSONB blob.
  const strings = await query<{ value: unknown }>(
    `SELECT COALESCE(rv.value, rf.default_value) AS value
       FROM runtime_fields rf
       LEFT JOIN runtime_values rv ON rv.field_id = rf.id
      WHERE rf.owner_entity_id = $1
        AND rf.field_key = 'strings'`,
    [npc.id],
  );
  const stringsMap: Record<string, number> = {};
  for (const row of strings.rows) {
    const v = row.value;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'number') stringsMap[k] = val;
        else if (typeof val === 'string' && !isNaN(Number(val)))
          stringsMap[k] = Number(val);
      }
    }
  }

  // Memory bank — top 12 by salience. Read-only block in the body.
  const memRows = await selectEntityCardNpcMemoryRows(npc.id);
  const mem = { rows: memRows };

  // Quests where this NPC is involved (giver / source / actor in profile).
  const quests = await query<{
    id: number;
    display_name: string;
    summary: string | null;
  }>(
    `SELECT id, display_name, summary
       FROM entities
      WHERE kind = 'quest'
        AND (
          profile->>'giver_entity_id' = $1::text
          OR profile->>'giver_id' = $1::text
          OR profile->>'quest_giver_id' = $1::text
          OR profile->>'source_entity_id' = $1::text
        )
      ORDER BY id`,
    [npc.id],
  );

  // Scenes this NPC participates in (witness scope basis).
  const scenes = await query<{
    id: number;
    display_name: string;
    summary: string | null;
  }>(
    // M-5: safe_to_bigint guards the JSON→bigint cast (the
    // participant entry might be a non-integer or bigint-overflow
    // string in malformed cartridges).
    // M-6: safe_jsonb_array hardens the array-shape guard.
    `SELECT id, display_name, summary
       FROM entities s
       JOIN LATERAL jsonb_array_elements_text(
         safe_jsonb_array(s.profile->'participant_entity_ids')
       ) AS pid ON true
      WHERE s.kind = 'scene'
        AND safe_to_bigint(pid) = $1
      ORDER BY s.id`,
    [npc.id],
  );

  const frontmatter: Record<string, unknown> = {
    id: npc.id,
    kind: 'person',
    display_name: npc.display_name,
    cartridge_id: profile['cartridge_id'] ?? null,
    species: profile['species'] ?? null,
    pronouns: profile['pronouns'] ?? null,
    age: profile['age'] ?? null,
    venue_role: profile['venue_role'] ?? null,
    home_id: profile['home_id'] ?? null,
    location_id: profile['location_id'] ?? null,
    current_location_id: profile['current_location_id'] ?? null,
    power_center_id: profile['power_center_id'] ?? null,
    power_center_role: profile['power_center_role'] ?? null,
    portrait_set: profile['portrait_set'] ?? null,
    price_list: profile['price_list'] ?? null,
    tags: npc.tags ?? [],
    strings: Object.keys(stringsMap).length > 0 ? stringsMap : null,
    quests: quests.rows.map((q) => ({ id: q.id, title: q.display_name })),
    scenes: scenes.rows.map((s) => ({ id: s.id, title: s.display_name })),
  };

  // Drop nulls/empties from the frontmatter so it's not cluttered.
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v == null) delete frontmatter[k];
    if (Array.isArray(v) && v.length === 0) delete frontmatter[k];
  }

  // Carry any profile keys we did not promote to YAML or to a body
  // section under a generic `extra_profile` map so import knows to
  // re-merge them. This makes the round-trip safe for cartridges that
  // author exotic keys we did not anticipate.
  const knownKeys = new Set<string>([
    'cartridge_id',
    'species',
    'pronouns',
    'age',
    'venue_role',
    'home_id',
    'location_id',
    'current_location_id',
    'power_center_id',
    'power_center_role',
    'portrait_set',
    'price_list',
    ...PROSE_SECTIONS_NPC.map((s) => s.key),
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (knownKeys.has(k) || isReadonlyProfileKey(k)) continue;
    extra[k] = v;
  }
  if (Object.keys(extra).length > 0) frontmatter['extra_profile'] = extra;

  // Body: title + summary + prose sections + memory + quests.
  const bodyParts: string[] = [`# ${npc.display_name}`, ''];
  if (summary.trim()) {
    bodyParts.push('## Summary', summary.trim(), '');
  }
  for (const sec of PROSE_SECTIONS_NPC) {
    const text = getProfileString(profile, sec.key);
    if (text) {
      bodyParts.push(`## ${sec.heading}`, text, '');
    }
  }
  if (mem.rows.length > 0) {
    bodyParts.push('## Memory bank (read-only; top 12 by salience)');
    for (const m of mem.rows) {
      const flag = m.visibility === 'private' ? ' [private]' : '';
      const tags = m.tags && m.tags.length > 0 ? ` {${m.tags.join(',')}}` : '';
      const about = m.about_name ? ` about=${m.about_name}` : '';
      bodyParts.push(
        `- (sal ${Number(m.salience).toFixed(2)}, imp ${Number(m.importance).toFixed(2)})${flag}${about}${tags}: ${m.text}`,
      );
    }
    bodyParts.push('');
  }

  return renderCard({ frontmatter, body: bodyParts.join('\n') });
}

async function exportQuest(q: EntityRow): Promise<string> {
  const profile = (q.profile ?? {}) as Record<string, unknown>;
  const stages = Array.isArray(profile['stages']) ? profile['stages'] : [];

  const frontmatter: Record<string, unknown> = {
    id: q.id,
    kind: 'quest',
    display_name: q.display_name,
    cartridge_id: profile['cartridge_id'] ?? null,
    giver_entity_id: profile['giver_entity_id'] ?? null,
    source_entity_id: profile['source_entity_id'] ?? null,
    location_id: profile['location_id'] ?? null,
    tags: q.tags ?? [],
    stages,
  };
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v == null) delete frontmatter[k];
    if (Array.isArray(v) && v.length === 0) delete frontmatter[k];
  }
  const knownKeys = new Set<string>([
    'cartridge_id',
    'giver_entity_id',
    'source_entity_id',
    'location_id',
    'stages',
    ...PROSE_SECTIONS_QUEST.map((s) => s.key),
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (knownKeys.has(k) || isReadonlyProfileKey(k)) continue;
    extra[k] = v;
  }
  if (Object.keys(extra).length > 0) frontmatter['extra_profile'] = extra;

  const bodyParts: string[] = [`# ${q.display_name}`, ''];
  if ((q.summary ?? '').trim()) {
    bodyParts.push('## Summary', q.summary!.trim(), '');
  }
  for (const sec of PROSE_SECTIONS_QUEST) {
    const text = getProfileString(profile, sec.key);
    if (text) bodyParts.push(`## ${sec.heading}`, text, '');
  }

  return renderCard({ frontmatter, body: bodyParts.join('\n') });
}

// ── IMPORT ─────────────────────────────────────────────────────────────

async function importEntity(filePath: string, dryRun: boolean): Promise<void> {
  const text = readFileSync(filePath, 'utf8');
  const card = parseCard(text);
  const fm = card.frontmatter;
  const id = Number(fm['id']);
  const kind = String(fm['kind'] ?? '');
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `Frontmatter must have positive integer "id". Got: ${JSON.stringify(fm['id'])}`,
    );
  }
  if (kind !== 'person' && kind !== 'quest') {
    throw new Error(
      `Frontmatter "kind" must be "person" or "quest". Got: ${kind}`,
    );
  }
  const existing = await loadEntity(id);
  if (!existing) {
    throw new Error(
      `No entity with id=${id} in DB. Refusing to create from card (cards round-trip existing entities; use cartridge YAML for new ones).`,
    );
  }
  if (existing.kind !== kind) {
    throw new Error(
      `File kind="${kind}" but DB kind="${existing.kind}" for id=${id}. Refusing.`,
    );
  }

  const sections = splitBodySections(card.body);
  const prosePlan =
    kind === 'person' ? PROSE_SECTIONS_NPC : PROSE_SECTIONS_QUEST;

  // Build the new profile by merging: existing.profile → typed YAML
  // fields → extra_profile → body sections. We start from existing so
  // that DB-managed keys (local_density* and friends) survive untouched.
  const nextProfile: Record<string, unknown> = stripEntityProfileAliases(
    existing.profile ?? {},
  );

  // Whitelisted YAML keys → profile fields.
  const yamlKeys =
    kind === 'person'
      ? [
          'cartridge_id',
          'species',
          'pronouns',
          'age',
          'venue_role',
          'home_id',
          'location_id',
          'current_location_id',
          'power_center_id',
          'power_center_role',
          'portrait_set',
          'price_list',
        ]
      : [
          'cartridge_id',
          'giver_entity_id',
          'source_entity_id',
          'location_id',
          'stages',
        ];
  for (const k of yamlKeys) {
    if (k in fm) nextProfile[k] = fm[k];
  }

  const extra = fm['extra_profile'];
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      if (isReadonlyProfileKey(k)) continue;
      nextProfile[k] = v;
    }
  }

  for (const sec of prosePlan) {
    const text = sections.get(sec.heading);
    if (text != null) nextProfile[sec.key] = text;
  }

  const newDisplayName =
    typeof fm['display_name'] === 'string' && fm['display_name']
      ? String(fm['display_name'])
      : existing.display_name;
  const newSummary = sections.get('Summary') ?? existing.summary ?? null;
  const newTags = Array.isArray(fm['tags'])
    ? (fm['tags'] as unknown[]).filter(
        (t): t is string => typeof t === 'string',
      )
    : (existing.tags ?? []);

  const profileForPersist = stripEntityProfileAliases(nextProfile);
  const change = {
    id,
    kind,
    display_name: { from: existing.display_name, to: newDisplayName },
    summary_chars: {
      from: (existing.summary ?? '').length,
      to: (newSummary ?? '').length,
    },
    tags: { from: existing.tags ?? [], to: newTags },
    profile_keys_changed: diffProfileKeys(existing.profile ?? {}, profileForPersist),
  };

  if (dryRun) {
    console.log(JSON.stringify(change, null, 2));
    return;
  }

  await query(
    `UPDATE entities
        SET display_name = $2,
            summary      = $3,
            profile      = $4::jsonb,
            tags         = $5::text[],
            updated_at   = now()
      WHERE id = $1`,
    [id, newDisplayName, newSummary, JSON.stringify(profileForPersist), newTags],
  );
  console.log(
    `[entity-card-io] updated id=${id} kind=${kind} name="${newDisplayName}"`,
  );
}

function diffProfileKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
  }
  return changed.sort();
}

// ── CLI ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      id: { type: 'string' },
      all: { type: 'boolean' },
      out: { type: 'string' },
      pgdata: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const outDir = resolve(values.out ?? './entity-cards');

  if (cmd === 'export-npc' || cmd === 'export-quest') {
    const kind = cmd === 'export-npc' ? 'person' : 'quest';
    const subdir = cmd === 'export-npc' ? 'npcs' : 'quests';
    const targetDir = join(outDir, subdir);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    let list: EntityRow[];
    if (values.all) {
      list = await loadAllByKind([kind]);
    } else {
      const id = Number(values.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`--id <positive int> or --all is required`);
      }
      const row = await loadEntity(id);
      if (!row) throw new Error(`No entity id=${id}`);
      if (row.kind !== kind) {
        throw new Error(
          `Entity id=${id} is kind="${row.kind}", expected "${kind}"`,
        );
      }
      list = [row];
    }

    for (const row of list) {
      const slug = slugify(row.display_name) || String(row.id);
      const filename = `${row.id}-${slug}.md`;
      const text =
        kind === 'person' ? await exportNpc(row) : await exportQuest(row);
      const fullPath = join(targetDir, filename);
      writeFileSync(fullPath, text, 'utf8');
      console.log(`[entity-card-io] wrote ${fullPath}`);
    }
    return;
  }

  if (cmd === 'import') {
    const file = positionals[0];
    if (!file) throw new Error('Usage: import <path/to/file.md> [--dry-run]');
    await importEntity(resolve(file), Boolean(values['dry-run']));
    return;
  }

  console.error(
    [
      'Usage:',
      '  entity-card-io export-npc   --id <id>  [--out <dir>] [--pgdata <pglite_dir>]',
      '  entity-card-io export-npc   --all      [--out <dir>] [--pgdata <pglite_dir>]',
      '  entity-card-io export-quest --id <id>  [--out <dir>] [--pgdata <pglite_dir>]',
      '  entity-card-io export-quest --all      [--out <dir>] [--pgdata <pglite_dir>]',
      '  entity-card-io import       <file.md>  [--dry-run]   [--pgdata <pglite_dir>]',
      '',
      '--pgdata: override the PGLite data directory. Use to point at the',
      '  desktop runtime DB, e.g. %APPDATA%/GreenHaven/pgdata. The GreenHaven',
      '  desktop app must be CLOSED when reading/writing that directory.',
    ].join('\n'),
  );
  process.exit(2);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      '[entity-card-io] ERROR:',
      err instanceof Error ? err.message : err,
    );
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
