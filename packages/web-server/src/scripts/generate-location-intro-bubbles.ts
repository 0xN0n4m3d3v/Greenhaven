/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// One-shot authoring utility for location first-entry bubbles.
//
// Runtime rendering is intentionally deterministic and DB-backed. This script
// is the controlled AI authoring pass that fills that DB table once, with
// validation around language, length, and canonical @tags.

import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText, type LanguageModel } from 'ai';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  activeCartridgeEntityPredicate,
  activeCartridgeId,
} from '../cartridgeScope.js';
import { config } from '../config.js';
import { closeDb, query } from '../db.js';
import { loadVisibleReachableLocations } from '../locationGraph.js';
import {
  localizeEntity,
  type EntityRow,
} from '../turnContext/entitySections.js';

const SOURCE = 'ai_deepseek_location_intro_v1';
const REPLACEABLE_SOURCES = new Set([
  'seeded_from_location_i18n',
  'generated_location_first_entry_v1',
  'runtime_fallback',
  SOURCE,
]);

const SUPPORTED_LANGS = [
  'en',
  'ru',
  'uk',
  'bg',
  'sr',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'ro',
  'he',
  'ar',
  'fa',
  'ur',
  'hi',
  'mr',
  'ne',
  'bn',
  'th',
  'el',
  'hy',
  'ka',
  'ko',
  'ja',
  'zh',
] as const;

type SupportedLang = (typeof SUPPORTED_LANGS)[number];

const LANGUAGE_NAMES: Record<SupportedLang, string> = {
  en: 'English',
  ru: 'Russian',
  uk: 'Ukrainian',
  bg: 'Bulgarian',
  sr: 'Serbian Cyrillic',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ro: 'Romanian',
  he: 'Hebrew',
  ar: 'Arabic',
  fa: 'Persian',
  ur: 'Urdu',
  hi: 'Hindi',
  mr: 'Marathi',
  ne: 'Nepali',
  bn: 'Bengali',
  th: 'Thai',
  el: 'Greek',
  hy: 'Armenian',
  ka: 'Georgian',
  ko: 'Korean',
  ja: 'Japanese',
  zh: 'Chinese',
};

const SCRIPT_CHECKS: Partial<Record<SupportedLang, RegExp>> = {
  ru: /[\u0400-\u04FF]/g,
  uk: /[\u0400-\u04FF]/g,
  bg: /[\u0400-\u04FF]/g,
  sr: /[\u0400-\u04FF]/g,
  he: /[\u0590-\u05FF]/g,
  ar: /[\u0600-\u06FF]/g,
  fa: /[\u0600-\u06FF]/g,
  ur: /[\u0600-\u06FF]/g,
  hi: /[\u0900-\u097F]/g,
  mr: /[\u0900-\u097F]/g,
  ne: /[\u0900-\u097F]/g,
  bn: /[\u0980-\u09FF]/g,
  th: /[\u0E00-\u0E7F]/g,
  el: /[\u0370-\u03FF]/g,
  hy: /[\u0530-\u058F]/g,
  ka: /[\u10A0-\u10FF]/g,
  ko: /[\uAC00-\uD7AF]/g,
  ja: /[\u3040-\u30FF\u3400-\u9FFF]/g,
  zh: /[\u3400-\u9FFF]/g,
};

const SCRIPT_NOTES: Partial<Record<SupportedLang, string>> = {
  ru: 'Use Cyrillic script.',
  uk: 'Use Cyrillic script.',
  bg: 'Use Cyrillic script.',
  sr: 'Use Serbian Cyrillic script, not Latin transliteration.',
  he: 'Use Hebrew script.',
  ar: 'Use Arabic script.',
  fa: 'Use Persian Arabic script.',
  ur: 'Use Urdu Arabic script.',
  hi: 'Use Devanagari script.',
  mr: 'Use Devanagari script.',
  ne: 'Use Devanagari script.',
  bn: 'Use Bengali script.',
  th: 'Use Thai script.',
  el: 'Use Greek script.',
  hy: 'Use Armenian script.',
  ka: 'Use Georgian script.',
  ko: 'Use Hangul.',
  ja: 'Use Japanese kana/kanji.',
  zh: 'Use Chinese characters.',
};

