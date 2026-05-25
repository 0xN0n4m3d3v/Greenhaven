/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Tool framework — shared shape, dispatcher, and the tool context.
//
// A tool is:
//   {
//     name:        'award_xp',
//     description: 'Grant a player some XP for a stated reason.',
//     paramsSchema:zod schema (validated before execute),
//     execute:     async (args, ctx) => Result,
//   }
//
// Tools register themselves into a flat registry (TOOLS). The
// TurnRunner / scheduler asks the registry for tool definitions to
// surface to Gemini, then calls dispatch() with each tool call the
// model issues.
//
// Every dispatch lands in `tool_invocations` for audit. Errors are
// caught and returned to the caller as { ok: false, error } so the
// model gets a structured retry signal instead of an exception.

import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { onTransactionCommit, query } from '../db.js';
import {
  eventFromSample,
  startPerformanceSample,
  telemetry,
} from '../telemetry/index.js';
import {
  sessionManager,
  type ToolHistoryEntry,
  type ToolHistorySource,
} from '../sessionManager.js';

/**
 * Spec 139 v2 — what kind of input started this turn. Drives entity-
 * creation discipline: the broker may NOT create new locations / items /
 * persons / quests on a 'player_prose' turn. NPCs / scenes / quests /
 * system bootstrap can author entities; the player writing prose cannot
 * conjure them into existence. UI action chips (`player_action`) are
 * treated as player prose for these purposes.
 */
export type TurnInputKind =
  | 'player_prose'      // free-text player message
  | 'player_action'     // UI affordance / action chip
  | 'continue'          // player asked the scene to continue
  | 'scripted'          // server-side scripted turn (boot, system, replay)
  | 'unknown';

export interface ToolContext {
  /** Session id for the in-flight turn. */
  sessionId: string;
  /** Player making the call. Anonymous players still have an entity id. */
  playerId: number;
  /** Optional turn id for grouping invocations across one user message. */
  turnId?: string;
  /** Optional abort signal for the active turn. In-process only. */
  signal?: AbortSignal;
  /** Runtime source used by the active-turn tool history recorder. */
  toolHistorySource?: ToolHistorySource;
  /** Parent batch identifier for batch child operations. */
  batchId?: string;
  /** Child operation id inside `batch_mutate_world`. */
  operationId?: string;
  /** Spec 139 v2 — input class for entity-creation discipline. */
  turnInputKind?: TurnInputKind;
}

// ALS storage. Wrap a turn's run inside `runWithContext()` and any tool
// fired transitively (including those dispatched through legacy
// Scheduler) reads the same context via `currentToolContext()`.
const contextStorage = new AsyncLocalStorage<ToolContext>();

export function runWithContext<T>(
  ctx: ToolContext,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return contextStorage.run(ctx, fn);
}

export function currentToolContext(): ToolContext {
  const ctx = contextStorage.getStore();
  if (!ctx) {
    throw new Error(
      'No ToolContext in scope. A tool was executed outside runWithContext() — wrap the turn dispatch in runWithContext({sessionId, playerId, turnId}, …).',
    );
  }
  return ctx;
}

/**
 * Sentinel error thrown by tools that want to terminate the agent loop
 * (e.g. `narrate(done=true)`). The adapter translates this into a
 * ToolResult with `error.type = ToolErrorType.STOP_EXECUTION` which the
 * turn runner watches for to exit the inference cycle cleanly.
 *
 * `message` is opaque to the model — the loop just stops.
 */
export class StopExecution extends Error {
  constructor(message = 'stop') {
    super(message);
    this.name = 'StopExecution';
  }
}

export class ToolExecutionError extends Error {
  readonly suggestion?: Record<string, unknown>;
  readonly rejected: boolean;

  constructor(
    message: string,
    opts: { suggestion?: Record<string, unknown>; rejected?: boolean } = {},
  ) {
    super(message);
    this.name = 'ToolExecutionError';
    this.rejected = opts.rejected ?? false;
    if (opts.suggestion) this.suggestion = opts.suggestion;
  }
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /**
   * Spec 48 — Cartridge Steward marks pre-tool rejection with this
   * flag and optionally returns a `suggestion` payload the broker
   * can apply on retry (e.g., a corrected display_name in the
   * selected player language).
   */
  rejected?: boolean;
  suggestion?: Record<string, unknown>;
}

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  paramsSchema: z.ZodType<TArgs>;
  /**
   * Optional canonicalisation after schema parse but before validators,
   * execution, and audit. Keep this narrow: model-facing tools should prefer
   * one canonical argument shape over compatibility aliases.
   */
  normalizeArgs?(args: TArgs): TArgs;
  execute(args: TArgs, ctx: ToolContext): Promise<TResult>;
}

