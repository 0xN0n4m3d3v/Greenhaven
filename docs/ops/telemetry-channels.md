# Telemetry channels (ARCH-2)

The telemetry facade lives in `packages/web-server/src/telemetry/`.
Callers should import `telemetry`, `createTelemetry`, and (when wrapping a
phase) `measure` from `packages/web-server/src/telemetry/index.js` instead
of touching the per-sink modules directly.

`telemetry.record(event)` is **non-throwing** and **fire-and-forget**. The
facade tracks pending dispatches so tests/shutdown can await
`telemetry.flush()`. Sink rejections are swallowed and logged to stderr.

## Channels

| Channel       | Donor sink                                  | What goes here                                                 | Retention                       |
| ------------- | ------------------------------------------- | -------------------------------------------------------------- | ------------------------------- |
| `gameplay`    | `appendGameplayLog` (ops JSONL append)      | Coarse, human-readable turn/quest/world ops log.               | JSONL files on disk (rotated).  |
| `performance` | `recordPerformanceEvent` (`performance_events`) | Phase timings, status/error, CPU/RSS/heap snapshots, kind+phase. | DB; pruned by `applyTelemetryRetention`. |
| `turn`        | `recordTurnTelemetry` (`turn_telemetry`)    | Per-role LLM call accounting (tokens, cost, duration, tier).   | DB; pruned by retention.         |
| `frontend`    | `recordTelemetryEvent` (`telemetry_events`) | Server-emitted UI-side analytics events.                       | DB telemetry lake.               |
| `desktop`     | `recordTelemetryEvent` (`telemetry_events`) | Desktop-wrapper lifecycle / shell events.                      | DB telemetry lake.               |

Frontend/desktop **ingestion** (the `/api/telemetry/frontend|desktop`
batch endpoints) still flows through `TelemetryIngestionService` and
lands in `recordTelemetryEvent` directly. The facade is for events the
server itself emits.

## Event-name matrix

