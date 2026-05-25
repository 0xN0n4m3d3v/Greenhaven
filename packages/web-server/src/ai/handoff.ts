/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Two-stage turn orchestration:
//   Stage 1 (broker): tool loop that halts when narrate is requested.
//   Stage 2 (narrator): receives narrate args, streams prose, executes
//                       the real narrate tool which persists + emits SSE.

import {
  hasToolCall,
  stepCountIs,
  streamText,
  type ModelMessage,
  type Tool,
} from 'ai';
import {tryParseJsonWithinCap} from '../jsonSalvage.js';
import type {ToolDefinition} from '../tools/base.js';
import {isToolFunctionDumpText} from '../tools/narrate.js';
import type {RunnerProviders} from './providers.js';
import {executableTool, handoffTool} from './toolAdapter.js';

export const MAX_MUTATION_TOOLS = 5;

export const READ_ONLY_TOOL_NAMES = new Set([
  'query_entity',
  'query_inventory',
  'query_player_state',
  'query_player_profile',
  'query_memory',
  'search_entities',
  'get_recent_history',
  'get_runtime_field',
  'summarize_relationships',
  'evaluate_social_standing',
  'predict_consequence',
  'recall_partner_history',
]);

export const MUTATION_LIMIT_WARNING =
  "[SYSTEM] You've made %d mutation tool calls. You MUST call narrate() now to produce visible prose for the player. Further mutations this turn are blocked.";

