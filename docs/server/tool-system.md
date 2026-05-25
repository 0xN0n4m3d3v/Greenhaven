# Tool system

Tools are the broker's API to the world. Every state mutation, every dice roll,
every memory write, every narrate call goes through the tool registry. Schemas
are Zod; the AI SDK gets `zodToJsonSchema` output. Every execution is audited in
`tool_invocations`. Pre-tool validators (Movement Warden, Voice Warden,
Cartridge Steward, Finalization Guards) run between schema validation and
execution.

Read-only world-sensing tools (`summarize_relationships`, `get_recent_history`,
`evaluate_social_standing`, `predict_consequence`) use the same dispatch and
audit boundary but do not directly mutate gameplay tables.

`batch_mutate_world` also uses this boundary for every child operation. The
parent tool resolves deterministic conflicts first, then executes each child
with `executeTool()` so standalone schemas, normalizers, pre-tool validators,
and child audit all still run.

## registerTool

Source:
[packages/web-server/src/tools/base.ts:96-104](../../packages/web-server/src/tools/base.ts#L96-L104).

```ts
registerTool({
  name: 'award_xp',
  description: 'Grant a player some XP for a stated reason.',
  paramsSchema: z.object({...}),
  execute: async (args, ctx) => Promise<TResult>,
});
```

Each `tools/*.ts` file calls `registerTool` at module scope. The whole registry
is wired by **side-effect import** from
[packages/web-server/src/tools/index.ts](../../packages/web-server/src/tools/index.ts):

```ts
import './entity.js';
import './runtime.js';
import './inventory.js';
// ...
```

When
[packages/web-server/src/index.ts:39](../../packages/web-server/src/index.ts#L39)
imports `'./tools/index.js'`, every tool module loads transitively and registers
itself. By the time Hono starts handling requests, the central
`Map<string, ToolDefinition>` is populated.

`getRegisteredTools()` returns a read-only view; the broker passes that map to
`runBroker` which converts each definition into either an executable AI SDK tool
(default) or a _handoff_ tool (`narrate` only).

Throws if the same name is registered twice — registration is
single-source-of-truth.

## dispatch

Source:
[packages/web-server/src/tools/base.ts:147-244](../../packages/web-server/src/tools/base.ts#L147-L244).

```ts
async function dispatch(toolName, rawArgs, ctx): Promise<ToolResult>;
```

Steps:

1. **Lookup.** Unknown tool → audit + return
   `{ok:false, error: "unknown tool: …"}`. Never throws.
2. **Zod validate.** `def.paramsSchema.safeParse(rawArgs)`. On failure:
   stringify the issues into `path: message; …` and return as
   `{ok:false, error: "invalid args: …"}`. Audit. The structured error gives the
   LLM precise feedback ("which arg was wrong") so retries converge.
3. **Pre-tool validators.** `PRE_TOOL_VALIDATORS.get(toolName) ?? []` — runs
   each in order. First reject wins; subsequent validators don't run. Validator
   throws fail open (call proceeds, warning logged).
4. **Execute.** Wrap `def.execute(argsForRun, ctx)` in try/catch. Audit either
   the result or the error. Never throws out of dispatch.
5. **Audit.** Insert into `tool_invocations` (see below).

The agent loop never sees an exception — it sees `ToolResult`. That keeps tool
errors as a _signal_ rather than a transport-layer fault.

`StopExecution` (sentinel error) — thrown by tools that want to terminate the
agent loop (e.g. `narrate(done=true)`). `executeTool()` audits it as
`{ok:true, stopped:true}`; the AI SDK adapter may re-catch the propagated
sentinel and return the same stopped result to the model loop. Defined at
[packages/web-server/src/tools/base.ts](../../packages/web-server/src/tools/base.ts).

Before validators run, a tool may optionally canonicalize parsed args with
`def.normalizeArgs(parsed.data)`. Keep this hook narrow: model-facing tools
should expose one canonical argument shape, and compatibility aliases should not
be added just because the model invented a key.

## ToolContext

Source:
[packages/web-server/src/tools/base.ts:30-56](../../packages/web-server/src/tools/base.ts#L30-L56).

```ts
interface ToolContext {
  sessionId: string;
  playerId: number;
  turnId?: string;
  signal?: AbortSignal;
  toolHistorySource?: 'ai_sdk' | 'direct' | 'batch_child';
  batchId?: string;
  operationId?: string;
}
```

Carried via Node's `AsyncLocalStorage`
([packages/web-server/src/tools/base.ts:42-46](../../packages/web-server/src/tools/base.ts#L42-L46)):

```ts
const contextStorage = new AsyncLocalStorage<ToolContext>();

export function runWithContext<T>(ctx, fn): Promise<T> {
  return contextStorage.run(ctx, fn);
}

export function currentToolContext(): ToolContext {
  /* throws if missing */
}
```

`startTurnV2` wraps each turn in
`runWithContext({sessionId, playerId, turnId, signal}, runTurn)`
([packages/web-server/src/turnRunnerV2.ts:134-137](../../packages/web-server/src/turnRunnerV2.ts#L134-L137)).
Every tool fired transitively — including ones invoked by other agents (Movement
Warden, Voice Warden) — reads the same context. Tools that need `playerId` (e.g.
for per-player overlay writes) call `currentToolContext().playerId`; nothing has
to be threaded through call chains.

Calling `currentToolContext()` outside `runWithContext` throws — this is
intentional, it catches bugs where a tool is fired from outside the turn
pipeline.

## Pre-tool validators

`PreToolValidator` shape
([packages/web-server/src/tools/base.ts:122-129](../../packages/web-server/src/tools/base.ts#L122-L129)):

```ts
type PreToolValidator = (
  toolName,
  args,
  ctx,
) => Promise<{ ok: true } | { ok: false; reason: string; suggestion?: object }>;
```

Validators are registered per tool name via
`registerPreToolValidator(toolName, fn)`
([packages/web-server/src/tools/base.ts:133-140](../../packages/web-server/src/tools/base.ts#L133-L140)).
Multiple validators can register for the same tool; first reject wins.

Currently registered (loaded by
[packages/web-server/src/tools/index.ts](../../packages/web-server/src/tools/index.ts)):

- **Cartridge Steward** (spec 48) — pre-tool on `create_entity` and
  `create_quest`. Deterministic; checks script fit, near-duplicates, and
  required spawn fields. `create_quest.goal_text` is optional after spec 64, so
  the Steward validates it only when present. Implementation:
  [packages/web-server/src/agents/cartridgeSteward.ts](../../packages/web-server/src/agents/cartridgeSteward.ts).
- **Movement Warden** (spec 51) — pre-tool on `narrate`. Hard rejection of
  narrator-driven teleports — if narrate prose places the player at a location
  that's not `current_location_id` AND `move_player` wasn't called this turn,
  reject with a structured suggestion. Order matters: Movement runs first
  (game-state correctness > UX). Implementation:
  [packages/web-server/src/agents/movementWardenPreTool.ts](../../packages/web-server/src/agents/movementWardenPreTool.ts).
- **Voice Warden** (spec 54/92) — pre-tool on `narrate`. Deterministic
  structural checks run without provider keys, then the semantic Voice Warden
  handles broader multilingual voice/author mismatch. Returns a "split into two
  narrate calls" suggestion. Runs after Movement (UX clarity). Implementation:
  [packages/web-server/src/agents/voiceWardenPreTool.ts](../../packages/web-server/src/agents/voiceWardenPreTool.ts).
- **Finalization Guards** (spec 92) — pre-tool on mutation tools. Failed
  same-turn `inventory_transfer` blocks canon-writing tools until a later
  transfer succeeds, and AI SDK broker tool loops have a mutation budget before
  they must call `narrate`. Implementation:
  [packages/web-server/src/agents/finalizationGuards.ts](../../packages/web-server/src/agents/finalizationGuards.ts).

A reject returns:

```ts
{ok: false, error: <reason>, rejected: true, suggestion?: {...}}
```

The broker reads `rejected: true` and the `suggestion` and retries with
corrected args. The validators are idempotent — the same broker call with the
same args produces the same verdict, so a second retry that ignores the
suggestion just gets rejected again.

Validators that throw fail open (call proceeds, only a warning logged). The
fail-open contract matches the rest of the specialist roster: a broken validator
can never block a turn.

## Audit (tool_invocations)

Every tool execution — successful or not — writes one row to `tool_invocations`.
The AI SDK adapter and direct `dispatch()` calls share the same execution
boundary, so schema validation, compatibility argument normalization, pre-tool
validators, execution, and audit happen in one place:

```ts
executeTool(toolName, rawArgs, ctx);
```

That shared path prevents the broker/narrator AI SDK route from bypassing
Movement Warden, Voice Warden, or Cartridge Steward.

Broker `narrate` is special in stage 1: it is a handoff request, not an executed
tool. If the stage-2 narrator does not execute the real `narrate` tool and the
runner persists prose through `synthesiseNarrate()`, Spec 75 records a synthetic
`tool_invocations` row with `tool_name='narrate'` and
`result.source='narrator_synth_fallback'`. This audits the final visible bubble
without double-counting real executable `narrate` calls.

Every execution writes:

| Column        | Source                                                    |
| ------------- | --------------------------------------------------------- |
| `session_id`  | `ctx.sessionId`                                           |
| `player_id`   | `ctx.playerId`                                            |
| `turn_id`     | `ctx.turnId ?? null`                                      |
| `tool_name`   | `def.name` (or rawArgs's intended name on `unknown_tool`) |
| `args`        | JSON of validated args (or raw args if validation failed) |
| `result`      | JSON of return value, or `null` on error                  |
| `error`       | error message, or `null` on success                       |
| `duration_ms` | wall-clock from dispatch entry to return                  |

Implementation:
[packages/web-server/src/tools/base.ts:255-276](../../packages/web-server/src/tools/base.ts#L255-L276).

Sensitive tool args are redacted at the shared audit boundary. As of spec 64,
`narrate.internal_monologue` is replaced with `[redacted]` in
`tool_invocations.args` for successful calls, validator rejections, schema
errors, and execution errors. The hidden text is stored only in
`chat_messages.payload.internal_monologue` when `narrate` itself persists the
message.

Audit is **fail-soft**: if the insert itself fails (DB offline, schema drift),
the error is logged but the dispatch's return value is unchanged. Audit must
never bring down the turn.

Uses:

- Spec 22 quest objective evaluator reads `tool_invocations` to match
  `tool_called` predicates.
- `/api/debug/tools` endpoint at
  [packages/web-server/src/index.ts:1542](../../packages/web-server/src/index.ts#L1542)
  lists recent invocations for diagnostics.
- Pre-tool rejection reasons land here as `error: "rejected: <reason>"` so
  post-hoc audit can see what got blocked.

Spec 67 also records active-turn tool history at this shared boundary. Entries
carry `{name,args,ok,result?,error?,source,batch_id?,operation_id?}`. The AI SDK
adapter marks calls as `source='ai_sdk'`, direct dispatch defaults to `direct`,
and `batch_mutate_world` child calls use `batch_child` plus an `operation_id`.
When a call runs inside a DB transaction, the history append is deferred to the
transaction commit hook so rolled-back child successes do not reach post-turn
specialists.

Helper: `resolveEntityId(input: string | number): Promise<number | null>` at
[packages/web-server/src/tools/base.ts:281-290](../../packages/web-server/src/tools/base.ts#L281-L290)
— accepts a numeric id, a stringified number, or a display name; resolves to
numeric entity id. Used by every tool that takes "entity-or-name" arguments to
keep prompt-side prose flexible.

## Batch Transactions

Spec 65 extends `withTransaction()` with AsyncLocalStorage-backed transaction
context. While a batch is active, shared `query()` calls route through the
current transaction client. If a child tool calls `withTransaction()` itself, it
reuses the active transaction instead of opening a nested `BEGIN`. ARCH-16
(2026-05-15) refines that "reuse" into an explicit `SAVEPOINT` per nested call
so an inner failure caught by the parent rolls back only the nested block's
writes — see [`docs/backend/transactions.md`](../backend/transactions.md) for
the full contract including commit/rollback hook scoping.

This lets existing tools participate in atomic batch rollback without changing
their call sites. Failed atomic batches roll back child DB writes and child
audit rows; the parent `batch_mutate_world` audit row remains outside the child
transaction and records the failure.

Spec 66 adds transaction hooks to the same context. `SseBridge.emit()` defers
events emitted during a transaction until the commit hook runs; rollback drops
them. Events outside a DB transaction still use the normal immediate fan-out and
preconnect buffer.

Spec 67 reuses those commit hooks for `activeTurn.toolHistory`: committed batch
child operations become visible to Quest Watcher, Catalogue Scout, NPC Voice,
Dialogue Anchor, and Movement Warden, while rolled-back child operations are not
included in the turn snapshot.

## Sources

- [packages/web-server/src/tools/base.ts](../../packages/web-server/src/tools/base.ts)
  — `registerTool`, `dispatch`, `ToolContext`, pre-tool validators, audit
- [packages/web-server/src/tools/index.ts](../../packages/web-server/src/tools/index.ts)
  — registry side-effect imports + validator registration
- [packages/web-server/src/tools/batchMutate.ts](../../packages/web-server/src/tools/batchMutate.ts)
  — batch parent tool
- [packages/web-server/src/tools/conflictResolver.ts](../../packages/web-server/src/tools/conflictResolver.ts)
  — deterministic batch conflict checks
