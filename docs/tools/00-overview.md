# Tool system overview

Read-only world-sensing tools live in [world-sensing.md](world-sensing.md):
relationship summaries, recent history, social standing, and consequence
prediction.

Atomic batch mutation lives in [batch-mutation.md](batch-mutation.md). It wraps
allow-listed mutation tools without bypassing their normal schemas, validators,
execution, or audit.

Tools are the broker's API to the world. ~40 of them live in
[packages/web-server/src/tools/](../../packages/web-server/src/tools/), each
registered via `registerTool` at module scope. Schemas are Zod; the AI SDK gets
`zodToJsonSchema` output. Every dispatch is audited in `tool_invocations`.

For the dispatch / validator / audit machinery see
[server/tool-system.md](../server/tool-system.md). This page is for **tool
authors** — what a tool looks like and how to add one.

## Concept

A tool definition is a four-property object:

```ts
{
  name: 'award_xp',
  description: 'Grant a player some XP for a stated reason.',
  paramsSchema: z.object({ player: z.string(), amount: z.number().positive(), reason: z.string() }),
  async execute(args, ctx) { /* … */ return { ok: true, xp_after: … }; }
}
```

Conventions:

- **`name`** — snake_case, globally unique. Surfaces in the broker prompt
  verbatim, in `tool_invocations.tool_name`, and in SSE event names.
- **`description`** — what the model sees. Lead with the _contract_ (what
  changes in DB, what events fire), not the implementation. Multi-line
  descriptions are fine; the AI SDK passes them as-is.
- **`paramsSchema`** — Zod. Validation runs before `execute`. The schema is the
  **truth** about the tool's surface — the broker's tool catalog is generated
  from `zodToJsonSchema`.
- **`execute(args, ctx)`** — receives validated `args` and `ToolContext`
  (`{sessionId, playerId, turnId}`). Returns whatever JSON shape; conventionally
  `{ok, …data}` or throw on logic errors. Throws are caught by `dispatch` and
  surfaced as `{ok: false, error: <message>}`.

A tool is in scope of `runWithContext` (set up by `turnRunnerV2` per turn).
Inside `execute` you can call `currentToolContext()` to read identity. Entity
ids resolve via `resolveEntityId(input)`
([packages/web-server/src/tools/base.ts:281-290](../../packages/web-server/src/tools/base.ts#L281-L290))
— accepts a numeric id, stringified number, or display name.

Tool args are **prose**. Quest titles, summaries, narrate text, memory text —
every player-visible string MUST be in the conversation language. The broker is
told this in
[packages/web-server/prompts/greenhaven.md:15](../../packages/web-server/prompts/greenhaven.md#L15).

## Adding a tool

1. **Pick a file.** `tools/<area>.ts` — combat / movement / inventory / quest /
   etc. Add a new file only if the concern is genuinely orthogonal.
2. **Write the schema.** Be tight: `z.string().min(1)`,
   `z.number().int().min(0)`, `z.enum([...])`. Schema mismatch becomes
   broker-readable feedback so retries converge.
3. **Write the executor.** Use `query` from
   [packages/web-server/src/db.ts](../../packages/web-server/src/db.ts) for SQL,
   `currentToolContext()` for identity. Emit SSE via
   `sessionManager.get(ctx.sessionId)?.sse.emit(…)`.
4. **Call `registerTool({...})`** at module scope.
5. **Wire it in `tools/index.ts`** — add `import './<area>.js';` to
   [packages/web-server/src/tools/index.ts](../../packages/web-server/src/tools/index.ts).
   Order doesn't matter, registration is by side effect.
6. **(Optional) Pre-tool validator.** If the tool needs gating (script check,
   duplicate check, rule enforcement), call
   `registerPreToolValidator('<name>', fn)` at the same spot. See
   [server/tool-system.md](../server/tool-system.md) and
   [agents/cartridge-steward.md](../agents/cartridge-steward.md) for examples.
7. **Test.** Quick path: open the dev DB inspector via `/api/world?entity=<id>`
   to see state changes; watch `/api/debug/session-diag` for invocation traces.

If the tool emits an SSE event that should land as a system EventCard, add the
type name to `SYSTEM_EVENT_TYPES` in
[packages/web-ui/src/bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts)
and the variant rendering to
[packages/web-ui/src/components/chat/EventCard.tsx](../../packages/web-ui/src/components/chat/EventCard.tsx).

## Tool result shape

Three shapes the broker sees, all originating from `dispatch`
([packages/web-server/src/tools/base.ts:147-244](../../packages/web-server/src/tools/base.ts#L147-L244)):

```ts
// success
{ ok: true, data?: <executor return value> }

// schema validation failure or executor throw
{ ok: false, error: "<message>" }

// pre-tool validator rejected
{ ok: false, error: "<reason>", rejected: true, suggestion?: <object> }
```

The broker reads `ok: false` and either retries (with corrected args) or
surfaces the error to the narrator (rare — usually the broker does its own
reasoning).

`rejected: true` is the **structured retry signal** — the suggestion payload
tells the broker exactly how to fix the call. Validators are idempotent, so a
second retry that ignores the suggestion will get rejected again.

`narrate(done=true)` is special: it throws `StopExecution` from inside `execute`
to terminate the agent loop. The dispatcher records the stopped result as
successful tool data unless a caller explicitly asks to propagate the sentinel;
the AI SDK adapter uses that sentinel path to exit the loop cleanly.

Audit: every dispatch — success, validation failure, executor throw, validator
reject — writes one row to `tool_invocations`. Broker `narrate` handoff is not
itself execution, but synth-fallback visible narration is audited as
`tool_name='narrate'` with `result.source='narrator_synth_fallback'`. See
[db/schema.md](../db/schema.md).

## Sources

- [packages/web-server/src/tools/base.ts](../../packages/web-server/src/tools/base.ts)
  — `registerTool`, `dispatch`, `ToolContext`, `resolveEntityId`
- [packages/web-server/src/tools/index.ts](../../packages/web-server/src/tools/index.ts)
  — registry side-effect imports
