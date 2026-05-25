# Specialists Overview

A specialist is a narrow LLM or deterministic support step that owns one runtime
concern: combat calibration, intimacy phase, quest pacing, duplicate entity
checks, voice consistency, adventure generation, or presentation order. The
broker remains the turn authority; specialists provide briefings, validators, or
post-turn side effects.

## Current Wiring

| Mode                 | When                                         | Owner                                                         | Examples                                                                                                                                                             |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-broker briefing  | Before broker generation                     | `turnBrokerStage.ts` with hooks declared in `turnRunnerV2.ts` | Combat Director, Intimacy Coordinator, Reward Calibrator                                                                                                             |
| Pre-tool validator   | Between schema validation and tool execution | `tools/base.ts` via `registerPreToolValidator()`              | Movement Warden, Voice Warden, Cartridge Steward, damage/source/finalization guards                                                                                  |
| Narration override   | Narrator tier selection                      | `turnNarrationStage.ts`                                       | Scene Painter, scripted narrator, narrator fallback                                                                                                                  |
| Post-turn pipeline   | After the visible turn result                | `postTurnPipeline.ts`                                         | Quest Watcher, Catalogue Scout, NPC Voice, Dialogue Anchor, Movement Warden observer, Quest Pacer, Adventure Oracle, Adventure Materializer, Companion Depart Engine |
| Turn-start transform | Before player-row presentation               | `turnRunnerV2.ts`                                             | Protagonist Action Renderer, currently disabled by design                                                                                                            |

`postTurnPipeline.ts` owns presentation barriers, deterministic slot release,
NPC initiative, and promotion of queued turns after the barrier closes or
expires.

## Fail-Open Contract

All specialists fail open. `runSpecialist()` applies common timeout, telemetry,
JSON parsing, and Zod validation. If a specialist times out, throws, or returns
malformed output, the caller treats the result as "no opinion" and continues
with broker-default behavior.

Pre-tool validators are stronger than advisory specialists. They can reject a
tool call with a reason and suggestion; the broker then retries with corrected
arguments. They still do not mutate world state directly.

## Active Roster

| Spec  | System                      | Mode                          | Doc                                                              |
| ----- | --------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| 39    | Quest Watcher               | Post-turn                     | [quest-watcher.md](quest-watcher.md)                             |
| 40    | Combat Director             | Pre-broker, combat            | [combat-director.md](combat-director.md)                         |
| 41    | Intimacy Coordinator        | Pre-broker, intimacy          | [intimacy-coordinator.md](intimacy-coordinator.md)               |
| 42    | Catalogue Scout             | Post-turn                     | [catalogue-scout.md](catalogue-scout.md)                         |
| 43    | Per-NPC Voice Engine        | Post-turn                     | [per-npc-voice-engine.md](per-npc-voice-engine.md)               |
| 44    | Scene Painter               | Narration override            | [scene-painter.md](scene-painter.md)                             |
| 45    | Dialogue Anchor             | Post-turn                     | [dialogue-anchor.md](dialogue-anchor.md)                         |
| 46/51 | Movement Warden             | Post-turn + pre-tool          | [movement-warden.md](movement-warden.md)                         |
| 47    | Reward Calibrator           | Pre-broker, reward turns      | [reward-calibrator.md](reward-calibrator.md)                     |
| 48    | Cartridge Steward           | Pre-tool create guards        | [cartridge-steward.md](cartridge-steward.md)                     |
| 49    | Quest Pacer                 | Post-turn                     | [quest-pacer.md](quest-pacer.md)                                 |
| 52/53 | Companion system            | Tool + post-turn              | [companion-system.md](companion-system.md)                       |
| 54    | Voice Consistency Warden    | Pre-tool `narrate`            | [voice-warden.md](voice-warden.md)                               |
| 77    | Protagonist Action Renderer | Disabled turn-start transform | [protagonist-action-renderer.md](protagonist-action-renderer.md) |
| 89    | Adventure Oracle            | Post-turn queue proposal      | Spec 89                                                          |
| 90    | Adventure Materializer      | Queue-worker specialist       | [adventure-materializer.md](adventure-materializer.md)           |

The base adapter is documented at [base-adapter.md](base-adapter.md).

## Sources

- [packages/web-server/src/agents/base.ts](../../packages/web-server/src/agents/base.ts)
- [packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts)
- [packages/web-server/src/turnBrokerStage.ts](../../packages/web-server/src/turnBrokerStage.ts)
- [packages/web-server/src/turnNarrationStage.ts](../../packages/web-server/src/turnNarrationStage.ts)
- [packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts)
- [packages/web-server/src/tools/base.ts](../../packages/web-server/src/tools/base.ts)