const TOOLS = new Map<string, ToolDefinition>();

/** Register a tool. Called from each tools/*.ts module at import time. */
export function registerTool<TArgs, TResult>(
  def: ToolDefinition<TArgs, TResult>,
): void {
  if (TOOLS.has(def.name)) {
    throw new Error(`tool already registered: ${def.name}`);
  }
  TOOLS.set(def.name, def as ToolDefinition);
}

export function getRegisteredTools(): ReadonlyMap<string, ToolDefinition> {
  return TOOLS;
}

/**
 * Spec 48 — pre-tool validators (Cartridge Steward).
 *
 * A validator runs AFTER zod schema parse but BEFORE def.execute.
 * Returning { ok: false, reason, suggestion } rejects the call:
 * dispatch returns { ok: false, error: <reason>, rejected: true,
 * suggestion } so the broker sees a structured error and retries
 * with corrected args.
 *
 * Multiple validators can register for the same tool; first reject
 * wins.
 */
export type PreToolValidator = (
  toolName: string,
  args: unknown,
  ctx: ToolContext,
) => Promise<
  | { ok: true }
  | { ok: false; reason: string; suggestion?: Record<string, unknown> }
>;

const PRE_TOOL_VALIDATORS = new Map<string, PreToolValidator[]>();

export function registerPreToolValidator(
  toolName: string,
  validator: PreToolValidator,
): void {
  const list = PRE_TOOL_VALIDATORS.get(toolName) ?? [];
  list.push(validator);
  PRE_TOOL_VALIDATORS.set(toolName, list);
}

/**
 * Validate args, run pre-tool validators, execute, and audit. This is the
 * single execution boundary used by both the legacy dispatch API and the AI
 * SDK adapter.
 */