export interface BrokerOutcome {
  /** narrate args if broker called narrate; undefined if it stopped naturally */
  narrateRequest?: Record<string, unknown>;
  /** assistant messages from broker stage (for handoff context) */
  responseMessages: ModelMessage[];
  /** prose streamed directly by broker (synth-fallback case) */
  contentBuffer: string;
  /** tool-call telemetry from the broker stream */
  toolCallCount: number;
  toolNamesCalled: string[];
  /** true if mutation tool calls exceeded MAX_MUTATION_TOOLS without calling narrate */
  mutationLimitExceeded: boolean;
  /** telemetry */
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

// S-13 — domain error vocabulary lives in `../turn/errors.ts`.
// Re-exported here so existing imports from `./ai/handoff.js`
// keep working without touching every call site.
import {
  BrokerEmptyOutputError,
  getTurnErrorCode,
  isBrokerEmptyOutputError,
  TurnCancelledError,
} from '../turn/errors.js';
export {BrokerEmptyOutputError, isBrokerEmptyOutputError};

export async function runBroker(args: {
  providers: RunnerProviders;
  systemPrompt: string;
  userMessage: string;
  tools: Map<string, ToolDefinition>;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onToolCall?: (callId: string, name: string, input: unknown) => void;
  onToolResult?: (callId: string, output: unknown, isError: boolean) => void;
}): Promise<BrokerOutcome> {
  throwIfAborted(args.signal);

  const aiTools: Record<string, Tool> = {};
  for (const [name, def] of args.tools) {
    aiTools[name] = name === 'narrate' ? handoffTool(def) : executableTool(def);
  }

  const offered = [...args.tools.keys()];
  console.log(
    `[broker.start] thinking=${args.providers.brokerThinking} ` +
      `tools_offered=${offered.length} (${offered.join(',')})`,
  );

  // Build the set of mutation tool names (everything except narrate and read-only tools)
  const mutationToolNames = new Set(
    offered.filter(
      (name) => name !== 'narrate' && !READ_ONLY_TOOL_NAMES.has(name),
    ),
  );

  const stageOverride = brokerStageOverrideForTools(args.tools);
  const result = streamText({
    model: args.providers.broker,
    system: args.systemPrompt + stageOverride,
    messages: [{role: 'user', content: args.userMessage}],
    tools: aiTools,
    stopWhen: [
      stepCountIs(8),
      hasToolCall('narrate'),
    ],
    // Broker should call tools, not write long prose. Keeping the completion
    // budget small also prevents 32k-window OpenAI-compatible models from
    // rejecting otherwise valid tool prompts because of an excessive default.
    // 2048 (was 1024) — when a model stringifies tool args (DeepSeek
    // occasionally does), a multi-tool turn at 1024 tokens truncated the
    // last call mid-JSON (advance_quest at 10:36:36 had `"to_phase": ` and
    // no closing brace). 2048 leaves headroom while still well below the
    // 32k-window provider rejection threshold.
    maxOutputTokens: 2048,
    abortSignal: args.signal,
    providerOptions: args.providers.brokerThinking
      ? {deepseek: {thinking: {type: 'enabled'}}}
      : undefined,
  });

  let contentBuffer = '';
  let toolCallCount = 0;
  let streamError: unknown = null;
  const toolNamesCalled: string[] = [];
  let mutationToolCount = 0;
  // Salvage for the "narrate args streamed as a JSON-encoded string" failure
  // mode. Some chat-tuned models (DeepSeek-style) emit `arguments` as
  // `"{\"text\": ...}"` instead of an object. AI SDK's schema validator
  // rejects this with tool-error; result.toolCalls then carries the unparsed
  // string. Without salvage the broker hands a string-shaped narrateRequest
  // to the narrator stage, costing ~30s of re-roll. With salvage the
  // original turn carries through.
  let salvagedNarrateInput: Record<string, unknown> | undefined;
  const trySalvageNarrate = (raw: unknown): Record<string, unknown> | undefined => {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return undefined;
    // AI-1 — bounded JSON parse; over-cap streams fall through to
    // the existing "not salvageable" path instead of letting a
    // pathological model pin this turn on JSON parsing.
    const result = tryParseJsonWithinCap(trimmed);
    if (!result.ok) return undefined;
    const parsed = result.value;
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as {text?: unknown}).text === 'string'
    ) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  };
  for await (const part of result.fullStream) {
    if (args.signal.aborted) break;
    switch (part.type) {
      case 'text-delta':
        contentBuffer += part.text;
        args.onText?.(part.text);
        break;
      case 'tool-call':
        toolCallCount++;
        toolNamesCalled.push(part.toolName);
        try {
          const inputPreview = JSON.stringify(part.input).slice(0, 220);
          console.log(
            `[broker.tool] #${toolCallCount} ${part.toolName} args=${inputPreview}`,
          );
        } catch {/* swallow log fail */}
        if (part.toolName === 'narrate') {
          const salvaged = trySalvageNarrate(part.input);
          if (salvaged && !salvagedNarrateInput) {
            salvagedNarrateInput = salvaged;
            console.warn(
              `[broker.tool] narrate args were a JSON-encoded string; salvaged in-band`,
            );
          }
        }
        if (part.toolName !== 'narrate' && mutationToolNames.has(part.toolName)) {
          mutationToolCount++;
        }
        args.onToolCall?.(part.toolCallId, part.toolName, part.input);
        break;
      case 'tool-result':
        args.onToolResult?.(part.toolCallId, part.output, false);
        break;
      case 'tool-error': {
        const e = part as {toolName?: string; error?: unknown; input?: unknown};
        console.warn(
          `[broker.tool-error] ${e.toolName ?? '<?>'}: ${String(e.error).slice(0, 200)}`,
        );
        if (e.toolName === 'narrate' && !salvagedNarrateInput) {
          // AI SDK surfaces the raw model-provided input on the error
          // payload for invalid-input failures. Fall back to the part-level
          // input field if the error wrapper doesn't expose it.
          const errInput =
            (e.error as {input?: unknown} | undefined)?.input ?? e.input;
          const salvaged = trySalvageNarrate(errInput);
          if (salvaged) {
            salvagedNarrateInput = salvaged;
            if (!toolNamesCalled.includes('narrate')) {
              toolNamesCalled.push('narrate');
            }
            console.warn(
              `[broker.tool-error] salvaged narrate args from invalid-input error`,
            );
          }
        }
        args.onToolResult?.(part.toolCallId, part.error, true);
        break;
      }
      case 'error':
        streamError = (part as {error?: unknown}).error ?? part;
        console.error('[broker.stream-error]', streamError);
        break;
      default:
        break;
    }
  }
  throwIfAborted(args.signal);

  if (streamError && !args.signal.aborted) {
    throw brokerStreamError(streamError);
  }

  const sawNarrate = toolNamesCalled.includes('narrate');
  const mutationLimitExceeded =
    !sawNarrate && mutationToolCount >= MAX_MUTATION_TOOLS;
  console.log(
    `[broker.exit] tool_calls=${toolCallCount} ` +
      `[${toolNamesCalled.join(',') || 'NONE'}] ` +
      `narrate_handoff=${sawNarrate} prose_chars=${contentBuffer.length}` +
      (contentBuffer.length > 0 && !sawNarrate
        ? ' — WILL_TRIGGER_SYNTH_FALLBACK'
        : '') +
      (mutationLimitExceeded ? ' — MUTATION_LIMIT_EXCEEDED' : ''),
  );
  // When broker leaks prose instead of calling narrate, log a preview so we
  // can diagnose the prompt failure mode (which model, what tone of leak).
  if (contentBuffer.length > 0 && !sawNarrate) {
    console.warn(
      `[broker.prose-leak] first 240 chars: ${contentBuffer.slice(0, 240)}`,
    );
  }

  const calls = await result.toolCalls;
  const narrateCall = calls.find(c => c.toolName === 'narrate');
  // Last-chance salvage: toolCalls may carry the raw string input even when
  // the in-stream tool-call event already exposed the object form (or vice
  // versa). Prefer a valid object; fall back to the in-stream salvage.
  if (narrateCall && !salvagedNarrateInput) {
    const salvaged = trySalvageNarrate(narrateCall.input);
    if (salvaged) {
      salvagedNarrateInput = salvaged;
      console.warn(
        `[broker.exit] salvaged narrate args from toolCalls (string-shaped input)`,
      );
    }
  }
  const narrateInput =
    narrateCall &&
    typeof narrateCall.input === 'object' &&
    narrateCall.input !== null &&
    !Array.isArray(narrateCall.input)
      ? (narrateCall.input as Record<string, unknown>)
      : salvagedNarrateInput;
  if (
    !args.signal.aborted &&
    !narrateCall &&
    toolCallCount === 0 &&
    !contentBuffer.trim()
  ) {
    throw new BrokerEmptyOutputError();
  }
  const usage = await result.totalUsage;
  const meta = await result.providerMetadata;
  const ds = (meta?.['deepseek'] ?? {}) as {
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
  };

  return {
    narrateRequest: narrateInput,
    responseMessages: (await result.response).messages,
    contentBuffer,
    toolCallCount,
    toolNamesCalled,
    mutationLimitExceeded,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheHitTokens: ds.promptCacheHitTokens ?? 0,
    cacheMissTokens: ds.promptCacheMissTokens ?? 0,
  };
}

