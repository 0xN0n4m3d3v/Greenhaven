# Architecture

Greenhaven is a TypeScript workspace with three active runtime packages:

- `packages/web-server` - Hono API, DB, model pipeline, tools, specialists.
- `packages/web-ui` - Vite/React client, SSE bridge, chat timeline, rails.
- `packages/desktop-electron` - packaged local desktop shell.

## Pipeline Overview

```text
POST /api/session/:id/turn
  -> turn_ingress_queue row
  -> startTurnV2 when no active turn/barrier blocks it
  -> guard input, quest choice, condition/surface/clock ticks
  -> dialogue focus reconciliation + adventure accept/ignore/expiry
  -> resolveTurnRoute: tier, mode, context scope
  -> buildTurnContext(static + dynamic)
  -> role-scoped prompt/toolset selection
  -> T0/T1/T2/T3 narrator path OR T4 broker path
  -> narrate/synth fallback persists chat
  -> runPostTurnPipeline
  -> gui_events presentation slots + queued turn promotion
```

## Turn Routing

`resolveTurnRoute()` classifies each turn into tier and mode. Scripted quick
actions are T0. T1-T3 are narrator-only paths for non-mutating narrative.
Combat, intimacy, dialogue, travel, and explicit mutation intents are forced
through T4 broker routing when tools may be needed.

Modes are `exploration`, `combat`, `intimacy`, `dialogue`, `travel`, and `rest`.
Mode controls broker prompt fragments and mode-specific tool exposure.

`actionId` is part of routing, not just UI metadata. `npc:<id>` forces a
dialogue focus switch, `location:<id>`/travel actions force travel handling, and
adventure action ids (`adventure.accept:<queueId>`,
`adventure.ignore:<queueId>`) claim or cancel the exact queue row before the
broker sees the turn.

## Prompt And Tool Scope

Prompt ownership is split:

- `greenhaven.md` - common identity and shared contract.
- `prompts/broker/*.md` - broker mechanics, selected by mode through
  `BROKER_PROMPT_FRAGMENT_MANIFEST`.
- `greenhaven.narrator.md` - visible prose and narration contract.
- `greenhaven.broker.md` - compatibility index telling maintainers not to
  restore the old catch-all broker prompt.

Tool ownership is also scoped. Narrator and Scene Painter receive only
`narrate`; the broker receives a mode-filtered gameplay toolset from
`toolsForBrokerMode()`.

## Broker

The broker stage owns mechanics. It receives context, pre-broker specialist
briefings, a mode-specific prompt, and a mode-specific toolset. It can call
tools, request `narrate`, or fail open through a recovery directive if the model
returns empty output twice.

Broker `narrate` is a handoff request. If it already includes visible text, the
server can persist it through a fast synth path. Otherwise the narrator receives
the handoff and must call the real executable `narrate` tool.

## Narrator

The narrator stage owns player-visible prose. T0 uses broker-as-narrator with
thinking off. T1 reuses the broker model for cheap acknowledgement. T2 can use
Scene Painter with fallback. T3 uses the full narrator model. T4 follows broker
handoff.

Narration is quarantined when it looks like tool syntax, JSON dumps, control
text, or unsafe POV leakage. Synth fallback persists cleaned prose only when no
visible `narrate` message was created.

## Specialists

Pre-broker hooks currently include Combat Director, Intimacy Coordinator, and
Reward Calibrator. Pre-tool validators include Cartridge Steward, Movement
Warden, Voice Warden, and Finalization Guards.

Post-turn specialists are owned by `postTurnPipeline.ts`: Quest Watcher,
Catalogue Scout, NPC Voice, Dialogue Anchor, Movement Warden, Quest Pacer,
Adventure Oracle, Adventure Materializer, and Companion Depart Engine. They run
behind presentation slots so chat-visible events release deterministically.

## Queues And Presentation

Incoming turns write `turn_ingress_queue` first. A queued player input is hidden
until promoted, so the UI never shows a bubble for a turn that has not begun.
After the response, post-turn hooks reserve `gui_events` presentation slots.
Queued rows promote only after chat-visible slots settle or the barrier expires.

Chat-visible system events are durable `gui_events` rows and are replayable
through the session events endpoint. Direct SSE remains for lifecycle, streaming
content, state rails, and developer telemetry.

## Dialogue And Companions

Dialogue has two layers:

- `players.dialogue_partner_id` is the focused partner used by older UI flows,
  narrator fallback, and focused partner context.
- `players.metadata.dialogue_participants` stores the focused partner plus
  secondary participants for shared chats.

Mention scanning, `npc:<id>` actions, `switch_dialogue_partner`, narration
authoring, and route reconciliation update this state. Travel and non-dialogue
actions release ordinary local NPC focus. If the focused NPC is an active
companion in `players.metadata.companions[]`, focus can persist across
movement; companions also render in `## DIALOGUE PARTICIPANTS` so they can
interject or answer local NPCs in their own bubbles.

## Sources

- [packages/web-server/src/turnRunnerV2.ts](../packages/web-server/src/turnRunnerV2.ts)
- [packages/web-server/src/turnRouting.ts](../packages/web-server/src/turnRouting.ts)
- [packages/web-server/src/turnBrokerStage.ts](../packages/web-server/src/turnBrokerStage.ts)
- [packages/web-server/src/turnNarrationStage.ts](../packages/web-server/src/turnNarrationStage.ts)
- [packages/web-server/src/postTurnPipeline.ts](../packages/web-server/src/postTurnPipeline.ts)
- [packages/web-server/src/presentationScheduler.ts](../packages/web-server/src/presentationScheduler.ts)
