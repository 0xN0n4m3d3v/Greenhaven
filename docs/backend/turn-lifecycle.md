# Turn Lifecycle

Authoritative reference for how a single player turn flows through the
web-server. Source-of-truth pointers live at the end; this document is
verified against the live phase exports in
`packages/web-server/src/turn/phases/index.ts` by a focused test
(`packages/web-server/src/__tests__/turn/turnLifecycleDoc.test.ts`).

The whole pipeline is **linear and explicit**. There is no event bus,
no implicit phase dispatch, and no async retry/parallel inside the
runner. The runner sequences phase lists; each phase reads typed state
written by an earlier phase and writes its own typed state for the
next.

## Entry points

- `startTurnV2(session, input)` in
  `packages/web-server/src/turnRunnerV2.ts` is the only public entry.
- It performs five things synchronously before returning a
  `TurnHandle`:
  1. Rejects if `session.activeTurn` is already set.
  2. Allocates `turnId` (preallocated by the queue or a fresh
     `randomUUID().slice(0, 8)`).
  3. Constructs `session.activeTurn` (`turnId`, `queueId`,
     `abortController`, `startedAt`, `language`).
  4. Emits `gameplay:turn.start` telemetry.
  5. Wires the heavy chain through `deferTurnStart(...)` so the
     `TurnHandle` returns to the caller **before** any phase runs.
     This is the USER-2 contract: a caller that subscribes to
     `session.sse.runFor(...)` immediately after the handle returns
     still sees the runner's first SSE event because the SseBridge's
     preconnect buffer is in place by the time the runner starts.

The wrapping chain is:

```
deferTurnStart
  └─ runWithTurnWatchdog         // ./turn/watchdog.ts (abortable timeout)
       └─ runWithContext         // tools/base.js ALS (sessionId/playerId/turnId/signal/turnInputKind)
            └─ measure           // ./telemetry (kind=turn, phase=turn.run)
                 └─ runTurn(session, input, turnId, signal)
```

A rejection from any layer flows through `.catch(...)` on the
`TurnHandle.done` promise:

- Marks `turnFailed = true`.
- Emits `gameplay:turn.failed` with `error_code`, `raw_message`,
  `stack`.
- Calls `markQueueTurnFailed(input.queueId, rawMessage)`.
- Emits a `turn.error` GUI event with a player-friendly message
  derived by `friendlyTurnErrorMessage` (`./turn/friendlyTurnError.ts`),
  **unless** the active turn was already reset.

The `.finally(...)` branch:

- If the turn was reset/cancelled (via `activeTurn.resetRequestedAt`,
  `session.resetTurnIds`, or `session.activeTurn` replacement):
  emits `gameplay:turn.cancelled`, clears the active turn, drops the
  reset flag, and emits `cancelled` over SSE. **No post-turn pipeline
  runs.**
- Otherwise: emits `gameplay:turn.finished` and invokes
  `runPostTurnSafely({ sessionId, playerId, turnId }, () =>
  runPostTurnPipeline({...}))`. `runPostTurnSafely` is the USER-1
  contract — a sync throw or async rejection from the pipeline
  surfaces as a structured `gameplay:post_turn_pipeline.unhandled`
  telemetry event instead of an unhandled rejection that swallows
  turn cleanup.

## TurnContext

Defined in `packages/web-server/src/turn/TurnContext.ts`:

```ts
interface TurnContext {
  readonly session: Session;
  readonly input: TurnInput;       // shallow-copied; phases may rewrite fields
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly state: Record<string, unknown>;  // typed scratch bag
}
```

`createTurnContext({session, input, turnId, signal})` shallow-copies
`input` so the prompt-injection guard can rewrite `input.text` without
leaking the rewritten string back to the caller of `startTurnV2`. Each
phase owns its own state keys; readers should treat foreign keys as
opaque.

## Phase contract

Defined in `packages/web-server/src/turn/Phase.ts`:

```ts
interface Phase {
  readonly name: string;
  run(context: TurnContext): Promise<void>;
}
```

`runPhases(context, phases)` in `turn/TurnLifecycle.ts` iterates
phases sequentially and awaits each. A throw or rejection propagates
to `runTurn`'s caller, which routes it through the runner's
`.catch(...)` path described above. There is no per-phase retry, no
event emission, and no concurrency.

## Phase order

Seven ordered phase lists run in this exact sequence inside `runTurn`.
Every entry below maps one-to-one to an exported `Phase` object in
`packages/web-server/src/turn/phases/index.ts`.

### 1. `preTurnPhases` — preflight + deterministic decay

| Step | Phase                       | Purpose                                                                                                          |
| ---- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1.1  | `promptGuardPhase`          | Wraps player text if a Spec 36 §6 injection pattern matches; may rewrite `context.input.text`.                   |
| 1.2  | `questChoicePhase`          | Routes `quest-choice:<id>:<stage>` actionIds onto `accumulated_state`.                                           |
| 1.3  | `decrementConditionsPhase`  | Spec 17 condition decay.                                                                                         |
| 1.4  | `decrementSurfacesPhase`    | Spec 33 environmental-surface decay.                                                                             |
| 1.5  | `tickWorldClockPhase`       | Spec 32 world-clock tick.                                                                                        |
| 1.6  | `evaluateActiveQuestsPhase` | Spec 22 / USER-3 quest evaluator; reads `session.lastTurnToolHistory` so the previous turn's tools drive ticks. |