export async function executeTool(
  toolName: string,
  rawArgs: unknown,
  ctx: ToolContext,
  opts: { propagateStopExecution?: boolean } = {},
): Promise<ToolResult> {
  const startedAt = Date.now();
  const perfSample = startPerformanceSample();
  const recordToolPerf = async (
    status: string,
    error: string | null = null,
    metadata: Record<string, unknown> = {},
  ) => {
    const sampled = eventFromSample(perfSample, {
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId ?? null,
      kind: 'tool',
      phase: `tool.${toolName}`,
      status,
      error,
      metadata: {
        tool_name: toolName,
        source: ctx.toolHistorySource ?? 'direct',
        batch_id: ctx.batchId ?? null,
        operation_id: ctx.operationId ?? null,
        ...metadata,
      },
    });
    telemetry.record({
      channel: 'performance',
      name: sampled.phase,
      ...sampled,
    });
  };
  if (ctx.signal?.aborted) {
    const error = signalAbortMessage(ctx.signal);
    await audit({
      ctx,
      tool_name: toolName,
      args: rawArgs,
      result: null,
      error,
      durationMs: Date.now() - startedAt,
    });
    await recordToolPerf(errorStatus(error), error, {
      reason: 'turn_aborted_before_tool',
    });
    return { ok: false, error };
  }

  const def = TOOLS.get(toolName);
  if (!def) {
    const error = `unknown tool: ${toolName}`;
    await audit({
      ctx,
      tool_name: toolName,
      args: rawArgs,
      result: null,
      error: 'unknown_tool',
      durationMs: Date.now() - startedAt,
    });
    recordToolHistory(ctx, {
      name: toolName,
      args: toHistoryArgs(redactSensitiveToolArgs(toolName, rawArgs)),
      ok: false,
      error,
      source: ctx.toolHistorySource ?? 'direct',
    });
    await recordToolPerf('error', error, { reason: 'unknown_tool' });
    return { ok: false, error };
  }

  // Validate. Zod errors carry the full path → useful feedback for
  // the LLM about which arg was wrong.
  const parsed = def.paramsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    const error = `invalid args: ${issues}`;
    await audit({
      ctx,
      tool_name: toolName,
      args: rawArgs,
      result: null,
      error,
      durationMs: Date.now() - startedAt,
    });
    recordToolHistory(ctx, {
      name: toolName,
      args: toHistoryArgs(redactSensitiveToolArgs(toolName, rawArgs)),
      ok: false,
      error,
      source: ctx.toolHistorySource ?? 'direct',
    });
    await recordToolPerf('error', error, { reason: 'invalid_args' });
    return { ok: false, error };
  }

  // Spec 48 — pre-tool validators (Cartridge Steward). One reject
  // short-circuits the dispatch with a structured ToolResult the
  // broker can read + retry with corrected args.
  let argsForRun = parsed.data;
  if (def.normalizeArgs) {
    try {
      argsForRun = def.normalizeArgs(parsed.data);
    } catch (err) {
      const error = `invalid args: ${err instanceof Error ? err.message : String(err)}`;
      await audit({
        ctx,
        tool_name: toolName,
        args: rawArgs,
        result: null,
        error,
        durationMs: Date.now() - startedAt,
      });
      recordToolHistory(ctx, {
        name: toolName,
        args: toHistoryArgs(redactSensitiveToolArgs(toolName, rawArgs)),
        ok: false,
        error,
        source: ctx.toolHistorySource ?? 'direct',
      });
      await recordToolPerf('error', error, { reason: 'normalize_args' });
      return { ok: false, error };
    }
  }

  const validators = PRE_TOOL_VALIDATORS.get(toolName) ?? [];
  for (const v of validators) {
    try {
      const verdict = await v(toolName, argsForRun, ctx);
      if (!verdict.ok) {
        const result: ToolResult & {
          rejected?: boolean;
          suggestion?: Record<string, unknown>;
        } = {
          ok: false,
          error: verdict.reason,
          rejected: true,
        };
        if (verdict.suggestion) result.suggestion = verdict.suggestion;
        await audit({
          ctx,
          tool_name: toolName,
          args: argsForRun,
          result: null,
          error: `rejected: ${verdict.reason}`,
          durationMs: Date.now() - startedAt,
        });
        recordToolHistory(ctx, {
          name: toolName,
          args: toHistoryArgs(redactSensitiveToolArgs(toolName, argsForRun)),
          ok: false,
          error: verdict.reason,
          result: verdict.suggestion
            ? { rejected: true, suggestion: verdict.suggestion }
            : { rejected: true },
          source: ctx.toolHistorySource ?? 'direct',
        });
        await recordToolPerf('skipped', verdict.reason, {
          reason: 'pre_tool_rejected',
          guard: verdict.suggestion?.['guard'] ?? null,
          source_grounding:
            typeof verdict.suggestion?.['guard'] === 'string' &&
            verdict.suggestion['guard'].includes('source_grounding')
              ? 'rejected'
              : null,
        });
        return result;
      }
    } catch (err) {
      // CATCH-WARN-OK: pre-tool validator that explicitly fails open so the broker's tool call still proceeds; the per-tool post-execution telemetry channel records the tool's actual outcome, so re-emitting a "validator threw" signal would mask the fail-open semantics.
      // Validator threw → fail open (the call proceeds). Log only.
      console.warn(
        `[pre-tool-validator ${toolName}] threw, failing open:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  try {
    const data = await def.execute(argsForRun, ctx);
    await audit({
      ctx,
      tool_name: toolName,
      args: argsForRun,
      result: data,
      error: null,
      durationMs: Date.now() - startedAt,
    });
    recordToolHistory(ctx, {
      name: toolName,
      args: toHistoryArgs(redactSensitiveToolArgs(toolName, argsForRun)),
      ok: true,
      result: data,
      source: ctx.toolHistorySource ?? 'direct',
    });
    await recordToolPerf('ok', null);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof StopExecution) {
      const data = { ok: true, stopped: true };
      await audit({
        ctx,
        tool_name: toolName,
        args: argsForRun,
        result: data,
        error: null,
        durationMs: Date.now() - startedAt,
      });
      recordToolHistory(ctx, {
        name: toolName,
        args: toHistoryArgs(redactSensitiveToolArgs(toolName, argsForRun)),
        ok: true,
        result: data,
        source: ctx.toolHistorySource ?? 'direct',
      });
      await recordToolPerf('ok', null, { stopped: true });
      if (opts.propagateStopExecution) throw err;
      return { ok: true, data };
    }
    const error = err instanceof Error ? err.message : String(err);
    const toolError = err instanceof ToolExecutionError ? err : null;
    await audit({
      ctx,
      tool_name: toolName,
      args: argsForRun,
      result: null,
      error,
      durationMs: Date.now() - startedAt,
    });
    recordToolHistory(ctx, {
      name: toolName,
      args: toHistoryArgs(redactSensitiveToolArgs(toolName, argsForRun)),
      ok: false,
      error,
      ...(toolError?.suggestion
        ? {
            result: {
              rejected: toolError.rejected,
              suggestion: toolError.suggestion,
            },
          }
        : {}),
      source: ctx.toolHistorySource ?? 'direct',
    });
    await recordToolPerf(errorStatus(error), error, {
      rejected: toolError?.rejected ?? false,
    });
    return {
      ok: false,
      error,
      ...(toolError?.rejected ? { rejected: true } : {}),
      ...(toolError?.suggestion ? { suggestion: toolError.suggestion } : {}),
    };
  }
}

function errorStatus(error: string): string {
  // LANGUAGE-REGEX-OK: maps SDK error messages into Greenhaven's `errorStatus` taxonomy. `timeout`/`deadline`/`abort`/`cancel` are wire-format tokens emitted by the AI SDK, the AbortSignal API, and Node's `AbortError` — not natural-language player input. Used purely to bucket tool-call telemetry rows.
  if (/timeout|deadline/i.test(error)) return 'timeout';
  // LANGUAGE-REGEX-OK: see `errorStatus` above — `abort`/`cancel` are AbortSignal protocol tokens, not natural language.
  if (/abort|cancel/i.test(error)) return 'cancelled';
  return 'error';
}

function signalAbortMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return 'turn canceled';
}

/**
 * Validate args, run the tool, audit the call. Errors during validation
 * or execution are recorded and returned as ToolResult; we never throw
 * out of dispatch so the agent loop stays in control.
 */
export async function dispatch(
  toolName: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  return executeTool(toolName, rawArgs, ctx);
}

export async function recordSyntheticToolInvocation(opts: {
  ctx: ToolContext;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string | null;
  durationMs?: number;
  source?: ToolHistorySource;
}): Promise<void> {
  await audit({
    ctx: opts.ctx,
    tool_name: opts.toolName,
    args: opts.args,
    result: opts.result,
    error: opts.error ?? null,
    durationMs: opts.durationMs ?? 0,
  });
  recordToolHistory(opts.ctx, {
    name: opts.toolName,
    args: toHistoryArgs(redactSensitiveToolArgs(opts.toolName, opts.args)),
    ok: opts.error == null,
    result: opts.result,
    ...(opts.error ? { error: opts.error } : {}),
    source: opts.source ?? opts.ctx.toolHistorySource ?? 'direct',
  });
}

interface AuditInput {
  ctx: ToolContext;
  tool_name: string;
  args: unknown;
  result: unknown;
  error: string | null;
  durationMs: number;
}

async function audit(a: AuditInput): Promise<void> {
  const args = redactSensitiveToolArgs(a.tool_name, a.args);
  try {
    await query(
      `INSERT INTO tool_invocations
         (session_id, player_id, turn_id, tool_name, args, result, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        a.ctx.sessionId,
        a.ctx.playerId,
        a.ctx.turnId ?? null,
        a.tool_name,
        JSON.stringify(args ?? null),
        a.result === undefined ? null : JSON.stringify(a.result),
        a.error,
        a.durationMs,
      ],
    );
  } catch (err) {
    // Audit must never bring down the turn. Log and continue.
    console.error('[tools] audit insert failed', err);
  }
  telemetry.record({
    channel: 'gameplay',
    name: 'tool.invocation',
    sessionId: a.ctx.sessionId,
    playerId: a.ctx.playerId,
    turnId: a.ctx.turnId ?? null,
    data: {
      tool_name: a.tool_name,
      args,
      result: a.result ?? null,
      error: a.error,
      duration_ms: a.durationMs,
    },
  });
}