interface CliOptions {
  all: boolean;
  dryRun: boolean;
  locationId?: number;
  locationName?: string;
  langs: SupportedLang[];
  limit?: number;
  migrate: boolean;
  modelId: string;
  outSql?: string;
  overwriteAuthored: boolean;
  retries: number;
}

interface LocationContext {
  location: EntityRow;
  powerCenterId: number | null;
  nearbyPeople: EntityRow[];
  visibleItems: EntityRow[];
  exits: EntityRow[];
  hooks: EntityRow[];
  allowedTags: string[];
}

interface IntroResult {
  locationId: number;
  locationName: string;
  lang: SupportedLang;
  bubbleText: string;
  written: boolean;
  skippedReason?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    all: false,
    dryRun: true,
    langs: ['en', 'ru'],
    migrate: false,
    modelId: config().locationIntroModel,
    overwriteAuthored: false,
    retries: 3,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case '--all':
        opts.all = true;
        break;
      case '--write':
        opts.dryRun = false;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--migrate':
        opts.migrate = true;
        break;
      case '--overwrite-authored':
        opts.overwriteAuthored = true;
        break;
      case '--location-id':
        opts.locationId = parsePositiveInt(requireValue(arg, next));
        i += 1;
        break;
      case '--location-name':
        opts.locationName = requireValue(arg, next);
        i += 1;
        break;
      case '--langs':
        opts.langs = parseLangs(requireValue(arg, next));
        i += 1;
        break;
      case '--limit':
        opts.limit = parsePositiveInt(requireValue(arg, next));
        i += 1;
        break;
      case '--model':
        opts.modelId = requireValue(arg, next);
        i += 1;
        break;
      case '--out-sql':
        opts.outSql = requireValue(arg, next);
        i += 1;
        break;
      case '--retries':
        opts.retries = parsePositiveInt(requireValue(arg, next));
        i += 1;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.all && opts.locationId == null && !opts.locationName) {
    throw new Error(
      'Select targets with --location-id, --location-name, or --all.',
    );
  }
  return opts;
}

function requireValue(arg: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} needs a value`);
  }
  return value;
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got: ${value}`);
  }
  return parsed;
}

function parseLangs(value: string): SupportedLang[] {
  if (value === 'all') return [...SUPPORTED_LANGS];
  const requested = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set<string>(SUPPORTED_LANGS);
  const invalid = requested.filter((lang) => !allowed.has(lang));
  if (invalid.length > 0) {
    throw new Error(`Unsupported language(s): ${invalid.join(', ')}`);
  }
  return requested as SupportedLang[];
}

function printHelp(): void {
  console.log(`Generate Greenhaven first-entry location bubbles with DeepSeek.

Usage:
  npm run location:intros:generate -- --location-id 201019 --langs ru,en
  npm run location:intros:generate -- --location-name "Ale & Eats" --langs all --write
  npm run location:intros:generate -- --all --langs all --write --limit 10

Flags:
  --write                 Write validated bubbles to location_intro_bubbles.
  --dry-run               Print validated bubbles only. Default.
  --migrate               Run migrations before loading targets.
  --overwrite-authored    Permit overwriting non-generated rows.
  --model <id>            DeepSeek model id. Default: deepseek-chat.
  --out-sql <path>        Write a SQL patch containing generated bubbles.
  --retries <n>           Validation retries per bubble. Default: 3.
`);
}

function pickModel(modelId: string): LanguageModel {
  const apiKey = config().deepseekApiKey;
  if (!apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY is required for location intro generation.',
    );
  }
  return createDeepSeek({ apiKey })(modelId);
}

