/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Convert our Zod-schema ToolDefinitions into AI SDK Tool objects.
// Two flavours:
//   - executableTool: real execute() that runs the registered tool's executor
//   - handoffTool:    no execute, emits the tool-call only — used for the
//                     broker→narrator handoff via stopWhen: hasToolCall

import {tool, type Tool} from 'ai';
import {z} from 'zod';
import {tryParseJsonWithinCap} from '../jsonSalvage.js';
import {
  currentToolContext,
  executeTool,
  StopExecution,
  type ToolDefinition,
} from '../tools/base.js';

/**
 * Some chat-tuned models (DeepSeek-V4-style) occasionally emit tool
 * `arguments` as a JSON-encoded string instead of an object. AI SDK's
 * default `inputSchema` then rejects with `Invalid input ... JSON parsing
 * failed`. Pre-parse the string before the original schema validates:
 * if input is a string that looks like JSON, parse it; otherwise pass
 * through. Schema-driven validation then runs normally on the parsed
 * object. This covers every tool, not just `narrate`.
 *
 * AI-1 — the parse runs through `tryParseJsonWithinCap`, so any
 * candidate longer than `MAX_JSON_SALVAGE_CHARS` (128 KiB) falls
 * through to the raw-string path without invoking `JSON.parse`.
 * The downstream Zod validator still rejects the string with its
 * existing error.
 *
 * The cost when input is already an object: one `typeof` check — nil.
 */
export function stringJsonSalvage(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  const parsed = tryParseJsonWithinCap(trimmed);
  return parsed.ok ? parsed.value : value;
}

function withStringSalvage(schema: ToolDefinition['paramsSchema']) {
  return z.preprocess(stringJsonSalvage, schema as z.ZodTypeAny);
}

/**
 * Wrap a ToolDefinition into an AI SDK Tool that actually executes.
 * Audits to tool_invocations using the same shape as the legacy adapter.
 */
export function executableTool(def: ToolDefinition): Tool {
  return tool({
    description: def.description,
    inputSchema: withStringSalvage(def.paramsSchema),
    execute: async (input: unknown, _opts: unknown) => {
      const ctx = currentToolContext();
      try {
        const result = await executeTool(
          def.name,
          input,
          {...ctx, toolHistorySource: 'ai_sdk'},
          {propagateStopExecution: true},
        );
        return result.ok ? (result.data ?? {}) : result;
      } catch (err) {
        if (err instanceof StopExecution) {
          // Soft signal — narrate(done=true) throws this. v2 narrator
          // stage runs as a single call, so "stop" is just "we're done".
          return {ok: true, stopped: true};
        }
        throw err;
      }
    },
  });
}

/**
 * Wrap a ToolDefinition WITHOUT an executor — for the handoff narrate
 * tool. AI SDK emits a tool-call event but doesn't execute anything.
 * Combined with stopWhen: hasToolCall(name), the streamText call halts.
 */
export function handoffTool(def: ToolDefinition): Tool {
  return tool({
    description: def.description,
    inputSchema: withStringSalvage(def.paramsSchema),
    // no execute on purpose — see spec 03 docs
  });
}