function redactSensitiveToolArgs(toolName: string, args: unknown): unknown {
  if (
    toolName !== 'narrate' ||
    args == null ||
    typeof args !== 'object' ||
    Array.isArray(args)
  ) {
    return args;
  }
  const record = args as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'internal_monologue')) {
    return args;
  }
  return {
    ...record,
    internal_monologue: '[redacted]',
  };
}

function toHistoryArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (args === undefined) return {};
  return { value: args };
}

function recordToolHistory(
  ctx: ToolContext,
  entry: Omit<ToolHistoryEntry, 'batch_id' | 'operation_id'>,
): void {
  const fullEntry: ToolHistoryEntry = {
    ...entry,
    ...(ctx.batchId ? { batch_id: ctx.batchId } : {}),
    ...(ctx.operationId ? { operation_id: ctx.operationId } : {}),
  };

  const append = () => {
    const session = sessionManager.get(ctx.sessionId);
    const activeTurn = session?.activeTurn;
    if (!activeTurn) return;
    if (
      ctx.turnId &&
      ctx.turnId !== activeTurn.turnId &&
      !ctx.turnId.startsWith(`${activeTurn.turnId}:`)
    ) {
      return;
    }
    activeTurn.toolHistory = activeTurn.toolHistory ?? [];
    activeTurn.toolHistory.push(fullEntry);
  };

  if (onTransactionCommit(append)) return;
  append();
}

