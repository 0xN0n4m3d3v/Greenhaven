/**
 * Entity-section rendering helpers for buildTurnContext.
 */

import {query} from '../db.js';
import {stripEntityProfileAliases} from '../entities/profileSanitizer.js';
import {loc} from '../i18n.js';
import {getEntityRuntimeContext, type EntityRuntimeContext} from '../tools/runtimeContext.js';

export interface EntityRow {
  id: number;
  kind: string;
  display_name: string;
  summary: string | null;
  profile: Record<string, unknown> | null;
  tags: string[] | null;
  i18n?: Record<string, Record<string, unknown>> | null;
}

/**
 * Resolve a fetched entity's localizable fields into a single language.
 * Mutates the returned copy â€” leaves the input untouched. Profile keys
 * (narrator_brief, speech_style) are localized via the same i18n bag
 * since profile-key translations live there too.
 *
 * `display_name` is INTENTIONALLY left as the canonical English form even
 * for non-English players. Narrator @-mentions and the UI's affordance
 * matcher both key off the canonical name byte-for-byte; localizing it
 * here would force a per-language alias machinery in the UI. Localized
 * description text (summary, narrator_brief) gives the narrator enough
 * cultural anchoring; the canonical name in @-tags reads as a "stable
 * label" rather than a translation choice.
 */
export function localizeEntity(row: EntityRow, lang: string): EntityRow {
  if (!row.i18n || Object.keys(row.i18n).length === 0) return row;
  const summary = loc(row, lang, 'summary', row.summary);
  let profile = stripEntityProfileAliases(row.profile);
  if (profile) {
    let mutated: Record<string, unknown> | null = null;
    for (const key of Object.keys(profile)) {
      const localized = loc(row, lang, key, profile[key]);
      if (localized !== profile[key]) {
        mutated = mutated ?? {...profile};
        mutated[key] = localized;
      }
    }
    if (mutated) profile = mutated;
  }
  return {...row, summary, profile};
}

/**
 * Top-of-static-block summary of the cartridge world. Fetches the world
 * entity (kind='world') and renders display_name + summary +
 * narrator_brief + a compact list of profile facets (genre, tech_level,
 * tone, etc). Cartridge-agnostic: works for any cartridge that supplies
 * a kind='world' entity and points cartridge_meta.world_entity_id at it.
 */
export async function renderWorldSection(worldId: number, lang: string): Promise<string | null> {
  const entity = await fetchEntity(worldId, lang);
  if (!entity) return null;
  const profile = entity.profile ?? {};
  const facets: string[] = [];
  const facetOrder = [
    'genre',
    'tech_level',
    'magic',
    'species_origin',
    'recent_history',
    'tone',
    'currency',
    'ruling_power',
  ] as const;
  for (const key of facetOrder) {
    const v = profile[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      facets.push(`- **${key}**: ${v}`);
    }
  }
  const lines = [
    `## WORLD`,
    `**${entity.display_name}**${entity.summary ? ` â€” ${entity.summary}` : ''}`,
    typeof profile['narrator_brief'] === 'string'
      ? `> ${profile['narrator_brief']}`
      : null,
    facets.length > 0 ? facets.join('\n') : null,
  ].filter((s): s is string => Boolean(s && s.trim().length > 0));
  return lines.join('\n');
}

export async function fetchEntity(id: number, lang = 'en'): Promise<EntityRow | null> {
  const r = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, i18n
       FROM entities WHERE id = $1`,
    [id],
  );
  const row = r.rows[0];
  return row ? localizeEntity(row, lang) : null;
}

/**
 * Static portion of an entity section: the descriptive card without
 * runtime fields. Cartridge profile and summary are stable bytes that
 * don't shift when the player picks a lock or the NPC's mood flips.
 */
export async function renderEntitySectionStatic(
  label: string,
  entityId: number,
  lang = 'en',
): Promise<string> {
  const entity = await fetchEntity(entityId, lang);
  if (!entity) return '';
  return [
    `## ${label}`,
    `**${entity.display_name}** (id ${entity.id}, kind=${entity.kind})`,
    entity.summary ? `> ${entity.summary}` : null,
    renderProfile(entity.profile),
  ]
    .filter((s): s is string => Boolean(s && s.trim().length > 0))
    .join('\n');
}

/**
 * Dynamic portion of an entity section: just the runtime fields and
 * cartridge instructions â€” the parts that can flip turn-to-turn.
 * Returns empty when there's nothing to surface so the dynamic block
 * doesn't end up with bare `## SCENE (runtime)` headers.
 */
export async function renderEntityRuntime(
  label: string,
  entityId: number,
  playerId: number,
): Promise<string | null> {
  const ctx = await getEntityRuntimeContext(entityId, playerId);
  const rt = renderRuntime(ctx);
  const ins = renderInstructions(ctx);
  if (!rt && !ins) return null;
  const lines: string[] = [`## ${label} (runtime)`];
  if (rt) lines.push(rt);
  if (ins) lines.push(ins);
  return lines.join('\n');
}