async function loadTargets(opts: CliOptions): Promise<EntityRow[]> {
  const cartridgeId = await activeCartridgeId();
  const params: unknown[] = [cartridgeId];
  const where = [
    `kind IN ('location', 'district')`,
    `(profile->>'hidden_until_stage') IS NULL`,
    activeCartridgeEntityPredicate('entities', '$1'),
  ];

  if (opts.locationId != null) {
    params.push(opts.locationId);
    where.push(`id = $${params.length}::bigint`);
  }
  if (opts.locationName) {
    params.push(opts.locationName);
    where.push(`display_name ILIKE $${params.length}`);
  }

  const limitSql = opts.limit != null ? `LIMIT ${opts.limit}` : '';
  const rows = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, i18n
       FROM entities
      WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN id = 201019 THEN 0 ELSE 1 END, id
      ${limitSql}`,
    params,
  );
  return rows.rows;
}

async function loadLocationContext(
  location: EntityRow,
  lang: SupportedLang,
): Promise<LocationContext> {
  const cartridgeId = await activeCartridgeId();
  const localizedLocation = localizeEntity(location, lang);
  const profile = localizedLocation.profile ?? {};
  const powerCenterId = readPositiveId(profile['power_center_id']);
  const scopeIds =
    powerCenterId != null && powerCenterId !== location.id
      ? [location.id, powerCenterId]
      : [location.id];
  const scopeText = scopeIds.map(String);

  const people = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, i18n
       FROM entities
      WHERE kind = 'person'
        AND (profile->>'hidden_until_stage') IS NULL
        AND ${activeCartridgeEntityPredicate('entities', '$2')}
        AND (
          profile->>'home_id' = ANY($1::text[])
          OR profile->>'location_id' = ANY($1::text[])
          OR profile->>'current_location_id' = ANY($1::text[])
          OR profile->>'power_center_id' = ANY($1::text[])
        )
      ORDER BY CASE
                 WHEN profile->>'location_id' = $3 THEN 0
                 WHEN profile->>'home_id' = $3 THEN 1
                 ELSE 2
               END,
               id
      LIMIT 12`,
    [scopeText, cartridgeId, String(location.id)],
  );

  const itemRows = await query<EntityRow>(
    `SELECT DISTINCT e.id, e.kind, e.display_name, e.summary, e.profile, e.tags, e.i18n
       FROM entities e
       LEFT JOIN inventory_entries i ON i.item_entity_id = e.id
      WHERE e.kind = 'item'
        AND (e.profile->>'hidden_until_stage') IS NULL
        AND ${activeCartridgeEntityPredicate('e', '$2')}
        AND (
          i.holder_entity_id = ANY($1::bigint[])
          OR e.profile->>'holder_entity_id' = ANY($3::text[])
          OR e.profile->>'home_id' = ANY($3::text[])
          OR e.profile->>'location_id' = ANY($3::text[])
        )
      ORDER BY e.id
      LIMIT 10`,
    [scopeIds, cartridgeId, scopeText],
  );

  const exits = (await loadVisibleReachableLocations(location.id)).map((row) =>
    localizeEntity(row, lang),
  );

  const hooks = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, i18n
       FROM entities
      WHERE kind IN ('scene', 'event', 'activity', 'quest')
        AND (profile->>'hidden_until_stage') IS NULL
        AND ${activeCartridgeEntityPredicate('entities', '$2')}
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
      LIMIT 16`,
    [scopeText, cartridgeId],
  );

  const nearbyPeople = people.rows.map((row) => localizeEntity(row, lang));
  const visibleItems = itemRows.rows.map((row) => localizeEntity(row, lang));
  const localHooks = hooks.rows.map((row) => localizeEntity(row, lang));
  const allowedTags = unique([
    localizedLocation.display_name,
    ...nearbyPeople.map((row) => row.display_name),
    ...visibleItems.map((row) => row.display_name),
    ...exits.map((row) => row.display_name),
    ...localHooks.slice(0, 8).map((row) => row.display_name),
  ]);

  return {
    location: localizedLocation,
    powerCenterId,
    nearbyPeople,
    visibleItems,
    exits,
    hooks: localHooks,
    allowedTags,
  };
}

async function generateBubble(
  model: LanguageModel,
  ctx: LocationContext,
  lang: SupportedLang,
  retries: number,
): Promise<string> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const prompt = buildPrompt(ctx, lang, failures);
    const r = await generateText({
      model,
      system: buildSystemPrompt(lang),
      messages: [{ role: 'user', content: prompt }],
      temperature: attempt === 1 ? 0.45 : 0.25,
      maxOutputTokens: 900,
    });

    const json = safeJsonExtract(r.text);
    const bubbleText = sanitizeAtTags(readBubbleText(json), ctx.allowedTags);
    const validation = validateBubble(bubbleText, ctx, lang);
    if (validation.ok) return bubbleText;
    failures.push(
      `Attempt ${attempt} failed: ${validation.errors.join('; ')}. Raw start: ${r.text.slice(0, 220)}`,
    );
  }
  throw new Error(
    `Failed to generate valid ${lang} intro for ${ctx.location.display_name}: ${failures.join(' | ')}`,
  );
}

function buildSystemPrompt(lang: SupportedLang): string {
  return [
    'You are the Greenhaven cartridge location-intro authoring tool.',
    'Write one high-quality first-entry bubble for an RPG location.',
    `Language: ${LANGUAGE_NAMES[lang]} (${lang}).`,
    SCRIPT_NOTES[lang] ? `Script requirement: ${SCRIPT_NOTES[lang]}` : '',
    'Return JSON only, exactly: {"bubble_text":"..."}',
    'Do not use markdown, lists, tables, code fences, or commentary.',
    'Do not invent people, places, objects, secrets, quests, deaths, or outcomes not present in the supplied context.',
    'Use canonical proper names and @tags unchanged; never translate a token after @.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPrompt(
  ctx: LocationContext,
  lang: SupportedLang,
  previousFailures: string[],
): string {
  const loc = ctx.location;
  const profile = summarizeProfile(loc.profile);
  const facts = {
    target_language: `${LANGUAGE_NAMES[lang]} (${lang})`,
    location: compactEntity(loc),
    profile,
    nearby_people: ctx.nearbyPeople.slice(0, 8).map(compactEntity),
    visible_items: ctx.visibleItems.slice(0, 6).map(compactEntity),
    exits: ctx.exits.slice(0, 8).map(compactEntity),
    local_hooks: ctx.hooks.slice(0, 8).map(compactEntity),
    allowed_at_tags: ctx.allowedTags.map((name) => `@${name}`),
  };

  return [
    'Write the first-entry bubble from this grounded world context.',
    '',
    'Hard rules:',
    `- bubble_text MUST begin exactly with: @${loc.display_name} — `,
    '- Use the requested target language for all prose. Keep canonical proper names and every @tag unchanged.',
    SCRIPT_NOTES[lang] ? `- ${SCRIPT_NOTES[lang]}` : '',
    `- Length: 2-4 sentences, ${minBubbleChars(lang)}-900 characters.`,
    '- It must orient a first-time player: atmosphere + what can be noticed + one or two plausible next actions.',
    '- @tags are strict affordance tags. Use only names from allowed_at_tags.',
    '- Maximum 4 @tags total, including the location tag.',
    '- Do not tag generic nouns. Do not tag possessives. Do not create new names.',
    '- Avoid mechanics labels like "First entry", "Mode", "Quest", "NPC", "roll".',
    '- Do not copy long local_hooks titles verbatim; translate them into natural world-facing details.',
    lang !== 'en'
      ? '- Do not paste English source titles such as "The Pigeonhole Wall", "Reviewers\' Bulletin", "Full Weekly Expansion", or "Idle Register". Translate the idea into natural prose.'
      : '',
    '- Avoid direct instruction spam. The text should feel like world prose, not a tutorial.',
    '- Output JSON only.',
    '',
    'Grounded context JSON:',
    JSON.stringify(facts, null, 2),
    previousFailures.length > 0
      ? `\nPrevious validation failures to correct:\n${previousFailures.join('\n')}`
      : '',
  ].join('\n');
}

function compactEntity(row: EntityRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    name: row.display_name,
    summary: trimText(row.summary, 420),
    tags: row.tags?.slice(0, 8) ?? [],
    profile: summarizeProfile(row.profile),
  };
}

function summarizeProfile(
  profile: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!profile) return {};
  const keys = [
    'source_category',
    'source_slug',
    'power_center_role',
    'location_id',
    'home_id',
    'power_center_id',
    'topology_parent_id',
    'district',
    'archetype',
    'role',
    'service',
    'cadence',
    'heat',
    'observable_by_mc',
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = profile[key];
    if (value == null) continue;
    if (typeof value === 'string') out[key] = trimText(value, 180);
    else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function safeJsonExtract(text: string): unknown {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  if (!s.startsWith('{')) {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first < 0 || last < first) return null;
    s = s.slice(first, last + 1);
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function readBubbleText(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const text = (json as Record<string, unknown>)['bubble_text'];
  return typeof text === 'string' ? normalizeBubble(text) : '';
}

function normalizeBubble(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function validateBubble(
  text: string,
  ctx: LocationContext,
  lang: SupportedLang,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const locName = ctx.location.display_name;
  if (!text.startsWith(`@${locName} — `)) {
    errors.push(`must start with "@${locName} — "`);
  }
  const minChars = minBubbleChars(lang);
  if (text.length < minChars) {
    errors.push(`too short (${text.length} chars; min ${minChars})`);
  }
  if (text.length > 900) errors.push(`too long (${text.length} chars)`);
  if (/```|^\s*[-*]\s|\|/m.test(text)) {
    errors.push('must not contain markdown/list/table formatting');
  }
  if (/\b(first entry|mode|quest|npc|roll|dice)\b/i.test(text)) {
    errors.push('must not expose mechanics labels');
  }
  const leakedHook = ctx.hooks.find(
    (hook) => hook.display_name.length > 34 && text.includes(hook.display_name),
  );
  if (leakedHook) {
    errors.push(`must not leak full hook title: ${leakedHook.display_name}`);
  }
  if (lang !== 'en' && hasEnglishSourceTitleLeak(text)) {
    errors.push(
      'must not leak English source/hook titles into localized prose',
    );
  }

  const script = SCRIPT_CHECKS[lang];
  if (script) {
    const count = (text.match(script) ?? []).length;
    if (count < 24) {
      errors.push(
        `target language script is weak for ${lang}: ${count} matching chars`,
      );
    }
  }

  const tags = collectAtTags(text, ctx.allowedTags);
  if (tags.length === 0 || tags[0] !== locName) {
    errors.push('first @tag must be the location name');
  }
  if (tags.length > 4) {
    errors.push(`too many @tags (${tags.length}); max 4`);
  }
  const lastTag = tags[tags.length - 1];
  if (lastTag && text.trim().endsWith(`@${lastTag}`)) {
    errors.push(`must not end with dangling @tag @${lastTag}`);
  }
  const allowed = new Set(ctx.allowedTags);
  const unknown = tags.filter((tag) => !allowed.has(tag));
  if (unknown.length > 0) {
    errors.push(
      `unknown @tag(s): ${unknown.map((tag) => `@${tag}`).join(', ')}`,
    );
  }

  return { ok: errors.length === 0, errors };
}