| Channel       | Event name                                      | Emitter                                  |
| ------------- | ----------------------------------------------- | ---------------------------------------- |
| `gameplay`    | `http.error`                                    | `index.ts` app.onError                   |
| `gameplay`    | `http.request`                                  | `index.ts` request middleware            |
| `gameplay`    | `http.request.error`                            | `index.ts` request middleware            |
| `gameplay`    | `session.ready`                                 | `SessionLifecycleService`                |
| `gameplay`    | `location.snapshot`                             | `SessionLifecycleService`                |
| `gameplay`    | `turn.input`                                    | `SessionLifecycleService`                |
| `gameplay`    | `turn.queued`                                   | `SessionLifecycleService`                |
| `gameplay`    | `turn.start`                                    | `turnRunnerV2.startTurnV2`               |
| `gameplay`    | `turn.failed`                                   | `turnRunnerV2` (failure catch)           |
| `gameplay`    | `turn.cancelled`                                | `turnRunnerV2` (reset/cancel)            |
| `gameplay`    | `turn.finished`                                 | `turnRunnerV2` (finally)                 |
| `gameplay`    | `turn.player_message.persisted`                 | `turnRunnerV2.runTurn`                   |
| `gameplay`    | `turn.output`                                   | `tools/narrate.ts`                       |
| `gameplay`    | `narrate.sanitiser.inspected`                   | `tools/narrate/register.ts` (direct narrate) **+** `narrationSynthesis.ts:synthesiseNarrate` (synth-v2 fast path — live desktop traffic) — both via shared `tools/narrate/sanitiserTelemetry.ts` (N-2 Phase 3 liveness — every runtime narrate; JSONL + `telemetry_events` mirror) |
| `gameplay`    | `narrate.sanitiser.fired`                       | `tools/narrate/register.ts` (direct narrate) **+** `narrationSynthesis.ts:synthesiseNarrate` (synth-v2 fast path — live desktop traffic) — both via shared `tools/narrate/sanitiserTelemetry.ts` (N-2 Phase 1 — changed-text only; JSONL + `telemetry_events` mirror) |
| `gameplay`    | `tool.invocation`                               | `tools/base.ts` audit                    |
| `gameplay`    | `player.move`                                   | `tools/movement.ts`                      |
| `gameplay`    | `player.move.noop`                              | `tools/movement.ts`                      |
| `gameplay`    | `gui.event.stored` / `gui.event.released`       | `guiEventOutbox.ts`                      |
| `gameplay`    | `error.first_entry_location_event`              | `turnRunnerV2.runTurn`                   |
| `gameplay`    | `error.post_turn_hook`                          | `postTurnPipeline`                       |
| `gameplay`    | `error.npc_initiative_enqueue`                  | `postTurnPipeline` (agency)              |
| `gameplay`    | `error.npc_agency_evaluator`                    | `postTurnPipeline` (agency)              |
| `gameplay`    | `post_turn.start_next_queued_failed`            | `postTurnPipeline` (S-3)                 |
| `gameplay`    | `broker.pre_broker_hook_failed`                 | `turnBrokerStage` (S-3)                  |
| `gameplay`    | `broker.empty_output_retry`                     | `turnBrokerStage` (S-3)                  |
| `gameplay`    | `broker.empty_output_fail_open`                 | `turnBrokerStage` (S-3)                  |
| `gameplay`    | `broker.mutation_limit_retry`                   | `turnBrokerStage` (S-3)                  |
| `gameplay`    | `broker.mutation_limit_retry_failed`            | `turnBrokerStage` (S-3)                  |
| `gameplay`    | `broker.mutation_limit_retry_empty`             | `turnBrokerStage` (S-3)                  |
| `gameplay`    | `sse.preconnect_buffer_drop`                    | `sseBridge` (S-4)                        |
| `gameplay`    | `error.adventure_ignore_hook_payload`           | `AdventureService`                       |
| `gameplay`    | `error.adventure_ignore_consequence`            | `AdventureService`                       |
| `gameplay`    | `error.adventure_ignore_thread_evidence`        | `AdventureService`                       |
| `gameplay`    | `telemetry.write_failed`                        | `agents/questPacer`, `quest/questTransitionArbiter` |
| `gameplay`    | `gameplay:density_depth_cap_hit`                | `density/index.ts` (`rebuildLocalDensity`)          |
| `performance` | `turn.watchdog`                                 | `turnRunnerV2.runWithTurnWatchdog`       |
| `performance` | `turn.prompt_budget`                            | `turnBrokerStage`                        |
| `performance` | `turn.intimacy_empty_broker_fallback`           | `turnBrokerStage`                        |
| `performance` | `turn.combat_negotiation_empty_broker_fallback` | `turnBrokerStage`                        |
| `performance` | `turn.scene_item_pickup_fallback`               | `turnBrokerStage`                        |
| `performance` | `turn.broker_tools_no_visible_output_fallback`  | `turnBrokerStage`                        |
| `performance` | `turn.narrator_bypass`                          | `turnBrokerStage`                        |
| `performance` | `tool.<name>` (per-tool perf sample)            | `tools/base.ts`                          |
| `performance` | `gui.event_released`                            | `guiEventOutbox.ts`                      |
| `performance` | `post_turn.<hookName>`                          | `presentationScheduler.ts`               |
| `performance` | `llm.classify_intent`, `llm.classify_mode`      | `turnRouting.ts` (via `measure`)         |
| `performance` | `source_grounding.rewritten`                    | `agents/combatDirectorGrounding`         |
| `turn`        | `turn.role.broker`                              | `turnBrokerStage`                        |
| `turn`        | `turn.role.narrator`                            | `turnBrokerStage`                        |
| `turn`        | `turn.role.narrator-scripted`                   | `turnNarrationStage`                     |
| `turn`        | `turn.role.<narrator|narrator-scene-painter|narrator-painter-fallback>` | `turnNarrationStage` |

## Excluded from facade migration

- **Sink-internal**: `gameplayLog.ts`, `performanceTelemetry.ts`,
  `turnTelemetry.ts`. These modules are the donor implementations the
  facade routes to; their internal calls (process-level
  uncaught/unhandled handlers in `installGameplayProcessLoggers`, the
  sampled `measurePhase`/`recordPerformanceEvent` inside
  `recordTurnTelemetry`) stay where they are.
- **Inbound batch ingestion**: `routes/telemetry.ts` →
  `services/TelemetryIngestionService.ts` →
  `recordTelemetryEvent`/`recordTelemetrySpan`/`recordTelemetryMetric`/`indexTelemetryArtifactFile`.
  This is the `/api/telemetry/{frontend,desktop}` boundary that records
  events received from clients; it is not a server-side emitter.
- **Custom SQL into `turn_telemetry`**: `presentationScheduler.ts`
  writes presentation-slot rows directly via SQL because the
  `turn_telemetry` schema has slot-specific columns (`slot_id`,
  `slot_key`, `slot_status`, `deadline_ms`, `expired`) that the
  facade's typed `turn` channel does not expose. The neighbouring
  `recordPerformanceEvent` call IS migrated.
- **Devtool/scripts**: `scripts/live-playtest-diagnose.ts` reads
  `turn_telemetry` rows for diagnostic dumps; it does not emit events.

