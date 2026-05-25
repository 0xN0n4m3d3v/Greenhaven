export {};

import fs from 'node:fs/promises';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

interface Args {
  runDir: string;
  outputPrefix: string;
}

interface RunSummary {
  playerId?: number;
  sessionId?: string;
  scenarios?: StepSummary[];
}

interface StepSummary {
  slug: string;
  title?: string;
  turnId: string | null;
  status: string | null;
  ok: boolean;
  axis?: string;
  expectedOutcome?: string | null;
  toolNames?: string[];
  guardrailSignals?: string[];
  issues?: Array<{severity: 'P0' | 'P1' | 'P2'; message: string}>;
  outDir?: string;
}

interface Diagnosis {
  slug: string;
  title: string;
  severity: 'P0' | 'P1' | 'P2' | 'INFO';
  owner:
    | 'backend-runtime'
    | 'backend-prompt'
    | 'backend-tool-contract'
    | 'backend-content'
    | 'frontend-handoff'
    | 'infrastructure'
    | 'model-provider'
    | 'manual-review';
  rootCause:
    | 'turn_runtime_timeout'
    | 'queue_recovery_gap'
    | 'prompt_guardrail_balance'
    | 'broker_tool_contract_gap'
    | 'tool_exposure_or_prompt_gap'
    | 'localization_or_encoding'
    | 'gm_agency_quality_gap'
    | 'prompt_context_budget'
    | 'post_turn_latency_budget'
    | 'content_state_gap'
    | 'provider_or_db_infrastructure'
    | 'needs_manual_read';
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  fixPath: string[];
  rerun: string[];
}

const BROKER_MUTATION_TOOLS = new Set([
  'add_memory',
  'advance_quest',
  'apply_intimacy_trigger',
  'apply_runtime_field_patch',
  'apply_surface',
  'award_inspiration',
  'award_xp',
  'batch_mutate_world',
  'change_stat',
  'complete_quest',
  'create_entity',
  'create_quest',
  'damage',
  'death_save',
  'equip_item',
  'give_to_npc',
  'heal',
  'inventory_transfer',
  'mark_downed',
  'move_player',
  'narrate',
  'remove',
  'set_companion',
  'set_runtime_field',
  'spend_inspiration',
  'stabilize',
  'start_quest',
  'string_award',
  'string_spend',
  'switch_dialogue_partner',
  'unlock_skill',
  'update_entity',
  'use_item',
]);

const BROKER_INPUT_TOKEN_BUDGET = 30_000;
const USER_CONTEXT_CHAR_BUDGET = 24_000;
const FOCUSED_SYSTEM_CHAR_BUDGET = 16_000;
const FOCUSED_TOOL_SCHEMA_CHAR_BUDGET = 12_000;

const args = parseArgs(process.argv.slice(2));
const summary = await readJson<RunSummary>(path.join(args.runDir, 'SUMMARY.json'));
const scenarios = summary.scenarios ?? [];
if (scenarios.length === 0) {
  throw new Error(`no scenarios in ${path.join(args.runDir, 'SUMMARY.json')}`);
}

const diagnoses: Diagnosis[] = [];
for (const scenario of scenarios) {
  diagnoses.push(...(await diagnoseScenario(args, scenario)));
}

