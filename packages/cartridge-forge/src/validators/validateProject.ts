import {readFile} from 'node:fs/promises';
import Ajv2020Module from 'ajv/dist/2020.js';
import type {IngestRecord, LoadedProject, ValidationIssue} from '../core/types.js';
import {docsSchemaPath} from '../core/paths.js';

export async function validateProject(loaded: LoadedProject): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const schema = JSON.parse(await readFile(docsSchemaPath, 'utf8')) as object;
  const Ajv2020 = Ajv2020Module as unknown as new (options: {
    allErrors: boolean;
    strict: boolean;
  }) => {
    compile: (schema: object) => {
      (data: unknown): boolean;
      errors?: Array<{instancePath?: string; schemaPath: string; message?: string}>;
    };
  };
  const ajv = new Ajv2020({allErrors: true, strict: false});
  const validate = ajv.compile(schema);
  const sourceIds = new Set(loaded.sources.map(source => source.source_id));
  const slugs = new Set<string>();

  for (const record of loaded.records) {
    const file = `records/${record.kind}s.jsonl`;
    const ok = validate(record);
    if (!ok) {
      for (const err of validate.errors ?? []) {
        issues.push({
          level: 'error',
          file,
          field: err.instancePath || err.schemaPath,
          message: err.message ?? 'schema validation failed',
        });
      }
    }
    if (slugs.has(record.slug)) {
      issues.push({level: 'error', file, message: `duplicate slug: ${record.slug}`});
    }
    slugs.add(record.slug);

    for (const provenance of record.provenance ?? []) {
      if (!sourceIds.has(provenance.source_id)) {
        issues.push({
          level: 'error',
          file,
          field: 'provenance.source_id',
          message: `missing source record: ${provenance.source_id}`,
        });
      }
    }

    gameplayIssues(record, file, issues);
  }

  for (const record of loaded.records) {
    for (const link of record.links ?? []) {
      if (!slugs.has(link.target) && !link.target.startsWith('external:')) {
        issues.push({
          level: 'error',
          file: `records/${record.kind}s.jsonl`,
          field: 'links.target',
          message: `unresolved link target: ${link.target}`,
        });
      }
    }
  }

  return issues;
}

function gameplayIssues(record: IngestRecord, file: string, issues: ValidationIssue[]) {
  if (hasNumericDatabaseId(record.payload)) {
    issues.push({
      level: 'error',
      file,
      field: 'payload',
      message: 'payload contains numeric database id-like fields; use slugs only',
    });
  }
  if (record.kind === 'location') {
    requireStringArray(record, file, issues, 'exits');
    requirePayloadString(record, file, issues, 'narrator_brief');
    if (!record.payload['mood_axes']) {
      issues.push({level: 'error', file, field: 'payload.mood_axes', message: 'location needs mood_axes'});
    }
    const hooks = record.payload['default_hooks'];
    if (!Array.isArray(hooks) || hooks.length < 3) {
      issues.push({
        level: 'warning',
        file,
        field: 'payload.default_hooks',
        message: 'location should have at least three playable hooks',
      });
    }
  }
  if (record.kind === 'person') {
    if (!record.payload['home_slug'] && !record.payload['faction_slug']) {
      issues.push({
        level: 'error',
        file,
        field: 'payload.home_slug',
        message: 'NPC needs home_slug or faction_slug',
      });
    }
    if (!record.payload['speech_style'] && !record.payload['registers']) {
      issues.push({
        level: 'error',
        file,
        field: 'payload.speech_style',
        message: 'NPC needs speech_style or registers',
      });
    }
  }
  if (record.kind === 'quest') {
    requirePayloadString(record, file, issues, 'giver_slug');
    requirePayloadString(record, file, issues, 'start_location_slug');
    const stages = record.payload['stages'];
    if (!Array.isArray(stages) || stages.length === 0) {
      issues.push({level: 'error', file, field: 'payload.stages', message: 'quest needs stages'});
    }
    if (!record.payload['prepared_entity_slugs']) {
      issues.push({
        level: 'warning',
        file,
        field: 'payload.prepared_entity_slugs',
        message: 'quest should declare prepared supporting entities',
      });
    }
  }
  if (record.kind === 'scene') {
    requirePayloadString(record, file, issues, 'location_slug');
    requireStringArray(record, file, issues, 'participant_slugs', {
      allowEmpty: true,
    });
    if (!record.payload['state_fields']) {
      issues.push({
        level: 'warning',
        file,
        field: 'payload.state_fields',
        message: 'scene should declare state_fields',
      });
    }
  }
}

function requirePayloadString(
  record: IngestRecord,
  file: string,
  issues: ValidationIssue[],
  key: string,
) {
  if (typeof record.payload[key] !== 'string' || String(record.payload[key]).trim() === '') {
    issues.push({level: 'error', file, field: `payload.${key}`, message: `${record.kind} needs ${key}`});
  }
}

function requireStringArray(
  record: IngestRecord,
  file: string,
  issues: ValidationIssue[],
  key: string,
  opts: {allowEmpty?: boolean} = {},
) {
  if (
    !Array.isArray(record.payload[key]) ||
    (!opts.allowEmpty && (record.payload[key] as unknown[]).length === 0)
  ) {
    issues.push({level: 'error', file, field: `payload.${key}`, message: `${record.kind} needs ${key}`});
  }
}

function hasNumericDatabaseId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNumericDatabaseId);
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (
        /(^|_)id$/.test(key) &&
        typeof child === 'number' &&
        Number.isInteger(child) &&
        child > 0
      ) {
        return true;
      }
      if (hasNumericDatabaseId(child)) return true;
    }
  }
  return false;
}