Steps 1.2 and 1.6 are paired: routing the choice **before** evaluation
lets the same turn pick up `pending_choice` and advance the quest along
the chosen branch.

### 2. `preRoutePhases` — dialogue auto-engage + adventure intent

| Step | Phase                       | Purpose                                                                                                                                                                       |
| ---- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | `dialogueAutoEngagePhase`   | Sets `session.activeDialoguePartnerId` from any `@`-mention in the player text.                                                                                              |
| 2.2  | `adventureIntentPhase`      | Writes `naturalAdventure` / `ignoredAdventure` results onto `TurnContext.state` under `ADVENTURE_INTENT_STATE_KEY` for later phases to consume.                              |

### 3. `routeResolutionPhases` — scripted action + route classification

| Step | Phase                  | Purpose                                                                                                                                                                                              |
| ---- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | `scriptedActionPhase`  | Resolves any scripted action (chip click / quest choice) and writes `SCRIPTED_ACTION_STATE_KEY`. Includes `contextInjection` when the action steers narrator-only prose.                            |
| 3.2  | `routeResolutionPhase` | Classifies intent/tier/mode/`brokerToolProfile`, reconciles dialogue focus, computes context scope, and writes `ROUTE_RESOLUTION_STATE_KEY` (`{tier, mode, brokerToolProfile, ...}`).                |

Order matters: `routeResolutionPhase` reads
`scripted?.contextInjection` to decide whether to classify at all, and
it consumes the adventure-intent state from step 2.

### 4. `turnContextPreparationPhases` — broker user-prompt assembly

| Step | Phase                 | Purpose                                                                                                            |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 4.1  | `sceneSummaryPhase`   | Snapshots scene state into `SCENE_SUMMARY_STATE_KEY` for the prompt builder.                                       |
| 4.2  | `languagePhase`       | Resolves effective player language and writes `LANGUAGE_STATE_KEY`.                                                |
| 4.3  | `locationVisitPhase`  | Emits the first-entry GUI event for a newly entered location; side-effect only.                                    |
| 4.4  | `contextBuildPhase`   | Calls `buildTurnContext` and writes the bundle under `TURN_CONTEXT_STATE_KEY`.                                     |
| 4.5  | `playerPromptPhase`   | Assembles the consolidated `TurnPreparationResult` (`playerLang`, `userText`, `promptBudgetBreakdown`, render meta, text variants) under `TURN_PREPARATION_STATE_KEY`. |

### 5. `playerMessagePersistencePhases` — chat persistence + SSE

| Step | Phase                            | Purpose                                                                                                                                                                                                                                                                                                                                            |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1  | `playerMessagePersistencePhase`  | Emits `turn.start` SSE marker, persists the player chat message, auto-snapshots the utterance into the active dialogue partner's memory bank, and schedules `message:created` + `turn.player_message.persisted` for after commit. The DB writes are wrapped in `withTransaction(...)`; the state-changing SSE fires through `onTransactionCommit(...)`. |

This is the USER-5 / USER-6 contract — see
[`state-mutation-contract.md`](state-mutation-contract.md) for the
rule that SSE events tied to DB writes must fire after commit, and
[`transactions.md`](transactions.md) for the nesting / SAVEPOINT
semantics that protect this phase.

### 6. `turnDispatchPreparationPhases` — broker prep

| Step | Phase                            | Purpose                                                                                                                                                                                  |
| ---- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1  | `turnDispatchPreparationPhase`   | Resolves tools + system prompts, emits `turn.tier`, `mode:changed`, and `ambient:bed` lifecycle/streaming markers, applies intimacy-rules injection, and writes `TURN_DISPATCH_PREPARATION_STATE_KEY`. |

The SSE emits from this phase are lifecycle/streaming markers, not DB
state changes, and are explicitly annotated with `SSE-OK: emit outside
tx (reason: ...)` per
[`state-mutation-contract.md`](state-mutation-contract.md).

### 7. `turnDispatchPhases` — dispatch

| Step | Phase                | Purpose                                                                                                                                                                                                                                                                                                                                  |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1  | `turnDispatchPhase`  | Reads all prior state (scripted, route, preparation, dispatch prep) and invokes exactly one stage: `runScriptedNarratorStage` when `scripted.contextInjection` is present, `runNarratorOnlyStage` for tier `T1` / `T2` / `T3`, or `runBrokerStage` for `T4`. Writes the chosen `path` under `TURN_DISPATCH_STATE_KEY`. |

Provider resolution (`session.ensureProviders()`) is called at the top
of `runTurn` so the early-fail path for a missing API key aborts the
turn **before** any phase side effects fire. The dispatch phase calls
`ensureProviders()` again; the result is cached, so this is free.

## Specialist surfaces (ARCH-5)

Four phases of orchestration live in the
`SpecialistRegistry`
(`packages/web-server/src/specialists/registry.ts`). Each phase is
registered by side-effect import of `specialists/index.js`:

