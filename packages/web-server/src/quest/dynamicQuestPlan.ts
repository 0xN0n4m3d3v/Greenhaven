/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 138: advisory plan overlay for dynamic/adventure quests only.
// This never replaces cartridge-authored quest stages.

export type DynamicQuestPlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'skipped'
  | 'blocked';

export interface DynamicQuestPlanStep {
  id: string;
  description: string;
  status: DynamicQuestPlanStepStatus;
  successSignal: string;
  evidenceToolInvocationIds: number[];
  memoryIds: number[];
  updatedAt: string;
}

export interface DynamicQuestPlanOverlay {
  steps: DynamicQuestPlanStep[];
  updatedAt: string;
}

export interface DynamicQuestPlanValidation {
  ok: boolean;
  errors: string[];
  plan?: DynamicQuestPlanOverlay;
}

const STATUSES = new Set<DynamicQuestPlanStepStatus>([
  'pending',
  'in_progress',
  'done',
  'skipped',
  'blocked',
]);

const MIN_STEPS = 3;
const MAX_STEPS = 7;
const MAX_TEXT = 240;
const MAX_MEMORY_IDS = 8;
const MAX_TOOL_IDS = 12;

export interface DynamicQuestProfileSignals {
  /** ARCH-19 normalized `entities.dynamic_origin` column. When the
   *  caller selects from a DB row, pass that value; the function
   *  short-circuits to `true` when set so the upcoming Phase 4 drop
   *  of `profile.origin` cannot silently demote a runtime-created
   *  quest to "authored". Optional — `isDynamicQuestProfile` keeps
   *  its existing tag / source / runtime_created checks for
   *  incoming tool payloads where the column is not yet populated. */
  dynamicOriginColumn?: boolean | null;
}

export function isDynamicQuestProfile(
  profile: Record<string, unknown>,
  tags: readonly string[] = [],
  signals: DynamicQuestProfileSignals = {},
): boolean {
  // ARCH-19 pre-Phase-4 hardening — the normalized column wins when
  // the caller selected it from a DB row. The legacy
  // `profile.origin` JSONB reads stay as a fallback so incoming
  // tool payloads (no DB row yet) and adventure metadata
  // (`origin: 'adventure'` may appear in flight) still resolve.
  if (signals.dynamicOriginColumn === true) return true;
  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  const origin = stringField(profile['origin']).toLowerCase();
  const source = stringField(profile['source']).toLowerCase();
  return (
    normalizedTags.includes('dynamic') ||
    normalizedTags.includes('adventure') ||
    origin === 'dynamic' ||
    origin === 'adventure' ||
    source === 'adventure_queue' ||
    profile['runtime_created'] === true
  );
}

export function validateDynamicQuestPlan(
  value: unknown,
): DynamicQuestPlanValidation {
  const errors: string[] = [];
  if (!isObject(value)) {
    return {ok: false, errors: ['quest_plan must be an object']};
  }
  const rawSteps = Array.isArray(value['steps']) ? value['steps'] : [];
  if (rawSteps.length < MIN_STEPS) {
    errors.push(`quest_plan must have at least ${MIN_STEPS} steps`);
  }
  if (rawSteps.length > MAX_STEPS) {
    errors.push(`quest_plan must have at most ${MAX_STEPS} steps`);
  }

  const steps: DynamicQuestPlanStep[] = [];
  let inProgress = 0;
  rawSteps.slice(0, MAX_STEPS).forEach((raw, index) => {
    if (!isObject(raw)) {
      errors.push(`steps[${index}] must be an object`);
      return;
    }
    const description = stringField(raw['description']).slice(0, MAX_TEXT);
    const successSignal = stringField(
      raw['successSignal'] ?? raw['success_signal'],
    ).slice(0, MAX_TEXT);
    const status = parseStatus(raw['status']);
    if (!description) errors.push(`steps[${index}].description is required`);
    if (
      status !== 'done' &&
      status !== 'skipped' &&
      status !== 'blocked' &&
      !successSignal
    ) {
      errors.push(`steps[${index}].successSignal is required`);
    }
    if (status === 'in_progress') inProgress++;
    steps.push({
      id:
        stringField(raw['id']).slice(0, 80) ||
        `step_${String(index + 1).padStart(2, '0')}`,
      description,
      status,
      successSignal,
      evidenceToolInvocationIds: numberList(
        raw['evidenceToolInvocationIds'] ?? raw['evidence_tool_invocation_ids'],
        MAX_TOOL_IDS,
      ),
      memoryIds: numberList(raw['memoryIds'] ?? raw['memory_ids'], MAX_MEMORY_IDS),
      updatedAt:
        stringField(raw['updatedAt'] ?? raw['updated_at']) ||
        new Date(0).toISOString(),
    });
  });

  const unfinished = steps.some(
    (step) => step.status !== 'done' && step.status !== 'skipped',
  );
  if (unfinished && inProgress !== 1) {
    errors.push('unfinished quest_plan must have exactly one in_progress step');
  }
  return {
    ok: errors.length === 0,
    errors,
    plan: {
      steps,
      updatedAt:
        stringField(value['updatedAt'] ?? value['updated_at']) ||
        new Date(0).toISOString(),
    },
  };
}

export function readDynamicQuestPlan(
  accumulatedState: unknown,
): DynamicQuestPlanValidation {
  if (!isObject(accumulatedState) || accumulatedState['quest_plan'] == null) {
    return {ok: false, errors: ['quest_plan is absent']};
  }
  return validateDynamicQuestPlan(accumulatedState['quest_plan']);
}

function parseStatus(value: unknown): DynamicQuestPlanStepStatus {
  const candidate = stringField(value) as DynamicQuestPlanStepStatus;
  return STATUSES.has(candidate) ? candidate : 'pending';
}

function numberList(value: unknown, max: number): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0)
    .slice(0, max);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