function hasEnglishSourceTitleLeak(text: string): boolean {
  return [
    /\bThe Pigeonhole Wall\b/u,
    /\bReviewers' Bulletin\b/u,
    /\bFull Weekly Expansion\b/u,
    /\bIdle Register\b/u,
    /\bliving-world\b/iu,
    /\bgossip-hub\b/iu,
    /\bheat\s+\d\b/iu,
    /\badventure\b/iu,
  ].some((re) => re.test(text));
}

function minBubbleChars(lang: SupportedLang): number {
  switch (lang) {
    case 'zh':
    case 'ja':
    case 'ko':
    case 'th':
    case 'he':
    case 'ar':
    case 'fa':
    case 'ur':
    case 'hi':
    case 'mr':
    case 'ne':
    case 'bn':
    case 'hy':
    case 'ka':
      return 140;
    default:
      return 220;
  }
}

function sanitizeAtTags(text: string, allowedTags: string[]): string {
  if (!text.includes('@')) return text;
  const allowedByLength = [...allowedTags].sort((a, b) => b.length - a.length);
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') {
      out += text[i];
      continue;
    }
    const rest = text.slice(i + 1);
    const known = allowedByLength.find(
      (name) => rest.startsWith(name) && isTagBoundary(rest[name.length]),
    );
    if (known) {
      out += `@${known}`;
      i += known.length;
    }
    // Unknown @marker: drop only the @ so prose remains, but no bogus
    // affordance reaches the UI matcher.
  }
  return normalizeBubble(out);
}

