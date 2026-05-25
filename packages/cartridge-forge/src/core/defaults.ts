import type {EntityKind, IngestRecord} from './types.js';

export function defaultPayload(kind: EntityKind, slug: string): Record<string, unknown> {
  if (kind === 'location') {
    return {
      location_kind: 'room',
      parent_slug: null,
      power_center_role: 'hub',
      exits: [slug],
      narrator_brief:
        'Playable Forge draft location. Replace with specific sensory and action hooks.',
      mood_axes: {warmth: 1, danger: 0, intimacy: 0, pressure: 1},
      default_hooks: [`${slug}-rumor`, `${slug}-object`, `${slug}-visitor`],
    };
  }
  if (kind === 'person') {
    return {
      species: 'human',
      pronouns: 'they/them',
      home_slug: `${slug}-home`,
      archetype: 'forge-draft-npc',
      speech_style: 'clear, specific, grounded in the current scene',
      registers: [
        {
          register_id: 'default',
          trigger: 'mc-starts-conversation',
          sample_line: 'Say what you need, and say it plainly.',
        },
      ],
    };
  }
  if (kind === 'quest') {
    return {
      quest_type: 'investigation',
      giver_slug: `${slug}-giver`,
      start_location_slug: `${slug}-start`,
      objective: 'Replace with a concrete playable objective.',
      prepared_entity_slugs: [],
      stages: [
        {
          stage_slug: 'take-brief',
          goal: 'Accept the brief.',
          location_slug: 'ale-eats',
        },
      ],
    };
  }
  if (kind === 'scene') {
    return {
      location_slug: `${slug}-location`,
      participant_slugs: [],
      entry: true,
      state_fields: [],
      model_instructions: ['Surface one playable hook within two narrator turns.'],
    };
  }
  if (kind === 'item') {
    return {
      item_kind: 'quest_hook',
      holder_slug: null,
      location_slug: `${slug}-location`,
      use_contract: 'Replace with concrete interaction and state change.',
    };
  }
  if (kind === 'event') {
    return {
      event_type: 'local',
      location_slug: `${slug}-location`,
      trigger_conditions: ['player enters the relevant location'],
      participants: [],
      state_changes: [],
    };
  }
  return {};
}

export function defaultPayloadForProject(
  kind: EntityKind,
  slug: string,
  records: IngestRecord[],
): Record<string, unknown> {
  const payload = defaultPayload(kind, slug);
  const firstLocation = records.find(record => record.kind === 'location')?.slug;
  const firstPerson = records.find(record => record.kind === 'person')?.slug;

  if (kind === 'location' && firstLocation && firstLocation !== slug) {
    return {...payload, parent_slug: firstLocation, exits: [firstLocation]};
  }
  if (kind === 'person' && firstLocation) {
    return {...payload, home_slug: firstLocation};
  }
  if (kind === 'quest') {
    return {
      ...payload,
      giver_slug: firstPerson ?? `${slug}-giver`,
      start_location_slug: firstLocation ?? `${slug}-start`,
      prepared_entity_slugs: [firstPerson, firstLocation].filter(Boolean),
    };
  }
  if ((kind === 'scene' || kind === 'item' || kind === 'event') && firstLocation) {
    return {...payload, location_slug: firstLocation};
  }
  return payload;
}

export function draftRecord(input: {
  kind: IngestRecord['kind'];
  slug: string;
  name: string;
  summary: string;
  tags?: string[];
  payload?: Record<string, unknown>;
  sourceLanguage?: string;
}): IngestRecord {
  return {
    schema_version: 'greenhaven.cartridge_ingest_record.v1',
    record_id: `ghc:${input.kind}:${input.slug}`,
    kind: input.kind,
    slug: input.slug,
    operation: 'append',
    source_language: input.sourceLanguage ?? 'en',
    canonical_name: input.name,
    summary: input.summary,
    tags: input.tags ?? [input.kind, 'forge-draft'],
    payload: input.payload ?? defaultPayload(input.kind, input.slug),
    links: [],
    provenance: [
      {
        source_id: 'src:greenhaven:internal',
        use: 'original',
        note: 'Original Greenhaven cartridge authoring.',
      },
    ],
    quality: {
      review_status: 'draft',
      playable: true,
      density_role: 'none',
      risk_flags: [],
    },
  };
}