## Authoring guidance

- Pick the channel by **what** the event is, not where it lives. Player-
  facing gameplay log → `gameplay`. DB-backed timing/status → `performance`.
  LLM call accounting → `turn`. UI/desktop emitted analytics → `frontend`
  or `desktop`.
- `name` is the canonical event identifier. Keep it stable; downstream
  dashboards and ops tooling key off it.
- Always include `sessionId`/`turnId` when known; the facade does not
  fabricate them.
- For wrapped phases prefer `measure({...input}, fn)` from
  `telemetry/index.js` so duration/CPU/RSS/error classification stay
  automatic.
- Sink failures must remain opaque to the turn loop. If you need to
  know whether a sink succeeded (e.g. for shutdown ordering) call
  `telemetry.flush()` and let it settle.

## `gameplay:density_depth_cap_hit` payload (M-4)

`density/index.ts:rebuildLocalDensity` reads warn rows from
`migration_diagnostics` after every SQL rebuild and emits **at most one**
aggregate event when truncation actually occurred. Pure SQL callers still
write the rows; only the wrapper forwards them onto the telemetry facade.

```
{
  channel: 'gameplay',
  name:    'gameplay:density_depth_cap_hit',
  data: {
    target_cartridge:             <string>,
    depth_cap:                    8,
    warning_count:                <number>,
    truncated_child_count_total:  <number>,
    root_ids:                     <number[]>
  }
}
```

The wrapper snapshots `MAX(migration_diagnostics.id)` before the rebuild
and only forwards rows added after that snapshot whose payload's
`target_cartridge` matches the rebuilt cartridge — concurrent rebuilds
for other cartridges stay isolated. A depth-8 alignment with no deeper
descendants stays silent: only real truncation produces the warn row,
and therefore the telemetry event.

## S-3 pipeline catch/retry events

Each turn-pipeline catch/retry path emits a `gameplay`-channel event so
the rotated JSONL ops log has a structured row instead of just a
`console.warn`. The shared shape:

```
{
  channel: 'gameplay',
  name:    <event-name>,
  sessionId, playerId, turnId,
  error:   <unknown — passed through to the gameplay sink which
            normalises Error to {name, message, stack}>,
  data: {
    stage:               <pipeline-stage slug>,
    raw_message:         <Error.message or String(err)>,
    hook_name?:          <only for hook-keyed paths>,
    mode?:               <turn mode>,
    broker_tool_profile?:<broker tool profile or null>,
    attempt?:            <1 | 2 — broker retry index>,
    retry_directive?:    'recovery_directive' | 'mutation_limit_warning',
    mutation_limit?:     <MAX_MUTATION_TOOLS>,
    fallback?:           'fail_open_narration' | 'synth_fallback'
  }
}
```

`broker.empty_output_retry` carries the captured error from the first
broker call. `broker.empty_output_fail_open` carries the retry's error
and is paired with the synthesised fail-open narration. The mutation-
limit retry emits up to three events: `broker.mutation_limit_retry`
(entry), then either `broker.mutation_limit_retry_failed` (retry call
threw) or `broker.mutation_limit_retry_empty` (retry returned with no
narrate). When the retry both throws and produces no narrate, both
follow-up events fire.

## Narrate sanitiser firings (N-2 Phase 1 + Phase 3)

`packages/web-server/src/tools/narrate/register.ts` records two
gameplay-channel events per runtime narrate call:

1. **`narrate.sanitiser.inspected`** (N-2 Phase 3 liveness signal) —
   fires on **every** runtime narrate call after
   `sanitiseNarrateTextWithReport(...)`, including clean output. The
   payload is strictly metadata so we can count it cheaply without
   leaking prose. Shape:

   ```
   {
     channel: 'gameplay',
     name:    'narrate.sanitiser.inspected',
     sessionId, playerId, turnId,
     data: {
       source:                'narrate_tool',
       changed:               boolean,
       pattern_count:         number, // total patterns the report logged
       phase3_pattern_count:  number, // subset that block Phase 3 deletion
       original_length:       number,
       sanitised_length:      number,
     },
   }
   ```

2. **`narrate.sanitiser.fired`** (N-2 Phase 1) — fires only when the
   sanitiser actually changed the narrator text (`changed: true` in
   the report). The payload carries `patterns_fired` plus a
   200-char `original_prefix` for the dashboard. Shape:

   ```
   {
     channel: 'gameplay',
     name: 'narrate.sanitiser.fired',
     sessionId, playerId, turnId,
     data: {
       source:           'narrate_tool',
       patterns_fired:   SanitiserPatternId[],
       original_length:  number,
       sanitised_length: number,
       original_prefix:  string, // capped at 200 chars; never the full narrator output
     },
   }
   ```