export function brokerStageOverrideForTools(
  tools: ReadonlyMap<string, ToolDefinition>,
): string {
  const parts = [BROKER_STAGE_BASE_OVERRIDE];
  if (
    tools.has('damage') ||
    tools.has('mark_downed') ||
    tools.has('death_save')
  ) {
    parts.push(BROKER_STAGE_COMBAT_OVERRIDE);
  }
  if (
    tools.has('dice_check') &&
    (tools.has('damage') || tools.has('string_award'))
  ) {
    parts.push(BROKER_STAGE_BARGAIN_OVERRIDE);
  }
  if (tools.has('apply_intimacy_trigger') || tools.has('string_award')) {
    parts.push(BROKER_STAGE_INTIMACY_OVERRIDE);
  }
  return parts.join('\n\n');
}

function brokerStreamError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as {message?: unknown}).message === 'string'
  ) {
    return new Error((error as {message: string}).message);
  }
  return new Error(String(error));
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  // S-13 — preserve richer abort reasons (watchdog, session reset,
  // explicit cancel) verbatim so the catch handler can read
  // `getTurnErrorCode(err)` and route telemetry by domain code.
  // Anything else — Node's auto-created `DOMException` AbortError,
  // a raw string from `AbortController.abort('reason')`, or no
  // reason at all — collapses to a single `TurnCancelledError`.
  if (reason instanceof Error && getTurnErrorCode(reason) != null) {
    throw reason;
  }
  if (typeof reason === 'string' && reason.trim()) {
    throw new TurnCancelledError(reason);
  }
  throw new TurnCancelledError();
}

