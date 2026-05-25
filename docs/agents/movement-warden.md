# Movement Warden (specs 46 + 51)

The Movement Warden has two parts that share one prompt: a **pre-tool
validator** (spec 51) on `narrate` that hard-blocks narrator-driven teleports,
and a **post-turn observer** (spec 46) that emits an advisory
`movement:teleport_detected` SSE if a teleport slipped through. Together they
enforce the Movement Warden contract from
[packages/web-server/prompts/greenhaven.md:67](../../packages/web-server/prompts/greenhaven.md#L67).

## Goal

Stop the narrator from placing the player at a location they aren't actually at.
Concrete failure mode: player says "I look toward the docks", broker forgets to
call `move_player`, narrator writes "you walk down the wet planks of @The Docks"
— now the prose says the player IS at the docks but `current_location_id` still
points at the previous location. The next preamble desyncs, locations sidebar
lies, scripted actions on the new location can't fire.

The Warden detects `@`-mentioned locations in the prose, filters to
`kind='location'`, drops the current location, then either:

- (Pre-tool, spec 51) blocks the `narrate` dispatch with a structured
  `{rejected: true, suggestion}`. Broker reads the suggestion and retries —
  either calls `move_player` first OR rewrites the prose to _reference_ the
  location without placing the player there.
- (Post-turn, spec 46) emits `movement:teleport_detected` SSE so the EventCard
  can warn future-broker. Defense-in-depth for the pre-tool fail-open path.

See [design/movement-rules.md](../design/movement-rules.md) for the full
contract.

## Mode

Two modes:

| Layer                           | Spec | Mode                                                |
| ------------------------------- | ---- | --------------------------------------------------- |
| Pre-tool validator on `narrate` | 51   | blocking — `registerPreToolValidator('narrate', …)` |
| Post-turn observer              | 46   | async post-turn pipeline                            |

Pre-tool registered at
[packages/web-server/src/tools/index.ts:42](../../packages/web-server/src/tools/index.ts#L42).
Order matters: Movement runs **before** Voice Warden — game-state correctness >
UX.

Post-turn hook is owned by
[packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts).

## Output schema

Pre-tool validator schema at
[packages/web-server/src/agents/movementWardenPreTool.ts:44-53](../../packages/web-server/src/agents/movementWardenPreTool.ts#L44-L53):

```ts
{
  flagged: [{ location_id: number, reason: string }, ...]   // max 5
}
```

When `flagged.length > 0` the validator returns:

```ts
{
  ok: false,
  reason: "narrator teleport blocked: …",
  suggestion: {
    flagged_location_id: number,
    action: "Either call move_player(target_location_id=<id>, intent_source='user_command') first, or rewrite the narrate so the player STAYS at their current location and the other location is referenced as a destination/topic — not a place they ARE."
  }
}
```

Post-turn observer outputs the same schema; the `flagged` set drives the
advisory SSE.

## Where it's wired

- Pre-tool:
  [packages/web-server/src/agents/movementWardenPreTool.ts](../../packages/web-server/src/agents/movementWardenPreTool.ts)
  — `registerMovementWardenPreToolValidator()` exported and called at module
  load by
  [packages/web-server/src/tools/index.ts:42](../../packages/web-server/src/tools/index.ts#L42).
- Post-turn:
  [packages/web-server/src/agents/movementWarden.ts](../../packages/web-server/src/agents/movementWarden.ts) -
  `movementWardenHook` imported by
  [packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts).
- Both share the same
  [packages/web-server/src/agents/movementWardenPrompt.ts](../../packages/web-server/src/agents/movementWardenPrompt.ts).
- Mention extraction: `extractMentionsAnyScript(text)`
  ([packages/web-server/src/agents/movementWarden.ts](../../packages/web-server/src/agents/movementWarden.ts))
  — Unicode-aware `\p{L}\p{N}` regex so it picks up `@<Name>` in any script.
- Pre-tool also reads `tool_invocations` for THIS turn — if `move_player`
  already fired with `target_location_id` matching any candidate, the placement
  is legitimate (no LLM call, pass).
- `move_player` tool at
  [packages/web-server/src/tools/movement.ts](../../packages/web-server/src/tools/movement.ts)
  is the canonical state-mutating call.
- Debug runner: `POST /api/debug/run-movement-warden` at
  [packages/web-server/src/index.ts:546](../../packages/web-server/src/index.ts#L546).

## Failure & fail-open

Pre-tool validator:

- Any throw inside `detect()` → `console.warn` + `{ok: true}` (the call passes).
  The post-turn observer is still around as defense-in-depth.
- Timeout: 4500ms hard cap on the LLM call so a hung specialist never deadlocks
  a player turn.
- No `@`-mentions in the prose → fast pass at
  [packages/web-server/src/agents/movementWardenPreTool.ts:79-80](../../packages/web-server/src/agents/movementWardenPreTool.ts#L79-L80).
- All mentions are the current location → fast pass; the prose is just talking
  about where they ARE.
- `move_player` already fired this turn → fast pass (legitimate move).

Post-turn observer:

- `runSpecialist` returns null → no warning SSE; player is unaffected.
- The prose has already shipped — observer can't undo it. The next turn's broker
  reads the cumulative location state and self-corrects.

The fail-open contract is the broker's full Movement Warden rule in
`prompts/greenhaven.md` — even with both Wardens broken, the prompt still tells
the broker to call `move_player` before placing the player elsewhere.

## Prompt

Source:
[packages/web-server/src/agents/movementWardenPrompt.ts](../../packages/web-server/src/agents/movementWardenPrompt.ts).

System covers:

- Multilingual mention extraction (any script: Latin, Cyrillic, CJK,
  Devanagari).
- "Player is AT vs player IS REFERENCING" — the contract. The LLM judges whether
  the prose places the player at a location or merely names it as a destination.
- The two suggestion outputs: call `move_player`, or rewrite prose. Validator is
  idempotent — same inputs return same verdict.
- The shared prompt is intentional: same multilingual semantic check whether
  we're rejecting at pre-tool time or warning post-turn.

`maxOutputTokens: 400` — the JSON list of flagged locations is short.

## Sources

- [packages/web-server/src/agents/movementWardenPreTool.ts](../../packages/web-server/src/agents/movementWardenPreTool.ts)
  — pre-tool validator (spec 51)
- [packages/web-server/src/agents/movementWarden.ts](../../packages/web-server/src/agents/movementWarden.ts)
  — post-turn observer (spec 46), mention extractor
- [packages/web-server/src/agents/movementWardenPrompt.ts](../../packages/web-server/src/agents/movementWardenPrompt.ts)
  — shared system prompt
- [packages/web-server/src/tools/movement.ts](../../packages/web-server/src/tools/movement.ts)
  — `move_player` tool
- [packages/web-server/plans/execution-roadmap/specs/46-movement-warden.md](../../packages/web-server/plans/execution-roadmap/specs/46-movement-warden.md)
- [packages/web-server/plans/execution-roadmap/specs/51-movement-warden-hard-rejection.md](../../packages/web-server/plans/execution-roadmap/specs/51-movement-warden-hard-rejection.md)