function collectAtTags(text: string, allowedTags: string[]): string[] {
  const tags: string[] = [];
  const allowedByLength = [...allowedTags].sort((a, b) => b.length - a.length);
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '@') continue;
    const rest = text.slice(i + 1);
    const known = allowedByLength.find(
      (name) => rest.startsWith(name) && isTagBoundary(rest[name.length]),
    );
    if (known) {
      tags.push(known);
      i += known.length;
      continue;
    }
    const unknown = rest
      .split(/[\n\r—.,;:!?()[\]{}<>"]/u, 1)[0]
      ?.replace(/\s+/g, ' ')
      .trim();
    if (unknown) tags.push(unknown);
  }
  return tags;
}

function isTagBoundary(char: string | undefined): boolean {
  return (
    char == null ||
    /\s/u.test(char) ||
    char === '—' ||
    char === '-' ||
    char === ',' ||
    char === '.' ||
    char === ';' ||
    char === ':' ||
    char === '!' ||
    char === '?' ||
    char === ')' ||
    char === '(' ||
    char === "'" ||
    char === '’'
  );
}

async function writeBubble(
  locationId: number,
  lang: SupportedLang,
  bubbleText: string,
  opts: CliOptions,
): Promise<{ written: boolean; skippedReason?: string }> {
  if (opts.dryRun) return { written: false, skippedReason: 'dry-run' };

  const existing = await query<{ source: string }>(
    `SELECT source
       FROM location_intro_bubbles
      WHERE location_entity_id = $1 AND lang = $2`,
    [locationId, lang],
  );
  const source = existing.rows[0]?.source;
  if (source && !opts.overwriteAuthored && !REPLACEABLE_SOURCES.has(source)) {
    return { written: false, skippedReason: `protected source=${source}` };
  }

  await query(
    `INSERT INTO location_intro_bubbles
       (location_entity_id, lang, bubble_text, source, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (location_entity_id, lang)
     DO UPDATE SET
       bubble_text = EXCLUDED.bubble_text,
       source = EXCLUDED.source,
       updated_at = now()`,
    [locationId, lang, bubbleText, SOURCE],
  );
  return { written: true };
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.migrate) {
    const { runMigrations } = await import('../migrate.js');
    await runMigrations();
  }

  const model = pickModel(opts.modelId);
  const targets = await loadTargets(opts);
  if (targets.length === 0) {
    throw new Error('No matching locations found.');
  }

  const total = targets.length * opts.langs.length;
  console.error(
    `[location-intros] targets=${targets.length} langs=${opts.langs.join(',')} total=${total} mode=${opts.dryRun ? 'dry-run' : 'write'} model=${opts.modelId}`,
  );

  const results: IntroResult[] = [];
  let done = 0;
  for (const location of targets) {
    for (const lang of opts.langs) {
      done += 1;
      const ctx = await loadLocationContext(location, lang);
      console.error(
        `[location-intros] ${done}/${total} ${location.id} ${location.display_name} ${lang}`,
      );
      const bubbleText = await generateBubble(model, ctx, lang, opts.retries);
      const writeResult = await writeBubble(
        location.id,
        lang,
        bubbleText,
        opts,
      );
      results.push({
        locationId: location.id,
        locationName: location.display_name,
        lang,
        bubbleText,
        ...writeResult,
      });
    }
  }

  if (opts.outSql) {
    await writeSqlPatch(opts.outSql, results);
    console.error(`[location-intros] wrote SQL patch ${opts.outSql}`);
  }

  console.log(JSON.stringify({ source: SOURCE, results }, null, 2));
}