export interface NarratorOutcome {
  contentBuffer: string;
  /** True if the model issued at least one tool call (narrate or otherwise). */
  toolCallsSeen: number;
  /** Number of completed tool results observed on the narrator stream. */
  toolResultsSeen: number;
  /** Number of tool execution errors observed on the narrator stream. */
  toolErrorsSeen: number;
  /** Last narrate input observed on the tool-call channel, if any. */
  lastNarrateInput?: Record<string, unknown>;
  /** True if early bytes look like a control dump (JSON narrate args or
   *  function-call-shaped pseudo-tools). When set, the caller should treat
   *  contentBuffer as machine-formatted and avoid trusting the live stream. */
  jsonDumpDetected: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export async function runNarrator(args: {
  providers: RunnerProviders;
  systemPrompt: string;
  userMessage: string;
  narrateTool: ToolDefinition;
  signal: AbortSignal;
  onText?: (delta: string) => void;
}): Promise<NarratorOutcome> {
  throwIfAborted(args.signal);

  const startedAt = Date.now();
  console.log(
    `[narrator.start] model=${args.providers.narratorModelId} ` +
      `thinking=${args.providers.narratorThinking} ` +
      `featherless=${args.providers.narratorIsFeatherless} ` +
      `userMsg_chars=${args.userMessage.length}`,
  );

  // DeepSeek-specific providerOptions only when narrator is DeepSeek.
  // Featherless (OpenAI-compat) rejects unknown provider keys silently
  // in some versions; explicit guard avoids surprises.
  const providerOptions =
    !args.providers.narratorIsFeatherless && args.providers.narratorThinking
      ? {deepseek: {thinking: {type: 'enabled' as const}}}
      : undefined;

  let result;
  try {
    result = streamText({
      model: args.providers.narrator,
      system: args.systemPrompt,
      messages: [{role: 'user', content: args.userMessage}],
      tools: {narrate: executableTool(args.narrateTool)},
      abortSignal: args.signal,
      providerOptions,
    });
  } catch (err) {
    console.error(`[narrator.error] streamText init failed:`, err);
    throw err;
  }

  let contentBuffer = '';
  let firstDeltaAt = 0;
  let textChunks = 0;
  let toolCallsSeen = 0;
  let toolResultsSeen = 0;
  let toolErrorsSeen = 0;
  let lastNarrateInput: Record<string, unknown> | undefined;
  // Some models dump narrate args or pseudo-tool calls as raw text instead of
  // using the real tool call channel. The result can be a markdown JSON fence
  // or a `narrate(...) add_memory(...)` function chain streamed to the player
  // as garbled prose.
  //
  // Strategy: buffer the first DETECT_WINDOW chars BEFORE emitting any to
  // SSE. Once the buffer is long enough to classify, decide:
  //   - prose          -> flush buffer as a delta, stream normally afterwards
  //   - control dump   -> never flush; suppress further onText. Caller will
  //                       sanitise/quarantine the contentBuffer post-stream.
  // The cost of detection is a ~120-char delay on first paint — barely
  // perceptible compared to the ~1000ms TTFT from Featherless cold loads.
  const DETECT_WINDOW = 120;
  let earlyBuffer = '';
  let detectionDone = false;
  let jsonDumpDetected = false;

  const isJsonDumpPrefix = (s: string): boolean => {
    const t = s.trimStart();
    if (isToolFunctionDumpText(t)) return true;
    if (t.startsWith('```')) return true; // markdown fence (```json or plain ```)
    if (t.startsWith('{')) {
      // Bare JSON object — needs evidence of narrate-args shape
      return /["']text["']\s*:/.test(t);
    }
    return false;
  };

  const flushEarlyAsProse = () => {
    if (earlyBuffer && args.onText) args.onText(earlyBuffer);
    earlyBuffer = '';
    detectionDone = true;
  };

  for await (const part of result.fullStream) {
    if (args.signal.aborted) {
      console.log('[narrator.aborted] mid-stream');
      break;
    }
    if (part.type === 'text-delta') {
      if (firstDeltaAt === 0) {
        firstDeltaAt = Date.now();
        console.log(`[narrator.first_delta] after ${firstDeltaAt - startedAt}ms`);
      }
      textChunks++;
      contentBuffer += part.text;

      if (!detectionDone) {
        earlyBuffer += part.text;
        if (isJsonDumpPrefix(earlyBuffer)) {
          jsonDumpDetected = true;
          detectionDone = true;
          earlyBuffer = ''; // never flush — control garbage stays out of the live stream
          console.warn(
            `[narrator.control-dump] suppressing stream — model emitted control-shaped text`,
          );
        } else if (earlyBuffer.length >= DETECT_WINDOW) {
          flushEarlyAsProse();
        }
      } else if (!jsonDumpDetected) {
        args.onText?.(part.text);
      }
    } else if (part.type === 'tool-call') {
      toolCallsSeen++;
      const tc = part as {toolName?: string; input?: unknown};
      if (
        tc.toolName === 'narrate' &&
        typeof tc.input === 'object' &&
        tc.input !== null &&
        !Array.isArray(tc.input)
      ) {
        lastNarrateInput = tc.input as Record<string, unknown>;
      }
      console.log(`[narrator.tool] #${toolCallsSeen} ${tc.toolName ?? '<?>'}`);
    } else if (part.type === 'tool-result') {
      toolResultsSeen++;
      const tr = part as {toolName?: string; output?: unknown};
      console.log(
        `[narrator.tool-result] #${toolResultsSeen} ${tr.toolName ?? '<?>'} ` +
          `output=${previewForLog(tr.output)}`,
      );
    } else if (part.type === 'tool-error') {
      toolErrorsSeen++;
      const te = part as {toolName?: string; error?: unknown};
      console.warn(
        `[narrator.tool-error] #${toolErrorsSeen} ${te.toolName ?? '<?>'}: ` +
          previewForLog(te.error),
      );
    } else if (part.type === 'error') {
      console.error('[narrator.stream-error]', (part as {error?: unknown}).error);
    }
    // reasoning-* / start-step / finish-step / etc — ignored
  }
  // Stream ended before the detection window filled — output was short
  // enough that we never decided. Treat it as prose.
  throwIfAborted(args.signal);

  if (!detectionDone && earlyBuffer) {
    flushEarlyAsProse();
  }

  console.log(
    `[narrator.exit] chars=${contentBuffer.length} ` +
      `chunks=${textChunks} tool_calls=${toolCallsSeen} ` +
      `tool_results=${toolResultsSeen} tool_errors=${toolErrorsSeen} ` +
      `total_ms=${Date.now() - startedAt}` +
      (firstDeltaAt > 0 ? ` ttfb_ms=${firstDeltaAt - startedAt}` : ' NO_FIRST_DELTA'),
  );

  const usage = await result.totalUsage;
  const meta = await result.providerMetadata;
  const ds = (meta?.['deepseek'] ?? {}) as {
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
  };
  return {
    contentBuffer,
    toolCallsSeen,
    toolResultsSeen,
    toolErrorsSeen,
    lastNarrateInput,
    jsonDumpDetected,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheHitTokens: ds.promptCacheHitTokens ?? 0,
    cacheMissTokens: ds.promptCacheMissTokens ?? 0,
  };
}

function previewForLog(value: unknown): string {
  if (value instanceof Error) return (value.stack ?? value.message).slice(0, 240);
  if (typeof value === 'string') return value.slice(0, 240);
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value).slice(0, 240);
  }
}

