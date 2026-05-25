# runSpecialist adapter

Every narrow-prompt LLM specialist wraps its model call through `runSpecialist()` in [packages/web-server/src/agents/base.ts](../../packages/web-server/src/agents/base.ts). The adapter provides one timeout path, one telemetry path, Zod-validated JSON output, and fail-open behavior for provider setup, generation, JSON parse, and schema failure.

Specialists are an optimization, never a dependency. Callers must fall back to broker-default behavior when `null` is returned.

## runSpecialist

Signature:

```ts
async function runSpecialist<TIn, TOut>(
  def: SpecialistDef<TIn, TOut>,
  input: TIn,
  ctx: SpecialistContext,
): Promise<TOut | null>
```

What it does:

1. Runs model selection and prompt construction inside the fail-open block.
2. Picks `def.pickModel ?? defaultModel`. The default is DeepSeek `deepseek-chat` when `DEEPSEEK_API_KEY` is set, otherwise Featherless `mistralai/Mistral-Nemo-Instruct-2407` when `FEATHERLESS_API_KEY` is set.
3. Cascades `ctx.signal` into an internal timeout controller. `def.timeoutMs` defaults to `8000`.
4. Calls `generateText()` with `temperature: 0.3`, `maxOutputTokens: 1200`, and the combined abort signal.
5. Extracts JSON with `safeJsonExtract()`.
6. Validates output with `def.outputSchema.safeParse(json)`.
7. Writes `turn_telemetry` on success and on caught failure. Telemetry write failure is non-fatal.

Provider/model setup failure is caught like any other specialist failure. The return value is `null`; telemetry uses `model_id='unavailable'` when no concrete model id was available.

## SpecialistDef

```ts
interface SpecialistDef<TInput, TOutput> {
  name: string;
  mode: 'blocking' | 'async';
  buildPrompt(input: TInput): {system: string; user: string};
  outputSchema: ZodSchema<TOutput>;
  timeoutMs?: number;
  pickModel?: () => LanguageModel;
  temperature?: number;
  maxOutputTokens?: number;
}
```

Conventions:

- `name` is lowercase-kebab and appears in telemetry as `role='agent:<name>'`.
- `mode` is declarative; actual scheduling comes from the pre-broker, post-turn, or pre-tool registration point.
- `buildPrompt` carries only the specialist's narrow prompt. Do not remove the corresponding safety rules from the broker prompt.
- `outputSchema` is canonical. Schema mismatch returns `null`.

## Contexts

`SpecialistContext`:

```ts
interface SpecialistContext {
  sessionId: string;
  playerId: number;
  turnId: string;
  signal: AbortSignal;
}
```

`ToolContext` now carries the same signal for in-turn tools:

```ts
interface ToolContext {
  sessionId: string;
  playerId: number;
  turnId?: string;
  signal?: AbortSignal;
}
```

`turnRunnerV2` owns the active turn `AbortController` and passes its signal into phase hooks and `runWithContext()`. Pre-tool validators read `ToolContext.signal` and pass it into `runSpecialist()`, with a local fallback signal only for isolated developer/test calls.

## Telemetry row shape

Every `runSpecialist()` call attempts one row in `turn_telemetry`:

| Column | Value |
|---|---|
| `session_id` | `ctx.sessionId` |
| `turn_id` | `ctx.turnId` |
| `role` | `agent:<def.name>` |
| `model_id` | resolved model id when available; otherwise `custom-specialist-model`, `default-specialist-model`, or `unavailable` |
| `thinking` | `false` |
| `input_tokens` | AI SDK usage input tokens, or `0` on failure before generation |
| `output_tokens` | AI SDK usage output tokens, or `0` on failure |
| `cache_hit_tokens` | `0` |
| `cache_miss_tokens` | same as `input_tokens` |
| `duration_ms` | wall-clock elapsed time |
| `cost_usd` | `inputTokens * 0.07e-6 + outputTokens * 0.28e-6` |
| `player_id` | `ctx.playerId` |
| `tier` | `null` |

`/api/debug/cost` can isolate specialist budget with `role LIKE 'agent:%'`.

## Hook Shapes

`PreBrokerHook` returns a briefing string or `null`:

```ts
interface PreBrokerHook {
  name: string;
  run(ctx: SpecialistContext, turnInput: {text: string; mode: string}): Promise<string | null>;
}
```

`PostTurnHook` is side-effect only:

```ts
interface PostTurnHook {
  name: string;
  run(
    ctx: SpecialistContext,
    turnRecord: {
      text: string;
      toolHistory: Array<{name: string; args: unknown; result?: unknown}>;
      narrative: string;
    },
  ): Promise<void>;
}
```

Post-turn hooks are fire-and-forget and fail-open. Their writes can affect the next preamble, but they do not gate the current player response.

## Sources

- [packages/web-server/src/agents/base.ts](../../packages/web-server/src/agents/base.ts)
- [packages/web-server/src/tools/base.ts](../../packages/web-server/src/tools/base.ts)
- [packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts)
