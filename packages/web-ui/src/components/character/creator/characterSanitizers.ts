import type {Background, Physical, Stats} from '../wizardTypes';
import type {IdentityPlus} from './types';

const ABILITIES: Array<keyof Stats> = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

const POINT_BUY_COSTS: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

const POINT_BUY_BUDGET = 27;

interface CompletionHints {
  name?: unknown;
  description?: unknown;
  history?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function cleanInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (value == null || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const integer = Math.trunc(numeric);
  if (integer < min || integer > max) return undefined;
  return integer;
}

function pointBuySpend(stats: Stats): number {
  let total = 0;
  for (const score of Object.values(stats)) {
    const cost = POINT_BUY_COSTS[score];
    if (cost == null) return Infinity;
    total += cost;
  }
  return total;
}

function sourceText(hints?: CompletionHints, maxLength = 400): string | undefined {
  return (
    cleanText(hints?.description, maxLength) ??
    cleanText(hints?.history, maxLength) ??
    cleanText(hints?.name, maxLength)
  );
}

function requiredText(
  value: unknown,
  maxLength: number,
  fallback: string,
): string {
  return cleanText(value, maxLength) ?? fallback.slice(0, maxLength);
}

function deriveNotableSkills(hints?: CompletionHints): string[] {
  const source = sourceText(hints, 800);
  if (!source) return ['Greenhaven survival', 'improvisation', 'reading danger'];
  const fragments = source
    .split(/[.,;:!?()\[\]\n\r]+/u)
    .map(part => part.trim())
    .filter(part => part.length >= 4)
    .slice(0, 3);
  if (fragments.length > 0) return fragments.map(part => part.slice(0, 120));
  return [source.slice(0, 120)];
}

export function cleanIdentity(
  input: unknown,
  fallbackName?: unknown,
): IdentityPlus {
  const src = isRecord(input) ? input : {};
  const out: IdentityPlus = {};
  const name = cleanText(fallbackName, 120) ?? cleanText(src['name'], 120);
  const pronouns = cleanText(src['pronouns'], 40);
  const genderExpression = cleanText(src['gender_expression'], 120);
  const race = cleanText(src['race'], 60);
  const anatomy = cleanText(src['anatomy'], 400);
  const attractions = cleanText(src['attractions'], 200);
  const age = cleanInteger(src['age'], 18, 10000);

  if (name) out.name = name;
  if (pronouns) out.pronouns = pronouns;
  if (genderExpression) out.gender_expression = genderExpression;
  if (race) out.race = race;
  if (anatomy) out.anatomy = anatomy;
  if (attractions) out.attractions = attractions;
  if (age != null) out.age = age;
  return out;
}

export function completeIdentity(
  input: unknown,
  hints?: CompletionHints,
): Required<IdentityPlus> {
  const clean = cleanIdentity(input, hints?.name);
  const source = sourceText(hints, 400);
  return {
    name: requiredText(clean.name, 120, 'Unnamed Greenhaven traveler'),
    pronouns: requiredText(clean.pronouns, 40, 'player-defined pronouns'),
    gender_expression: requiredText(
      clean.gender_expression,
      120,
      'player-authored presentation',
    ),
    race: requiredText(clean.race, 60, 'custom Greenhaven ancestry'),
    anatomy: requiredText(
      clean.anatomy,
      400,
      source ?? 'body details drawn from the creator sheet',
    ),
    attractions: requiredText(
      clean.attractions,
      200,
      'private; defined by the player character',
    ),
    age: clean.age ?? 30,
  };
}

export function cleanPhysical(input: unknown): Physical {
  const src = isRecord(input) ? input : {};
  const out: Physical = {};
  const build = cleanText(src['build'], 200);
  const voice = cleanText(src['voice'], 200);
  const skin = cleanText(src['skin'], 200);
  const hair = cleanText(src['hair'], 200);
  const eyes = cleanText(src['eyes'], 200);
  const distinguishingMarks = cleanText(src['distinguishing_marks'], 400);

  if (build) out.build = build;
  if (voice) out.voice = voice;
  if (skin) out.skin = skin;
  if (hair) out.hair = hair;
  if (eyes) out.eyes = eyes;
  if (distinguishingMarks) out.distinguishing_marks = distinguishingMarks;
  return out;
}

export function completePhysical(
  input: unknown,
  hints?: CompletionHints,
): Required<Physical> {
  const clean = cleanPhysical(input);
  const source = sourceText(hints, 200);
  return {
    build: requiredText(clean.build, 200, source ?? 'build drawn from the creator sheet'),
    voice: requiredText(clean.voice, 200, source ?? 'voice drawn from the creator sheet'),
    skin: requiredText(clean.skin, 200, source ?? 'skin details drawn from the creator sheet'),
    hair: requiredText(clean.hair, 200, source ?? 'hair details drawn from the creator sheet'),
    eyes: requiredText(clean.eyes, 200, source ?? 'eye details drawn from the creator sheet'),
    distinguishing_marks: requiredText(
      clean.distinguishing_marks,
      400,
      source ?? 'distinguishing marks drawn from the creator sheet',
    ),
  };
}

export function cleanBackground(
  input: unknown,
  fallbackOrigin?: unknown,
): Background {
  const src = isRecord(input) ? input : {};
  const out: Background = {};
  const origin =
    cleanText(src['origin_paragraph'], 6000) ??
    cleanText(fallbackOrigin, 6000);
  const motivation = cleanText(src['motivation'], 200);
  const temperament = cleanText(src['temperament'], 160);

  const notable = Array.isArray(src['notable_skills'])
    ? Array.from(
        new Set(
          src['notable_skills']
            .map(item => cleanText(item, 120))
            .filter((item): item is string => item != null),
        ),
      ).slice(0, 10)
    : [];

  if (origin) out.origin_paragraph = origin;
  if (motivation) out.motivation = motivation;
  if (temperament) out.temperament = temperament;
  if (notable.length > 0) out.notable_skills = notable;
  return out;
}

export function completeBackground(
  input: unknown,
  hints?: CompletionHints,
): Required<Background> {
  const clean = cleanBackground(input, hints?.history ?? hints?.description);
  const source = sourceText(hints, 200);
  const notable =
    clean.notable_skills && clean.notable_skills.length > 0
      ? clean.notable_skills
      : deriveNotableSkills(hints);
  return {
    origin_paragraph: requiredText(
      clean.origin_paragraph,
      6000,
      cleanText(hints?.history, 6000) ??
        cleanText(hints?.description, 6000) ??
        'The character arrives in Greenhaven with a personal history to uncover in play.',
    ),
    motivation: requiredText(clean.motivation, 200, source ?? 'find a reason to survive Greenhaven'),
    temperament: requiredText(clean.temperament, 160, source ?? 'watchful, adaptable, hard to reduce to one mood'),
    notable_skills: notable.slice(0, 10),
  };
}

export function cleanStartingClassId(value: unknown): number | null {
  return cleanInteger(value, 600, 611) ?? null;
}

export function cleanStats(input: unknown): Stats | null {
  if (!isRecord(input)) return null;
  const next: Partial<Stats> = {};
  for (const ability of ABILITIES) {
    const score = cleanInteger(input[ability], 8, 15);
    if (score == null) return null;
    next[ability] = score;
  }
  const stats = next as Stats;
  if (pointBuySpend(stats) > POINT_BUY_BUDGET) return null;
  return stats;
}

export function cleanSkills(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map(item => cleanText(item, 40))
        .filter((item): item is string => item != null),
    ),
  ).slice(0, 10);
}

export function cleanRationaleMap(input: unknown): Record<string, string> | undefined {
  if (!isRecord(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const cleanKey = cleanText(key, 40);
    const cleanValue = cleanText(value, 500);
    if (cleanKey && cleanValue) out[cleanKey] = cleanValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