export function buildNarratorHandoffMessage(
  originalUserMessage: string,
  narrateArgs: Record<string, unknown>,
): string {
  return [
    originalUserMessage,
    `[Broker stage complete. Produce the prose for the following narration request:]`,
    '```json',
    JSON.stringify(narrateArgs, null, 2),
    '```',
  ].join('\n\n');
}

/**
 * Defensive: today narrate runs as a single step so its responseMessages
 * never carry reasoning content blocks back into the next turn. If we
 * later add multi-step narrator flow, AI SDK would surface DeepSeek
 * thinking output as `{type: 'reasoning'}` content parts that, if fed
 * back as message history, would bill us forever for old thoughts.
 * Strip them at the boundary before any persistence or replay path.
 */
export function stripReasoningContent(messages: ModelMessage[]): ModelMessage[] {
  return messages.map(m => {
    if (!m || typeof m !== 'object') return m;
    const content = (m as {content?: unknown}).content;
    if (!Array.isArray(content)) return m;
    const filtered = (content as unknown[]).filter(
      part =>
        !(
          typeof part === 'object' &&
          part !== null &&
          (part as {type?: string}).type === 'reasoning'
        ),
    );
    return {...m, content: filtered} as ModelMessage;
  });
}

const BROKER_STAGE_BASE_OVERRIDE = `

[BROKER STAGE]
You are the BROKER. Your job: gather state via read-tools, perform any
mutations the player's intent demands, and call narrate(...) when ready
to produce prose. You DO NOT write prose. You DO NOT output text outside
tool calls. Prose in the text channel is a bug. End every turn with
narrate(...), even if the only useful response is "no change."
After at most 3 read tool calls, you MUST either call a mutation OR call
narrate(...).`;