await writeJson(path.join(args.runDir, `${args.outputPrefix}.json`), {
  runDir: args.runDir,
  playerId: summary.playerId ?? null,
  sessionId: summary.sessionId ?? null,
  generatedAt: new Date().toISOString(),
  diagnoses,
});
await fs.writeFile(
  path.join(args.runDir, `${args.outputPrefix}.md`),
  renderRootCauseReport(args, summary, diagnoses),
  'utf8',
);
await fs.writeFile(
  path.join(args.runDir, 'FIX_QUEUE.md'),
  renderFixQueue(args, summary, diagnoses),
  'utf8',
);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      runDir: args.runDir,
      scenarios: scenarios.length,
      diagnoses: diagnoses.length,
      p0: diagnoses.filter(d => d.severity === 'P0').length,
      p1: diagnoses.filter(d => d.severity === 'P1').length,
    },
    null,
    2,
  )}\n`,
);

async function diagnoseScenario(
  args: Args,
  scenario: StepSummary,
): Promise<Diagnosis[]> {
  const stepDir = resolveStepDir(args.runDir, scenario);
  const settled = await readJsonOptional<JsonRecord>(
    path.join(stepDir, '06-turn-settled.json'),
  );
  const after = await readJsonOptional<JsonRecord>(
    path.join(stepDir, '07-after-turn.json'),
  );
  const cancel = await readJsonOptional<JsonRecord>(
    path.join(stepDir, '06b-timeout-cancel.json'),
  );

  const rows = turnTelemetryRows(after, scenario.turnId);
  const tools = scenario.toolNames ?? toolRows(after, scenario.turnId);
  const assistant = assistantTexts(after, scenario.turnId).join('\n\n');
  const scenarioIssues = scenario.issues ?? [];
  const diagnoses: Diagnosis[] = [];

  const timeout =
    scenario.status === 'timeout' ||
    settled?.['status'] === 'timeout' ||
    scenarioIssues.some(issue => /timeout|did not settle/i.test(issue.message));
  if (timeout) {
    diagnoses.push({
      slug: scenario.slug,
      title: titleOf(scenario),
      severity: 'P0',
      owner: 'backend-runtime',
      rootCause: 'turn_runtime_timeout',
      confidence: 'high',
      evidence: compact([
        `turn=${scenario.turnId ?? 'unknown'} status=${scenario.status ?? 'unknown'}`,
        `settled=${stringifySmall(settled)}`,
        cancel ? `cancel=${stringifySmall(cancel)}` : null,
        longestTelemetry(rows),
        `step=${stepDir}`,
      ]),
      fixPath: [
        'Inspect the longest LLM/provider span and input token count.',
        'Reduce prompt/context if broker input is excessive.',
        'Keep GREENHAVEN_TURN_WATCHDOG_MS enabled and verify cancel frees queue.',
        'Rerun only this scenario before resuming the full marathon.',
      ],
      rerun: rerunCommand(args.runDir, scenario),
    });
  }

  for (const issue of scenarioIssues) {
    if (/unfinished queue row/i.test(issue.message)) {
      diagnoses.push({
        slug: scenario.slug,
        title: titleOf(scenario),
        severity: issue.severity,
        owner: 'backend-runtime',
        rootCause: 'queue_recovery_gap',
        confidence: 'high',
        evidence: [`issue=${issue.message}`, `step=${stepDir}`],
        fixPath: [
          'Check turn_ingress_queue status transitions for the turn.',
          'Verify cancel/timeout marks running rows failed or cancelled.',
          'Verify no queued turn is blocked behind a dead visible_after_turn_id.',
        ],
        rerun: rerunCommand(args.runDir, scenario),
      });
    }
    if (/state-changing player intent was answered with narration only/i.test(issue.message)) {
      diagnoses.push({
        slug: scenario.slug,
        title: titleOf(scenario),
        severity: issue.severity,
        owner: 'backend-tool-contract',
        rootCause: 'broker_tool_contract_gap',
        confidence: 'high',
        evidence: [
          `issue=${issue.message}`,
          `tools=${tools.join(', ') || 'none'}`,
          textPreview(assistant),
          `step=${stepDir}`,
        ],
        fixPath: [
          'Find the exact missing durable write: movement, item, quest, memory, combat, or runtime field.',
          'Check whether the relevant tool was exposed in the selected broker mode.',
          'Patch broker prompt/tool contract so prose cannot substitute for the write.',
          'Add this scenario to the rerun set after the fix.',
        ],
        rerun: rerunCommand(args.runDir, scenario),
      });
    }
    if (
      /none of expected tools were used|required tools? (?:group )?missing|required runtime fields missing/i.test(
        issue.message,
      )
    ) {
      diagnoses.push({
        slug: scenario.slug,
        title: titleOf(scenario),
        severity: issue.severity,
        owner: /required tools? (?:group )?missing|required runtime fields missing/i.test(
          issue.message,
        )
          ? 'backend-tool-contract'
          : 'backend-prompt',
        rootCause: /required tools? (?:group )?missing|required runtime fields missing/i.test(
          issue.message,
        )
          ? 'broker_tool_contract_gap'
          : 'tool_exposure_or_prompt_gap',
        confidence: /required tools? (?:group )?missing|required runtime fields missing/i.test(
          issue.message,
        )
          ? 'high'
          : 'medium',
        evidence: [
          `issue=${issue.message}`,
          `tools=${tools.join(', ') || 'none'}`,
          `axis=${scenario.axis ?? 'unknown'} expected=${scenario.expectedOutcome ?? 'unknown'}`,
          `step=${stepDir}`,
        ],
        fixPath: [
          'Inspect selected tier/mode and tools offered to the broker.',
          'If the tool is unavailable, fix toolset routing.',
          'If the tool is available but unused, patch mode prompt examples and constraints.',
        ],
        rerun: rerunCommand(args.runDir, scenario),
      });
    }
    if (/required state changes missing/i.test(issue.message)) {
      diagnoses.push({
        slug: scenario.slug,
        title: titleOf(scenario),
        severity: issue.severity,
        owner: 'backend-tool-contract',
        rootCause: 'broker_tool_contract_gap',
        confidence: 'high',
        evidence: [
          `issue=${issue.message}`,
          `tools=${tools.join(', ') || 'none'}`,
          `axis=${scenario.axis ?? 'unknown'} expected=${scenario.expectedOutcome ?? 'unknown'}`,
          `step=${stepDir}`,
        ],
        fixPath: [
          'Compare 04-after-setup.json and 07-after-turn.json for the named durable domain.',
          'Find whether the broker skipped the required write or the tool wrote the wrong table.',
          'Patch the toolset/prompt/tool contract so narration cannot substitute for durable state.',
        ],
        rerun: rerunCommand(args.runDir, scenario),
      });
    }
    if (/mojibake|English-heavy/i.test(issue.message)) {
      diagnoses.push({
        slug: scenario.slug,
        title: titleOf(scenario),
        severity: issue.severity,
        owner: 'backend-content',
        rootCause: 'localization_or_encoding',
        confidence: 'medium',
        evidence: [
          `issue=${issue.message}`,
          textPreview(assistant),
          `step=${stepDir}`,
        ],
        fixPath: [
          'Verify whether mojibake is persisted DB text or only PowerShell display.',
          'Check source scenario strings, localization directive, and response language.',
          'Add a strict i18n regression if persisted content is corrupted.',
        ],
        rerun: rerunCommand(args.runDir, scenario),
      });
    }
    if (/playable next move|living-world reactivity/i.test(issue.message)) {
      diagnoses.push({
        slug: scenario.slug,
        title: titleOf(scenario),
        severity: issue.severity,
        owner: 'backend-prompt',
        rootCause: 'gm_agency_quality_gap',
        confidence: 'medium',
        evidence: [
          `issue=${issue.message}`,
          `signals=${(scenario.guardrailSignals ?? []).join(', ') || 'none'}`,
          `axis=${scenario.axis ?? 'unknown'} expected=${scenario.expectedOutcome ?? 'unknown'}`,
          `tools=${tools.join(', ') || 'none'}`,
          textPreview(assistant),
          `step=${stepDir}`,
        ],
        fixPath: [
          'Patch broker/narrator prompts so every non-terminal turn creates a living-world next move.',
          'Preserve durable truth: add options, consequences, pressure, or NPC reactions without inventing canon facts.',
          'Rerun this scenario and one adjacent gm_freedom scenario.',
        ],
        rerun: rerunCommand(args.runDir, scenario),
      });
    }
  }

  const guardrailSignals = scenario.guardrailSignals ?? [];
  const guardrailOnly = guardrailSignals.filter(signal => !signal.startsWith('gm_'));
  if (guardrailOnly.length > 0) {
    diagnoses.push({
      slug: scenario.slug,
      title: titleOf(scenario),
      severity: 'P1',
      owner: 'backend-prompt',
      rootCause: 'prompt_guardrail_balance',
      confidence: 'medium',
      evidence: [
        `signals=${guardrailOnly.join(', ')}`,
        `axis=${scenario.axis ?? 'unknown'} expected=${scenario.expectedOutcome ?? 'unknown'}`,
        textPreview(assistant),
        `step=${stepDir}`,
      ],
      fixPath: [
        'Identify which guard/prompt produced the refusal or mechanics-only answer.',
        'Patch it to require Yes/Yes-and/Roll/No-but/Clarify outcomes.',
        'Keep durable truth requirements; do not remove state checks wholesale.',
      ],
      rerun: rerunCommand(args.runDir, scenario),
    });
  }

  const budget = promptContextBudgetDiagnosis(args, scenario, stepDir, rows, after);
  if (budget) diagnoses.push(budget);

  const slow = latencyDiagnosis(args, scenario, stepDir, rows, after);
  if (slow && !(budget && slow.rootCause === 'prompt_context_budget')) {
    diagnoses.push(slow);
  }

  if (diagnoses.length === 0 && scenario.ok !== true) {
    diagnoses.push({
      slug: scenario.slug,
      title: titleOf(scenario),
      severity: 'P2',
      owner: 'manual-review',
      rootCause: 'needs_manual_read',
      confidence: 'low',
      evidence: [
        `status=${scenario.status ?? 'unknown'} ok=${scenario.ok}`,
        `issues=${scenarioIssues.map(i => i.message).join('; ') || 'none'}`,
        `step=${stepDir}`,
      ],
      fixPath: [
        'Open 07-after-turn.json and BUG_LEDGER.md.',
        'Classify owner before editing code.',
      ],
      rerun: rerunCommand(args.runDir, scenario),
    });
  }

  return diagnoses;
}

function promptContextBudgetDiagnosis(
  args: Args,
  scenario: StepSummary,
  stepDir: string,
  rows: JsonRecord[],
  state: JsonRecord | null,
): Diagnosis | null {
  const broker = rows.find(row => row['role'] === 'broker');
  const brokerInputTokens = numberValue(broker?.['input_tokens']);
  const promptBudget = promptBudgetEvent(state, scenario.turnId);
  const metadata = asRecord(promptBudget?.['metadata']);
  const userContextChars = numberValue(metadata['user_message_chars']);
  const effectiveSystemChars = numberValue(
    metadata['broker_effective_system_chars'],
  );
  const toolEstimatedChars = numberValue(metadata['tool_estimated_chars']);
  const brokerToolNames = scenario.toolNames ?? toolRows(state, scenario.turnId);
  const overBudget =
    brokerInputTokens >= BROKER_INPUT_TOKEN_BUDGET ||
    userContextChars >= USER_CONTEXT_CHAR_BUDGET;
  if (!overBudget) return null;
  const boundedPromptWithToolLoop =
    brokerInputTokens >= BROKER_INPUT_TOKEN_BUDGET &&
    userContextChars > 0 &&
    userContextChars < USER_CONTEXT_CHAR_BUDGET &&
    effectiveSystemChars > 0 &&
    effectiveSystemChars <= FOCUSED_SYSTEM_CHAR_BUDGET &&
    toolEstimatedChars > 0 &&
    toolEstimatedChars <= FOCUSED_TOOL_SCHEMA_CHAR_BUDGET &&
    brokerToolNames.length >= 4;
  return {
    slug: scenario.slug,
    title: titleOf(scenario),
    severity: boundedPromptWithToolLoop ? 'INFO' : 'P2',
    owner: 'backend-runtime',
    rootCause: 'prompt_context_budget',
    confidence: promptBudget ? 'high' : 'medium',
    evidence: compact([
      `broker_input_tokens=${brokerInputTokens}`,
      `broker_input_budget=${BROKER_INPUT_TOKEN_BUDGET}`,
      `prompt_budget_effective_system_chars=${effectiveSystemChars}`,
      `prompt_budget_user_chars=${userContextChars}`,
      `prompt_budget_user_budget=${USER_CONTEXT_CHAR_BUDGET}`,
      `prompt_budget_tool_estimated_chars=${toolEstimatedChars}`,
      boundedPromptWithToolLoop
        ? 'classification=bounded_prompt_tool_loop_variance'
        : null,
      `broker_tool_calls=${brokerToolNames.length}`,
      `broker_read_tool_calls=${brokerReadToolCount(brokerToolNames)}`,
      ...largestContextSectionEvidence(promptBudget),
      longestTelemetry(rows),
      `step=${stepDir}`,
    ]),
    fixPath: [
      ...(boundedPromptWithToolLoop
        ? [
            'Prompt sections are within focused-profile limits; keep this as cost telemetry, not a gameplay bug.',
            'If the same scenario crosses latency or repeats unnecessary read tools, reduce tool-loop turns rather than trimming world evidence.',
          ]
        : [
            'Inspect the largest turn_context_*_chars section in turn.prompt_budget telemetry.',
            'Trim the specific irrelevant section or route the scenario to a narrower broker profile.',
            'If prompt chars are bounded but provider tokens spike, inspect repeated read-tool loops.',
            'Rerun the same scenario and compare broker input tokens, prompt chars, and tool-call count.',
          ]),
    ],
    rerun: rerunCommand(args.runDir, scenario),
  };
}

function latencyDiagnosis(
  args: Args,
  scenario: StepSummary,
  stepDir: string,
  rows: JsonRecord[],
  state: JsonRecord | null,
): Diagnosis | null {
  const broker = rows.find(row => row['role'] === 'broker');
  const materializer = rows.find(row => row['role'] === 'agent:adventure_materializer');
  const brokerMs = numberValue(broker?.['duration_ms']);
  const materializerMs = numberValue(materializer?.['duration_ms']);
  const brokerInputTokens = numberValue(broker?.['input_tokens']);
  const promptBudget = promptBudgetEvent(state, scenario.turnId);
  const brokerToolNames = scenario.toolNames ?? toolRows(state, scenario.turnId);
  const maxMs = Math.max(brokerMs, materializerMs);
  if (maxMs < 15_000) return null;

  const rootCause =
    brokerInputTokens >= BROKER_INPUT_TOKEN_BUDGET
      ? 'prompt_context_budget'
      : materializerMs >= 15_000 && materializerMs >= brokerMs
      ? 'post_turn_latency_budget'
      : 'provider_or_db_infrastructure';
  const materializerSlot = performanceEvent(
    state,
    scenario.turnId,
    'post_turn.adventure_materializer',
  );
  const materializerSlotMetadata = asRecord(materializerSlot?.['metadata']);
  const materializerBarrierMode = String(
    materializerSlotMetadata['barrier_mode'] ?? '',
  );
  const materializerSlotStatus = String(
    materializerSlotMetadata['slot_status'] ?? '',
  );
  const nonBlockingMaterializer =
    rootCause === 'post_turn_latency_budget' &&
    materializerBarrierMode === 'non_blocking' &&
    (materializerSlot?.['status'] === 'ok' ||
      materializerSlotStatus === 'skipped' ||
      materializerSlotStatus === 'emitted');
  return {
    slug: scenario.slug,
    title: titleOf(scenario),
    severity:
      nonBlockingMaterializer
        ? 'INFO'
        : rootCause === 'prompt_context_budget'
        ? 'P2'
        : 'INFO',
    owner:
      rootCause === 'prompt_context_budget'
        ? 'backend-runtime'
        : rootCause === 'post_turn_latency_budget'
        ? 'backend-runtime'
        : 'model-provider',
    rootCause,
    confidence: 'medium',
    evidence: compact([
      `broker_ms=${brokerMs}`,
      `broker_input_tokens=${brokerInputTokens}`,
      `broker_tool_calls=${brokerToolNames.length}`,
      `broker_read_tool_calls=${brokerReadToolCount(brokerToolNames)}`,
      ...promptBudgetEvidence(promptBudget),
      `adventure_materializer_ms=${materializerMs}`,
      materializerBarrierMode
        ? `adventure_materializer_barrier=${materializerBarrierMode}`
        : null,
      materializerSlotStatus
        ? `adventure_materializer_slot_status=${materializerSlotStatus}`
        : null,
      nonBlockingMaterializer
        ? 'classification=non_blocking_post_turn_slot'
        : null,
      longestTelemetry(rows),
      `step=${stepDir}`,
    ]),
    fixPath:
      rootCause === 'prompt_context_budget'
        ? [
            'Inspect turn.prompt_budget telemetry for system, context, and tool budget.',
            'Reduce irrelevant turn_context sections, broad toolsets, or repeated read-tool loops.',
            'Rerun the same scenario and compare broker input tokens and latency.',
          ]
        : rootCause === 'post_turn_latency_budget'
        ? nonBlockingMaterializer
          ? [
              'Keep this as cost telemetry; the materializer slot is non-blocking and did not fail the visible turn.',
              'If this repeats with slot_status=failed/expired, inspect adventure materializer input and fallback.',
            ]
          : [
              'Move first-minute/advice turns away from expensive post-turn hooks when no hook is needed.',
              'Budget adventure materializer separately from visible turn completion.',
              'Rerun first-minute and new-player scenarios after tuning.',
            ]
        : [
            'Inspect provider latency and input token count.',
            'Reduce context or provider round trips before changing gameplay prompts.',
          ],
    rerun: rerunCommand(args.runDir, scenario),
  };
}

function promptBudgetEvent(
  state: JsonRecord | null,
  turnId: string | null,
): JsonRecord | null {
  if (!state || !turnId) return null;
  const live = asRecord(state['live']);
  const rows = Array.isArray(live['performance_events'])
    ? live['performance_events']
    : [];
  return (
    rows
      .filter(isRecord)
      .find(row => row['turn_id'] === turnId && row['phase'] === 'turn.prompt_budget') ??
    null
  );
}

function performanceEvent(
  state: JsonRecord | null,
  turnId: string | null,
  phase: string,
): JsonRecord | null {
  if (!state || !turnId) return null;
  const live = asRecord(state['live']);
  const rows = Array.isArray(live['performance_events'])
    ? live['performance_events']
    : [];
  return (
    rows
      .filter(isRecord)
      .find(row => row['turn_id'] === turnId && row['phase'] === phase) ??
    null
  );
}

function promptBudgetEvidence(row: JsonRecord | null): string[] {
  if (!row) return [];
  const metadata = asRecord(row['metadata']);
  return [
    `prompt_budget_system_chars=${numberValue(metadata['broker_system_chars'])}`,
    `prompt_budget_stage_override_chars=${numberValue(metadata['broker_stage_override_chars'])}`,
    `prompt_budget_effective_system_chars=${numberValue(metadata['broker_effective_system_chars'])}`,
    `prompt_budget_user_chars=${numberValue(metadata['user_message_chars'])}`,
    `prompt_budget_tool_count=${numberValue(metadata['tool_count'])}`,
    `prompt_budget_tool_description_chars=${numberValue(metadata['tool_description_chars'])}`,
    `prompt_budget_tool_schema_chars=${numberValue(metadata['tool_schema_chars'])}`,
    `prompt_budget_tool_estimated_chars=${numberValue(metadata['tool_estimated_chars'])}`,
    ...largestContextSectionEvidence(row),
  ];
}

function largestContextSectionEvidence(row: JsonRecord | null): string[] {
  if (!row) return [];
  const metadata = asRecord(row['metadata']);
  return Object.entries(metadata)
    .filter(([key, value]) =>
      key.startsWith('turn_context_') &&
      key.endsWith('_chars') &&
      numberValue(value) > 0,
    )
    .map(([key, value]) => ({key, chars: numberValue(value)}))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5)
    .map(row => `prompt_budget_largest_section.${row.key}=${row.chars}`);
}

function brokerReadToolCount(toolNames: string[]): number {
  return toolNames.filter(name => !BROKER_MUTATION_TOOLS.has(name)).length;
}

function turnTelemetryRows(
  state: JsonRecord | null,
  turnId: string | null,
): JsonRecord[] {
  if (!state || !turnId) return [];
  const live = asRecord(state['live']);
  const rows = Array.isArray(live['turn_telemetry'])
    ? live['turn_telemetry']
    : [];
  return rows
    .filter(isRecord)
    .filter(row => row['turn_id'] === turnId);
}

function toolRows(state: JsonRecord | null, turnId: string | null): string[] {
  if (!state || !turnId) return [];
  return baseRows(state, 'tool_invocations')
    .filter(row => {
      const rowTurn = String(row['turn_id'] ?? '');
      return rowTurn === turnId || rowTurn.startsWith(`${turnId}:`);
    })
    .map(row => String(row['tool_name'] ?? 'unknown'));
}

function assistantTexts(state: JsonRecord | null, turnId: string | null): string[] {
  if (!state || !turnId) return [];
  return baseRows(state, 'chat_messages')
    .filter(row => {
      if (row['tone'] === 'player') return false;
      const payload = asRecord(row['payload']);
      const rowTurn = String(payload['turn_id'] ?? row['turn_id'] ?? '');
      return rowTurn === turnId || rowTurn.startsWith(`${turnId}:`);
    })
    .map(row => (typeof row['text'] === 'string' ? row['text'] : ''))
    .filter(Boolean);
}

function baseRows(state: JsonRecord, key: string): JsonRecord[] {
  const base = asRecord(state['baseSnapshot']);
  const data = asRecord(base['data']);
  const rows = Array.isArray(data[key]) ? data[key] : [];
  return rows.filter(isRecord);
}

function longestTelemetry(rows: JsonRecord[]): string {
  const sorted = [...rows].sort(
    (a, b) => numberValue(b['duration_ms']) - numberValue(a['duration_ms']),
  );
  const row = sorted[0];
  if (!row) return 'telemetry=none';
  return [
    `longest=${String(row['role'] ?? 'unknown')}`,
    `model=${String(row['model_id'] ?? 'unknown')}`,
    `duration_ms=${numberValue(row['duration_ms'])}`,
    `input_tokens=${numberValue(row['input_tokens'])}`,
    `output_tokens=${numberValue(row['output_tokens'])}`,
  ].join(' ');
}

function renderRootCauseReport(
  args: Args,
  summary: RunSummary,
  diagnoses: Diagnosis[],
): string {
  const lines = [
    '# Root Cause Report',
    '',
    `- Run: ${args.runDir}`,
    `- Player/session: ${summary.playerId ?? 'unknown'} / ${summary.sessionId ?? 'unknown'}`,
    `- Diagnoses: ${diagnoses.length}`,
    '',
  ];
  if (diagnoses.length === 0) {
    lines.push('No automatic root-cause findings. Manual transcript review still recommended.');
    return `${lines.join('\n')}\n`;
  }
  for (const diagnosis of diagnoses) {
    lines.push(`## ${diagnosis.severity} - ${diagnosis.slug}`);
    lines.push(`- Owner: ${diagnosis.owner}`);
    lines.push(`- Root cause: ${diagnosis.rootCause}`);
    lines.push(`- Confidence: ${diagnosis.confidence}`);
    lines.push('- Evidence:');
    for (const item of diagnosis.evidence) lines.push(`  - ${item}`);
    lines.push('- Fix path:');
    for (const item of diagnosis.fixPath) lines.push(`  - ${item}`);
    lines.push('- Rerun:');
    for (const item of diagnosis.rerun) lines.push(`  - ${item}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function renderFixQueue(
  args: Args,
  summary: RunSummary,
  diagnoses: Diagnosis[],
): string {
  const actionable = diagnoses.filter(d => d.severity !== 'INFO');
  const lines = [
    '# Fix Queue',
    '',
    `- Run: ${args.runDir}`,
    `- Player/session: ${summary.playerId ?? 'unknown'} / ${summary.sessionId ?? 'unknown'}`,
    `- Actionable items: ${actionable.length}`,
    '',
  ];
  if (actionable.length === 0) {
    lines.push('No automatic fix items. Continue broader playtests.');
    return `${lines.join('\n')}\n`;
  }
  actionable.forEach((diagnosis, index) => {
    lines.push(`## ${index + 1}. ${diagnosis.slug}`);
    lines.push(`- Severity: ${diagnosis.severity}`);
    lines.push(`- Owner: ${diagnosis.owner}`);
    lines.push(`- Root cause: ${diagnosis.rootCause}`);
    lines.push('- First fix step:');
    lines.push(`  - ${diagnosis.fixPath[0] ?? 'Manual review required.'}`);
    lines.push('- Verification:');
    lines.push(`  - ${diagnosis.rerun[0] ?? 'Rerun scenario manually.'}`);
    lines.push('');
  });
  return `${lines.join('\n')}\n`;
}