async function writeSqlPatch(
  filePath: string,
  results: IntroResult[],
): Promise<void> {
  const rows = results.filter((row) => row.bubbleText.trim().length > 0);
  if (rows.length === 0) return;
  const resolvedPath = resolveOutputPath(filePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  const values = rows
    .map(
      (row) =>
        `  (${row.locationId}, ${sqlString(row.lang)}, ${sqlString(row.bubbleText)}, ${sqlString(SOURCE)}, now())`,
    )
    .join(',\n');
  const sql = [
    '-- AI-authored first-entry bubbles generated by generate-location-intro-bubbles.ts.',
    '-- Source rows are validated for canonical @tags and target-language script before emission.',
    '',
    'INSERT INTO location_intro_bubbles',
    '  (location_entity_id, lang, bubble_text, source, updated_at)',
    'VALUES',
    values,
    'ON CONFLICT (location_entity_id, lang) DO UPDATE SET',
    '  bubble_text = EXCLUDED.bubble_text,',
    '  source = EXCLUDED.source,',
    '  updated_at = now();',
    '',
  ].join('\n');
  await writeFile(resolvedPath, sql, 'utf8');
}

function resolveOutputPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const nestedPrefix = 'packages/web-server/';
  if (
    path.basename(process.cwd()) === 'web-server' &&
    normalized.startsWith(nestedPrefix)
  ) {
    return path.resolve(process.cwd(), normalized.slice(nestedPrefix.length));
  }
  return path.resolve(filePath);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function trimText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function readPositiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

try {
  await run();
} catch (err) {
  console.error(
    `[location-intros] failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
}