// Helpers shared across tools.

export function isLegacyCurrentPlayerToken(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const normalized = normalizeCurrentPlayerToken(input);
  return LEGACY_CURRENT_PLAYER_TOKENS.has(normalized);
}

function normalizeCurrentPlayerToken(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

const LEGACY_CURRENT_PLAYER_TOKENS = new Set<string>([
  // Intentionally empty. Current-player targeting is by omitted player
  // arg (ctx.playerId) or explicit player_id, not localized aliases.
]);

export async function resolvePlayerTarget(
  input: string | number | null | undefined,
  ctx: Pick<ToolContext, 'playerId'>,
  opts: { allowCrossPlayer?: boolean; argName?: string } = {},
): Promise<number> {
  const argName = opts.argName ?? 'player';
  let resolved: number | null = null;

  if (input == null || isLegacyCurrentPlayerToken(input)) {
    resolved = ctx.playerId;
  } else if (typeof input === 'string') {
    const active = await query<{ display_name: string }>(
      `SELECT display_name FROM entities WHERE id = $1 AND kind = 'player'`,
      [ctx.playerId],
    );
    const activeName = active.rows[0]?.display_name;
    if (
      activeName &&
      normalizeCurrentPlayerToken(input) ===
        normalizeCurrentPlayerToken(activeName)
    ) {
      resolved = ctx.playerId;
    } else {
      resolved = await resolveEntityId(input);
    }
  } else {
    resolved = input;
  }

  if (resolved == null) {
    throw new ToolExecutionError(`unknown ${argName}: ${String(input)}`, {
      rejected: true,
      suggestion: {
        player_id: ctx.playerId,
        omit_player_arg: true,
        reason: 'use_current_player_id',
      },
    });
  }

  const player = await query<{ entity_id: number; display_name: string }>(
    `SELECT p.entity_id, e.display_name
       FROM players p
       JOIN entities e ON e.id = p.entity_id
      WHERE p.entity_id = $1`,
    [resolved],
  );
  if (player.rows.length === 0) {
    throw new ToolExecutionError(`entity ${resolved} is not a player`, {
      rejected: true,
      suggestion: {
        player_id: ctx.playerId,
        omit_player_arg: true,
        received_entity_id: resolved,
        reason: 'target_must_be_player',
      },
    });
  }

  if (!opts.allowCrossPlayer && resolved !== ctx.playerId) {
    throw new ToolExecutionError(
      `${argName} resolved to another player (${player.rows[0]!.display_name}, id ${resolved}); omit the player argument or use player_id=${ctx.playerId} for this session`,
      {
        rejected: true,
        suggestion: {
          player_id: ctx.playerId,
          omit_player_arg: true,
          rejected_entity_id: resolved,
          reason: 'cross_player_mutation_denied',
        },
      },
    );
  }

  return resolved;
}

/** Parse a "Foo Name" or numeric id and return numeric entity id. */
export async function resolveEntityId(
  input: string | number,
  opts?: { playerId?: number | null },
): Promise<number | null> {
  if (typeof input === 'number') return input;
  if (opts?.playerId != null && isLegacyCurrentPlayerToken(input)) {
    return opts.playerId;
  }
  const raw = input.trim();
  const byNum = Number(raw);
  if (!isNaN(byNum) && byNum > 0) return byNum;
  const withoutAt = raw.replace(/^@+/, '').trim();
  const sourceSlug = slugifyEntityRef(withoutAt || raw);
  const r = await query<{ id: number }>(
    `SELECT id
       FROM entities
      WHERE display_name = $1
         OR display_name = $2
         OR profile->>'source_slug' = $3
      ORDER BY CASE
        WHEN display_name = $1 THEN 0
        WHEN display_name = $2 THEN 1
        ELSE 2
      END
      LIMIT 1`,
    [raw, withoutAt, sourceSlug],
  );
  return r.rows[0]?.id ?? null;
}

function slugifyEntityRef(value: string): string {
  return value
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