function rerunCommand(runDir: string, scenario: StepSummary): string[] {
  const run = readRunName(runDir);
  return [
    `npm --prefix packages/web-server run live:marathon -- --scenarios ${scenario.slug} --session-id rerun-${scenario.slug}-${run}`,
  ];
}

function resolveStepDir(runDir: string, scenario: StepSummary): string {
  if (scenario.outDir && path.isAbsolute(scenario.outDir)) return scenario.outDir;
  if (scenario.outDir) return path.resolve(runDir, scenario.outDir);
  return path.join(runDir, scenario.slug);
}

function parseArgs(argv: string[]): Args {
  const runRaw = stringArg(argv, 'run') ?? argv.find(arg => !arg.startsWith('--'));
  if (!runRaw) {
    throw new Error('usage: npm run live:diagnose -- --run <run-dir>');
  }
  return {
    runDir: resolveInputPath(runRaw),
    outputPrefix: stringArg(argv, 'output-prefix') ?? 'ROOT_CAUSE_REPORT',
  };
}

function resolveInputPath(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(repoRootFromCwd(), raw);
}

function repoRootFromCwd(): string {
  const cwd = process.cwd();
  if (
    path.basename(cwd).toLowerCase() === 'web-server' &&
    path.basename(path.dirname(cwd)).toLowerCase() === 'packages'
  ) {
    return path.resolve(cwd, '..', '..');
  }
  return cwd;
}

function stringArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const next = argv[idx + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

async function readJsonOptional<T>(file: string): Promise<T | null> {
  try {
    return await readJson<T>(file);
  } catch (err) {
    const code = (err as {code?: unknown}).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function titleOf(scenario: StepSummary): string {
  return scenario.title ?? scenario.slug;
}

function textPreview(text: string): string {
  const compactText = text.replace(/\s+/g, ' ').trim();
  if (!compactText) return 'assistant_text=none';
  return `assistant_text=${compactText.slice(0, 240)}`;
}

function stringifySmall(value: unknown): string {
  if (value == null) return 'null';
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return String(value).slice(0, 300);
  }
}

function numberValue(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function compact<T>(items: Array<T | null | undefined | false>): T[] {
  return items.filter(Boolean) as T[];
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRunName(runDir: string): string {
  return path.basename(path.resolve(runDir)).replace(/[^a-zA-Z0-9_-]+/g, '-');
}
