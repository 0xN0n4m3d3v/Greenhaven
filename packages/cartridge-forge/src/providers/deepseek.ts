import type {IngestRecord, LoadedProject} from '../core/types.js';

interface DeepSeekResponse {
  choices?: Array<{
    message?: {content?: string};
    finish_reason?: string;
  }>;
}

export async function deepseekFillRecord(
  loaded: LoadedProject,
  record: IngestRecord,
): Promise<IngestRecord> {
  const apiKey = process.env[loaded.project.provider.api_key_env];
  if (!apiKey) throw new Error(`${loaded.project.provider.api_key_env} not set`);
  const prompt = buildPrompt(record);
  const response = await fetch(`${loaded.project.provider.base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: loaded.project.provider.model,
      response_format: {type: 'json_object'},
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content:
            'You are Cartridge Forge. Output valid json only. Do not copy web prose, do not invent database ids, use slugs only, and preserve Greenhaven playable state.',
        },
        {role: 'user', content: prompt},
      ],
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${text}`);
  const parsed = JSON.parse(text) as DeepSeekResponse;
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned empty content');
  const patch = JSON.parse(content) as Partial<IngestRecord>;
  return {
    ...record,
    ...patch,
    payload: {
      ...record.payload,
      ...(patch.payload ?? {}),
    },
    quality: {
      ...record.quality,
      ...(patch.quality ?? {}),
      review_status: 'agent_reviewed',
    },
  };
}

function buildPrompt(record: IngestRecord): string {
  return `Fill missing fields for this Greenhaven cartridge ingest record.

Return json matching this shape:
{
  "summary": "short improved summary",
  "tags": ["kind", "playable-tag"],
  "payload": {},
  "quality": {"playable": true, "risk_flags": []}
}

Rules:
- Keep record_id, kind, slug, operation, source_language, canonical_name.
- Do not add numeric database ids.
- Use slugs for references.
- Every location needs exits, narrator_brief, mood_axes, default_hooks.
- Every person needs home_slug or faction_slug, speech_style/registers, playable reason to talk.
- Every quest needs giver_slug, start_location_slug, objective, stages, prepared_entity_slugs.
- Every scene needs location_slug, participant_slugs, state_fields or clear reason.
- Make the content original Greenhaven fiction.

Current record json:
${JSON.stringify(record, null, 2)}
`;
}