`SanitiserPatternId` is one of `wrapper_unwrap`, `analysis_heading`,
`stanislavski_label_bold`, `stanislavski_label_plain`, `bracket_meta`,
`json_wrapper_unwrap`, `paragraph_dedup`. Pattern ids appear in
pipeline order; multiple ids per event are expected when the narrator
chained several leaks.

**Runtime emitters (both call the same `recordNarrateSanitiserTelemetry`
helper in `tools/narrate/sanitiserTelemetry.ts` so the event shape
cannot drift):**

1. `tools/narrate/register.ts` — the direct narrate tool, used when
   the broker calls `narrate({...})`. Emits with `source: 'narrate_tool'`.
2. `narrationSynthesis.ts:synthesiseNarrate` — the synth-v2 fast path
   the broker takes on narrate-handoff plus the empty/fallback synth
   turns. **Live desktop traffic almost always lands here, NOT
   through `register.ts`**, which is why this path was the missing
   wire that left the N-2 readiness gate stuck at `inspected_events: 0`
   even after representative narrate traffic. Emits with
   `source: 'narrate_synthesis'` and an extra `synth_source` field
   carrying the `SynthesiseNarrateSource` value (e.g.
   `broker_narrate_fast_path`) so audits can correlate readiness
   counts with the specific synth-v2 origin.

Non-runtime callers of the plain `sanitiseNarrateText(...)` wrapper
(`turnContext/dialogueContext.ts`, `devtools/supportSmoke.ts`,
`__tests__/turnContext/dialogueHistorySanitiser.test.ts`) stay
intentionally telemetry-silent — they don't produce visible-prose
runtime output and must not pollute the gate.

**Storage / mirror.** The default gameplay sink writes JSONL via
`gameplayLog.ts`. The N-2 Phase 3 readiness report queries
`telemetry_events`, so `Telemetry.ts` carries a small whitelist
(`GAMEPLAY_LAKE_MIRROR_EVENTS`) that mirrors **only**
`narrate.sanitiser.inspected` and `narrate.sanitiser.fired` into the
telemetry lake alongside the JSONL append. Every other gameplay
event keeps its JSONL-only retention semantics. Mirrored rows carry
`category: 'gameplay'`, `redactionTier: 'tier1_local_debug'`, and
`source: 'narrate_tool'` (the lake's `source` column is fixed by the
mirror; the per-event `source` discriminator
`'narrate_tool'`/`'narrate_synthesis'` lives in the `properties`
JSONB payload).

**Gate logic.** N-2 Phase 3 deletion of the runtime
Stanislavski/meta regexes is allowed only when, over a representative
window: (a) `inspected_events > 0` proves the sanitiser code path is
reachable, AND (b) `phase3_total === 0` proves none of
`analysis_heading`, `stanislavski_label_bold`,
`stanislavski_label_plain`, `bracket_meta` fired. The previous
"`total_events > 0` (i.e. firings) AND `phase3_total === 0`" gate
left a hole because `total_events` could legitimately be zero on a
healthy sanitizer with clean traffic — that hole is closed by
counting inspected events instead.

**Local-soak vs. regex-deletion readiness.** The readiness gate above
is necessary but not sufficient for deleting the runtime
Stanislavski/meta regex pipeline entries. The packaged-desktop soak
driver (`packages/desktop-electron/scripts/n2-phase3-soak.ps1`)
distinguishes two questions, both computed by the shared helper
`packages/web-server/src/devtools/narrateSanitiserDeletionReadiness.ts`
and surfaced in every `driver-summary.json`:

1. **`local_soak_passed`** — the per-run sanity gate: readiness gate
   passing, `new_inspected_events ≥ MinInspectedEvents`,
   `new_phase3_total === 0`, no failed / cancelled / timed-out /
   submit-failed turns, no forced shutdown, every configured language
   completed at least once. Used to decide whether a single packaged
   soak run is internally consistent.
2. **`ready_for_regex_deletion`** — `local_soak_passed` AND the
   evidence covers ≥ `MinCartridges` distinct cartridges AND
   ≥ `MinModelFamilies` distinct model families. Used to decide
   whether removing the runtime regexes is safe. A single packaged
   desktop soak ships ONE cartridge and exercises ONE model family
   per run, so `ready_for_regex_deletion` stays false by default
   (defaults: `MinCartridges = MinModelFamilies = 2`) until evidence
   from additional cartridges / families is collected.