const BROKER_STAGE_INTIMACY_OVERRIDE = `
[INTIMACY BROKER CONTRACT]
The intimacy profile is still a tool-calling broker. Never end the
assistant message empty. On every intimate beat, choose one of these:
  1. If consent is clear and the beat lands, call an intimacy state tool
     first (apply_intimacy_trigger, string_award, add_memory, or
     advance_quest), then call narrate.
  2. If consent, price, or boundary is uncertain, call dice_check or
     add_memory for the proposition/boundary if available, then call
     narrate with the in-world answer.
  3. If no mutation is justified, call narrate with a clear boundary,
     condition, or next playable question.
Do not choose silence. Do not rely on hidden implication; consent and
state changes must be visible in tools or prose.`;

const BROKER_STAGE_COMBAT_OVERRIDE = `
[COMBAT RESOLUTION — STRICT]
Player-authored combat prose is intent and cinematic style, not a
confirmed hit. Even if the player writes completed impact language
(anatomical detail, blood/bone/wound aftermath, "I stab the throat",
"the bottle breaks on his head"), call a visible d20 dice_check
against the target AC before any damage.

If the d20 succeeds, apply damage(target, amount) with amount scaled
to the intended wound:
  light cut          → 8-15
  deep cut           → 18-30
  mortal wound       → 35-60
  killing blow       → enough to defeat (read current_hp from preamble)
Then narrate the player's described move as the landed consequence.

If the d20 fails, DO NOT call damage. Narrate the same intent as a
miss, interruption, deflection, glancing blow, or costly opening. Do
not censor or soften what the player attempted; only the mechanical
outcome changes. NPC HP/stats are in the preamble — do NOT
query_entity just to find AC/HP again.

[POSITION & EFFECT]
Every dice_check you fire MUST set position and effect explicitly.
Read them from the player's prose:
  - position = how recoverable failure is (controlled / risky / desperate)
  - effect = magnitude of success (limited / standard / great)
On effect=limited halve damage; on effect=great multiply by 1.5 (cap 60).
On position=desperate failure call the appropriate state tool (stunned,
disarmed, off-balance) — failure has teeth at desperate. Defaults:
position="risky", effect="standard".`;

const BROKER_STAGE_BARGAIN_OVERRIDE = `
[DEVIL'S BARGAIN]
Available bargains:
  - skip_queue: take +1d to dex check in exchange for skipping a wait
  - extra_damage: +1d6 damage now, but the next damage dealt to you gains +1d6
  - flashback: retcon a small item you "brought earlier" for -1 inspiration
  - desperation_armor: convert 1 trauma into temporary armor for this scene
Offer ONE bargain when position=desperate or the player is outnumbered.
Do not offer bargains on every roll — only when the narrative stakes justify it.`;

// --- End of prompt constants ---