export function renderCheck(profile: Record<string, unknown> | null): string {
  if (!profile) return '';
  const c = profile['check'];
  if (!c || typeof c !== 'object') return '';
  const obj = c as Record<string, unknown>;
  const ability = typeof obj['ability'] === 'string' ? obj['ability'] : '?';
  const dc = typeof obj['dc'] === 'number' ? obj['dc'] : '?';
  const action = typeof obj['action'] === 'string' ? obj['action'] : 'interact';
  const onS = typeof obj['on_success'] === 'string' ? obj['on_success'] : '';
  const onF = typeof obj['on_failure'] === 'string' ? obj['on_failure'] : '';
  let out = `\n      check: ${ability} DC ${dc} to "${action}"`;
  if (onS) out += `\n        on success â†’ ${onS}`;
  if (onF) out += `\n        on failure â†’ ${onF}`;
  return out;
}

export function renderSocialDcs(profile: Record<string, unknown> | null): string {
  if (!profile) return '';
  const s = profile['social_dcs'];
  if (!s || typeof s !== 'object') return '';
  const obj = s as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') continue;
    const vo = v as Record<string, unknown>;
    const a = typeof vo['ability'] === 'string' ? vo['ability'] : '?';
    const d = typeof vo['dc'] === 'number' ? vo['dc'] : '?';
    parts.push(`${k} (${a} DC ${d})`);
  }
  return parts.length > 0 ? `\n      social: ${parts.join(', ')}` : '';
}

export function renderProfile(profile: Record<string, unknown> | null): string | null {
  const cleanProfile = stripEntityProfileAliases(profile);
  if (Object.keys(cleanProfile).length === 0) return null;
  const lines: string[] = ['Profile:'];
  for (const [k, v] of Object.entries(cleanProfile)) {
    const value = typeof v === 'string' ? v : JSON.stringify(v);
    lines.push(`  - ${k}: ${value}`);
  }
  return lines.join('\n');
}

export function renderRuntime(ctx: EntityRuntimeContext): string | null {
  if (ctx.runtime_fields.length === 0) return null;
  const lines: string[] = [
    'Runtime fields (current values):',
    '  Use only listed field_id values with their shown type/allowed values; do not invent field ids or mutate fields not listed here.',
  ];
  for (const f of ctx.runtime_fields) {
    const scope = f.scope_per_player ? 'per-player' : 'global';
    const meta = [
      `id ${f.field_id}`,
      `type=${f.value_type}`,
      scope,
      `source=${f.source}`,
    ];
    const allowed = formatAllowedValues(f.allowed_values);
    if (allowed) meta.push(`allowed=${allowed}`);
    const description = compactRuntimeDescription(f.description);
    lines.push(
      `  - ${f.field_key} (${meta.join(', ')}) = ${compactJson(f.value)}${
        description ? ` - ${description}` : ''
      }`,
    );
  }
  return lines.join('\n');
}

function formatAllowedValues(values?: unknown[] | null): string | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  return compactJson(values, 120);
}

function compactRuntimeDescription(description?: string | null): string | null {
  if (!description) return null;
  const text = description.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= 96 ? text : `${text.slice(0, 93)}...`;
}

function compactJson(value: unknown, maxLength = 160): string {
  const raw = JSON.stringify(value);
  const text = raw === undefined ? String(value) : raw;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

export function renderInstructions(ctx: EntityRuntimeContext): string | null {
  if (ctx.instructions.length === 0) return null;
  const lines: string[] = ['Cartridge instructions (apply now â€” these are the rules):'];
  for (const i of ctx.instructions) {
    lines.push(`  â€¢ [priority ${i.priority}, id ${i.id}]\n${indent(i.text, '    ')}`);
  }
  return lines.join('\n');
}

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map(line => prefix + line)
    .join('\n');
}

/**
 * Spec 38 follow-up â€” WORLD CATALOGUE block (compact form).
 *
 * One line per kind, names comma-separated. NO summaries inline â€”
 * descriptions are fetched via `query_entity(name)` only when the
 * broker is actually about to USE the entity (in create_quest, narrate,
 * etc). This keeps the static preamble small (~400 chars total instead
 * of 8KB), maximises prefix-cache hits, and offloads detail fetch to
 * the on-demand tool path.
 *
 * Excludes: hidden_until_stage gated entities, the current location
 * (already fully rendered above as PEOPLE HERE / ITEMS HERE / EXITS),
 * players, classes, skills, factions, world entity.
 *
 * `[dyn]` tag marks runtime-spawned entities (create_entity / dynamic
 * quest spawn_entities) so the model can distinguish cartridge canon
 * from in-flight world.
 */
