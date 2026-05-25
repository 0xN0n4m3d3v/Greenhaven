# Turn Pipeline

Every player command enters the same queue-backed runtime path. `turnRunnerV2`
still owns session-level orchestration, but broker execution, narration, and
post-turn work are now split into smaller modules.

## Entry Flow

```text
POST /api/session/:id/turn
  -> turn_ingress_queue
  -> startTurnV2 when promoted
  -> guard input + apply deterministic pre-work
  -> resolve route/tier/mode
  -> reconcile dialogue focus/participants for this player intent
  -> build context + role prompts/toolsets
  -> narrator-only path or broker path
  -> persist visible narrate result
  -> runPostTurnPipeline
  -> release gui_events slots
  -> promote next queued turn
```

Queued player text is hidden until its row is promoted. This prevents the chat
timeline from showing a player bubble for work that has not started.

## Turn Preparation

At the start of a promoted turn, the runner:

- wraps the run in `runWithContext()` so tools can read `sessionId`, `playerId`,
  `turnId`, abort state, transaction context, and SSE buffering;
- guards prompt-injection-shaped input without blocking player speech;
- applies quest choice routing, condition/surface decay, world clock ticks, and
  active quest evaluation;
- accepts matching natural-language adventure hooks and expires stale queued
  opportunities;
- reconciles dialogue focus: `npc:<id>` switches focus, travel/non-dialogue
  actions release ordinary local NPC focus, explicit farewell releases focus,
  and active companions can remain focused across movement;
- resolves selected language from turn input or `players.preferred_language`;
- builds static cartridge context and dynamic per-turn context.

## Routing

`resolveTurnRoute()` classifies tier and mode. T0 is scripted quick-action
narration. T1-T3 are narrator-only routes for low-risk prose. T4 is the broker
path for combat, intimacy, dialogue, travel, explicit mutation, and any turn
that may need tools.

Modes are `exploration`, `combat`, `intimacy`, `dialogue`, `travel`, and `rest`.
Mode controls broker prompt fragments and mode-filtered tool exposure.

Quick-action ids refine routing. `location:<id>` prevents a location mention
from being mistaken for direct NPC address and routes as travel. `npc:<id>`
routes as dialogue. Adventure ids (`adventure.accept:<queueId>` and
`adventure.ignore:<queueId>`) claim/cancel the exact queue row before prompt
construction, then the normal broker/narrator path generates the follow-up.

## Prompt And Tool Selection

The prompt loader builds role-scoped prompts:

- common contract from `prompts/greenhaven.md`;
- broker fragments from `prompts/broker/*.md`;
- narrator contract from `prompts/greenhaven.narrator.md`.

Toolsets are also scoped. Narrator and Scene Painter receive only executable
`narrate`; the broker receives a mode-filtered gameplay toolset.

## Broker Stage

`turnBrokerStage.ts` runs pre-broker hooks, invokes the broker, retries empty
responses, and fail-opens with a recovery directive when necessary.

Current pre-broker hooks:

- Combat Director for combat calibration.
- Intimacy Coordinator for intimacy phase/beat state.
- Reward Calibrator for quest reward turns.

Broker `narrate` is a handoff request, not the narrator tool execution. If the
broker already provides safe visible text, the runtime can persist it through a
fast synth path; otherwise the narrator stage receives the handoff.

## Narration Stage

`turnNarrationStage.ts` owns visible prose:

- T0: scripted narrator path with thinking disabled.
- T1: broker model as cheap narrator.
- T2: Scene Painter with fallback.
- T3: full narrator.
- T4: broker handoff to narrator or synth fallback.

Narrator output is quarantined when it looks like JSON/tool dumps, control text,
or unsafe POV leakage. Hidden `narrate.internal_monologue` stays payload-only
and is not streamed or copied into player-facing chat.

## Tool Execution

All tool calls go through `dispatch()` in `tools/base.ts`: Zod validation,
pre-tool validators, execution, audit rows, SSE buffering, and transaction-aware
child history.

Important validators include Movement Warden, Voice Warden, Cartridge Steward,
damage d20/source grounding, and finalization guards. A validator can reject
with `{rejected: true, suggestion}` so the broker can retry with corrected
arguments.

## Dialogue Context

The focused partner remains `players.dialogue_partner_id`. Multi-speaker
context lives in `players.metadata.dialogue_participants` and is rendered as
`## DIALOGUE PARTICIPANTS`. Active companions are included in that block even
when the current turn is not focused dialogue, so shared chats work while the
party moves through locations. Each authored speaker still requires its own
`narrate` call; the context block is not permission to merge voices.

## Post-Turn Pipeline

After the visible turn result, `runPostTurnPipeline()` starts async systems from
`postTurnPipeline.ts`:

- Quest Watcher
- Catalogue Scout
- Per-NPC Voice Engine
- Dialogue Anchor
- Movement Warden observer
- Quest Pacer
- Adventure Oracle
- Adventure Materializer
- Companion Depart Engine
- NPC initiative evaluator

Hooks run behind a presentation barrier. Chat-visible post-turn output reserves
durable `gui_events` slots and releases by slot ordinal, so a fast later hook
cannot appear before a slow earlier hook. Queue promotion happens after the
barrier closes or expires.

## Diagnostics

Turn lifecycle, tool results, narrator quarantine, presentation slots,
performance spans, and telemetry-lake events are persisted for support. Use
session diagnostics, support smoke, and telemetry report commands from the ops
docs when investigating stuck turns or provider failures.

## Sources

- [packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts)
- [packages/web-server/src/turnRouting.ts](../../packages/web-server/src/turnRouting.ts)
- [packages/web-server/src/turnBrokerStage.ts](../../packages/web-server/src/turnBrokerStage.ts)
- [packages/web-server/src/turnNarrationStage.ts](../../packages/web-server/src/turnNarrationStage.ts)
- [packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts)
- [packages/web-server/src/tools/base.ts](../../packages/web-server/src/tools/base.ts)