`deletion_blockers` and `soak_blockers` in the artifact are arrays of
stable strings (e.g. `cartridges_attempted_below_min:1/2`) suitable for
pasting verbatim into master-plan entries. The artifact-only CLI
`tsx src/scripts/n2-phase3-deletion-readiness.ts --artifact <path>...`
re-evaluates the same policy across one or more
`driver-summary.json` files without re-launching the desktop EXE — use
it to aggregate evidence from multi-cartridge / multi-family runs
collected on different days.

## Quest-engine gameplay events (QE-7)

`packages/web-server/src/quest/questEngine.ts` previously emitted
operational `console.log` / `console.warn` lines from every quest
state-change branch. Those calls are now structured `gameplay`-channel
telemetry routed through the same facade. The shared shape:

```
{
  channel: 'gameplay',
  name:    <event-name>,
  sessionId, playerId, turnId,
  error?:  <unknown — only set for resolver / dispatch failures>,
  data: {
    quest_id:         <player_quests.quest_entity_id>,
    quest_title:      <entities.display_name>,
    current_stage_id: <stage id at the moment the event fired>,
    ...branch-specific keys
  }
}
```

Event names emitted by `evaluateActiveQuests(...)`:

- `quest.failed` — fires AFTER the failure `withTransaction(...)`
  commits. `data.failure_kind` carries the matched failure-condition
  kind or `'timeout'` when `accumulated_state.timeout_failure` was set
  by `tickQuestTimers`.
- `quest.advance_on_invalid` — fires on `resolveAdvanceMode` throw.
  `data.raw_advance_on` is the offending stage value; the top-level
  `error` field carries the thrown error. The quest is then skipped
  without further mutation.
- `quest.choice.invalid_pick` — `accumulated_state.pending_choice`
  named a target that is not in the stage's options array.
  `data.picked_stage_id` is the offending value. Non-mutating.
- `quest.choice.illegal_transition` — the picked branch is in the
  options array but `isLegalQuestStageTransition(...)` rejected it.
  `data.picked_stage_id`, `data.next_stage_id`. Non-mutating.
- `quest.choice_required` — fires AFTER the awaiting-choice
  `withTransaction(...)` commits. `data.options` mirrors the
  `quest:choice_required` GUI event payload (label +
  `target_stage_id` per option) so an operator can correlate the
  telemetry row with the UI affordance.
- `quest.stage.prerequisite_blocked` — a next-stage prerequisite
  objective is not satisfied. `data.next_stage_id`, `data.detail`.
  Non-mutating.
- `quest.stage.illegal_transition` — `isLegalQuestStageTransition(...)`
  rejected a normal-advance `next_stage`. `data.from`, `data.to`.
  Non-mutating.
- `quest.advanced` — fires AFTER the normal-advance
  `withTransaction(...)` commits. `data.next_stage_id`.
- `quest.completed` — fires AFTER the bottom auto-completion
  `withTransaction(...)` commits.

State-change success events (`quest.failed`, `quest.advanced`,
`quest.completed`, `quest.choice_required`) are intentionally
positioned outside the surrounding `withTransaction(...)` callback,
so a rollback never leaves a misleading "succeeded" telemetry row in
the gameplay log. Non-mutating branches (`*.invalid_*`,
`prerequisite_blocked`, `illegal_transition`, `advance_on_invalid`)
fire before the per-quest `continue` and never reach a transaction.

## `sse.preconnect_buffer_drop` payload (S-4)

`SseBridge` queues every event into a per-session preconnect buffer
when no subscriber is connected yet. The buffer caps at 200 entries; a
push that would exceed the cap evicts the oldest event. The eviction
itself is unchanged from the pre-S-4 behavior, but the bridge now
emits a bounded `gameplay`-channel telemetry event so an operator can
spot a session that overflows its preconnect window.

```
{
  channel: 'gameplay',
  name:    'sse.preconnect_buffer_drop',
  sessionId,
  data: {
    stage:              'sse_preconnect_buffer',
    dropped_total:      <cumulative count of dropped events>,
    dropped_event_type: <the evicted SseEvent.event, e.g. 'content'>,
    dropped_event_id:   <the evicted SseEvent.id ?? null>,
    buffer_limit:       200,
    buffer_size:        200
  }
}
```

The throttle is "first drop, then every 10th drop after that" — once
the cap is first hit (`dropped_total === 1`) and then on each
`dropped_total % 10 === 0`. A session that drains its preconnect
buffer and then re-enters the unsubscribed state does not reset the
counter; one bridge instance lives for the lifetime of one
`Session`.
