import type {IngestRecord, LoadedProject} from './types.js';
import {makeRecord} from './projectStore.js';

export function draftQuestFromAnchor(
  loaded: LoadedProject,
  anchor: IngestRecord,
): IngestRecord {
  const slug = nextQuestSlug(loaded.records, `${anchor.slug}-quest`);
  const startLocation = inferStartLocation(loaded.records, anchor);
  const giver = inferQuestGiver(loaded.records, anchor);
  const prepared = uniqueStrings([anchor.slug, startLocation, giver]);
  const sourceKey = sourcePayloadKey(anchor.kind);

  return makeRecord({
    kind: 'quest',
    slug,
    name: `${anchor.canonical_name} Quest`,
    summary: `Playable quest scaffold anchored by ${anchor.canonical_name}.`,
    tags: ['quest', 'forge-generated', anchor.kind],
    sourceLanguage: loaded.project.source_language,
    payload: {
      quest_type: 'forge_generated',
      anchor_kind: anchor.kind,
      anchor_slug: anchor.slug,
      giver_slug: giver,
      start_location_slug: startLocation,
      objective: `Turn ${anchor.canonical_name} into a concrete playable objective.`,
      prepared_entity_slugs: prepared,
      [sourceKey]: anchor.slug,
      stages: [
        {
          stage_slug: 'brief',
          goal: 'Establish what is wanted, who cares, and what can go wrong.',
          location_slug: startLocation,
        },
        {
          stage_slug: 'pressure',
          goal: 'Force a meaningful choice or complication around the anchor.',
          location_slug: startLocation,
        },
        {
          stage_slug: 'resolution',
          goal: 'Return consequence, reward, relationship shift, or new hook.',
          location_slug: startLocation,
        },
      ],
      gm_notes: [
        'Do not wait for the player to ask for details after accepting.',
        'Surface a clue, cost, or social complication within the first follow-up turn.',
      ],
    },
  });
}

export function linkGeneratedQuest(anchor: IngestRecord, quest: IngestRecord): IngestRecord {
  const links = anchor.links ?? [];
  if (links.some(link => link.rel === 'generated_quest' && link.target === quest.slug)) {
    return anchor;
  }
  return {
    ...anchor,
    links: [...links, {rel: 'generated_quest', target: quest.slug}],
  };
}

function nextQuestSlug(records: IngestRecord[], base: string): string {
  const used = new Set(records.map(record => record.slug));
  if (!used.has(base)) return base;
  for (let idx = 2; idx < 1000; idx += 1) {
    const candidate = `${base}-${idx}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate quest slug for ${base}`);
}

function inferStartLocation(records: IngestRecord[], anchor: IngestRecord): string {
  const direct = firstString(
    anchor.payload.start_location_slug,
    anchor.payload.location_slug,
    anchor.payload.home_slug,
    anchor.payload.scene_slug,
  );
  if (direct) return direct;

  const holder = findBySlug(records, anchor.payload.holder_slug);
  const holderLocation = holder
    ? firstString(holder.payload.home_slug, holder.payload.location_slug, holder.payload.scene_slug)
    : null;
  if (holderLocation) return holderLocation;

  const firstLocation = records.find(record => record.kind === 'location');
  return firstLocation?.slug ?? 'forge-start-location';
}

function inferQuestGiver(records: IngestRecord[], anchor: IngestRecord): string {
  if (anchor.kind === 'person') return anchor.slug;

  const holder = findBySlug(records, anchor.payload.holder_slug);
  if (holder?.kind === 'person') return holder.slug;

  const participant = firstArrayString(anchor.payload.participant_slugs, anchor.payload.participants);
  const participantRecord = participant ? findBySlug(records, participant) : null;
  if (participantRecord?.kind === 'person') return participantRecord.slug;

  const firstPerson = records.find(record => record.kind === 'person');
  return firstPerson?.slug ?? anchor.slug;
}

function sourcePayloadKey(kind: IngestRecord['kind']): string {
  if (kind === 'item') return 'source_item_slug';
  if (kind === 'scene') return 'source_scene_slug';
  if (kind === 'event') return 'source_event_slug';
  return 'source_entity_slug';
}

function findBySlug(records: IngestRecord[], value: unknown): IngestRecord | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return records.find(record => record.slug === value) ?? null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function firstArrayString(...values: unknown[]): string | null {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const found = value.find(item => typeof item === 'string' && item.trim().length > 0);
    if (typeof found === 'string') return found;
  }
  return null;
}

function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  ];
}