| Phase                | What it owns                                                                                                                                                                                                                                                                            | Consumer                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `preBroker`          | Broker briefings layered onto the user message before the broker call (combat_director → intimacy_coordinator → reward_calibrator).                                                                                                                                                     | `turnDispatchPhase` → `runBrokerStage` reads `listPreBrokerHooks()`.                          |
| `postTurn`           | The 12 post-turn hooks (quest_watcher, memory_loop_watcher, catalogue_scout, npc_voice, dialogue_anchor, rolling_dialogue_summary, narrative_claim_sweeper, movement_warden, quest_pacer, adventure_oracle, adventure_materializer, companion_depart_engine) with their presentation slots. | `postTurnPipeline.ts` reads `listPostTurnHooks()`.                                            |
| `debugSmoke`         | The 11-entry verify-specialist roster used by `/api/debug/verify-specialists`.                                                                                                                                                                                                            | `services/DebugService.buildVerifyTests` reads `listDebugSmokeSpecialists()`.                 |
| `preToolValidator`   | Pre-tool validators (cartridge_steward × 2, movement_warden.narrate, environment_state × 2, voice_warden.narrate, finalization_guards.<MUTATION_TOOLS>). The same `toolName` may appear multiple times (Movement / Environment / Voice all attach to `narrate`).                          | `tools/index.ts` reads `listPreToolValidatorSpecialists()` and wires each into `tools/base.js`. |

Registration is synchronous, single-process, append-only. Order of
registration is the order returned. The registry has no
`unregister` / `replace` API by design (see ARCH-5 §"Не делать").

`finalizationGuards` registers one validator per entry in
`MUTATION_TOOLS`. **`narrate` is not in `MUTATION_TOOLS`**, so
`finalization_guards.narrate` never registers — `narrate` runs Movement
→ Environment → Voice only.

## Post-turn pipeline

`postTurnPipeline.ts` runs after a successful turn (skipped on
cancellation, see the `.finally(...)` branch above). It:

1. Snapshots `activeTurn.toolHistory` into `session.lastTurnToolHistory`
   so the **next** turn's quest evaluator can read it (USER-3).
2. Filters `listPostTurnHooks()` through
   `shouldSkipPostTurnHookForSnapshot` and the per-hook
   `presentation` shape.
3. Reserves presentation slots, opens the GUI presentation barrier,
   and runs each surviving hook via
   `runPostTurnHookWithPresentation(...)` with the 5-minute fallback
   barrier deadline.
4. Closes/expires the barrier and calls `startNextQueuedTurn(session,
   startTurn)` to promote the next queued turn from
   `turn_ingress_queue`.

All hook mutations follow the
[`state-mutation-contract.md`](state-mutation-contract.md): DB writes
inside `withTransaction(...)`; SSE/telemetry that depend on the write
fire via `onTransactionCommit(...)` (notable: `questPacer` and
`npcVoice` are commit-coupled, and the NPC-agency
`enqueueTurn(...)` runs only after commit so a rolled-back turn can't
spawn an agency turn).

## Watchdog + error handling

- `runWithTurnWatchdog` (`./turn/watchdog.ts`) installs a per-turn
  abort timeout (`config().turnWatchdogMs`). Expiration aborts
  `abortController` and rejects with `TurnAbortedError`. Cancel /
  reset paths instead reject with `TurnCancelledError` or
  `SessionResetDuringTurnError` (see `./turn/errors.ts`).
- Telemetry includes `error_code` from `getTurnErrorCode(err)` so the
  `gameplay:turn.failed` channel distinguishes timeout vs cancel vs
  unexpected.
- `friendlyTurnErrorMessage` (`./turn/friendlyTurnError.ts`)
  translates noisy IO errors (`terminated`, ECONNRESET) into a
  player-visible bubble while keeping the raw message for ops.

## Source-of-truth pointers

- Phase contract: `packages/web-server/src/turn/Phase.ts`
- Turn context: `packages/web-server/src/turn/TurnContext.ts`
- Lifecycle helpers: `packages/web-server/src/turn/TurnLifecycle.ts`
- Phase list: `packages/web-server/src/turn/phases/index.ts`
- Runner: `packages/web-server/src/turnRunnerV2.ts`
- Broker stage: `packages/web-server/src/turnBrokerStage.ts`
  (plus `turn/broker/BrokerInvocation.ts`,
  `turn/broker/BrokerFallbacks.ts`, `turn/brokerEmptyText.ts`)
- Narration stages: `packages/web-server/src/turnNarrationStage.ts`
- Post-turn pipeline: `packages/web-server/src/postTurnPipeline.ts`
- Specialist registry:
  `packages/web-server/src/specialists/registry.ts`
- Specialist side-effect index:
  `packages/web-server/src/specialists/index.ts`
- State-mutation rules:
  [`state-mutation-contract.md`](state-mutation-contract.md)
- Transaction nesting / SAVEPOINTs:
  [`transactions.md`](transactions.md)
- Freshness test (this doc):
  `packages/web-server/src/__tests__/turn/turnLifecycleDoc.test.ts`
