# Live Playtest Findings

## 2026-05-06 - Plot Arc Commerce, Intimacy, And Random Threat

- Severity: P1 before fixes, P2 residual prompt budget.
- Failing baseline:
  `.codex/run-logs/live-playtest/2026-05-06T14-21-18-902Z-cycle/`.
- Final full run:
  `.codex/run-logs/live-playtest/2026-05-06T15-18-24-759Z-cycle/`.
- Final session: `plot-arc-greenhaven-night-20260506-fix-b`.

The `plot-arc-greenhaven-night` pack runs one long story through Mikka, Borek,
scene-item pickup/sale, a random threat, combat negotiation, intimacy with
payment/consent, false completion claims, and a multi-NPC memory recap.

Baseline result: 10 scenarios, 42 broker tool calls, 7 pass and 3 review.
P1 failures:

- `plot-arc-05-sell-scene-relic`: broker called inventory/query tools but no
  `narrate`; repeated transfer failures showed stale duplicate item resolution
  (`insufficient legacy inventory`, `unknown from: null`).
- `plot-arc-08-intimacy-boundary-payment`: broker used `narrate` only for a
  state-changing intimacy/payment beat.
- `plot-arc-10-memory-and-next-move`: broker read history/state but produced no
  visible `narrate`.

Root fixes implemented:

- `inventory_transfer` now resolves items against the source holder first, so
  repeated dynamic items with the same display name do not hit an old
  `legacy_entity_id`.
- Dynamic item materialization and the live control-plane grant path now keep
  canonical item ledger entities aligned with `inventory_entries`.
- Broker outcomes expose tool-call names/counts; if tools ran but no visible
  text exists, `turnBrokerStage` emits a localized no-visible-output fallback.
- Intimacy turns that try to finish with narration only now run the same
  stateful intimacy fallback used for empty provider output.
- `create_quest.spawn_entities[]` exact duplicates are reused instead of
  rejecting the whole quest, so `auto_start=true` still creates `player_quests`.

Verification:

- `npm --prefix packages/web-server run typecheck`
- `npm --prefix packages/web-server run build`
- `npx tsx --env-file=packages/web-server/.env packages/web-server/src/scripts/support-smoke.ts --fixture normal`
- Targeted live cycles for `plot-arc-05`, `plot-arc-08`, `plot-arc-10`, and
  `plot-arc-06`.
- Final full cycle: 10/10 pass, `issueCount=0`, `p0=0`, `p1=0`, 43 broker tool
  calls. `narrate` appeared in every scenario; required state domains passed
  for inventory, adventure queue, `player_quests`, and materialized entities.

Residual P2: prompt/context budget remains high on several turns, including
about 101k broker input tokens on scene-item commerce and 123k on false
completion. This is now a separate performance/context-scope task, not a
blocking gameplay correctness bug.

Follow-up context-budget work:

- Spec:
  `packages/web-server/plans/execution-roadmap/specs/119-broker-state-recap-context-budget.md`.
- State claim/recap turns now route through `state_recap`, a 12-tool focused
  profile. `plot-arc-09-false-completion-claim` dropped from about 123k to
  25.3k broker input tokens. `plot-arc-10-memory-and-next-move` dropped from
  about 81k to 39.8k.
- Commerce/adventure follow-up added `commerce_bargain`, `scene_trade`, and a
  narrower `adventure_accept` profile. Latest clean scene-trade rerun dropped
  the earlier 100k+ spike to 51.2k with 4 broker tool calls and no P0/P1.
- An over-trimmed `scene_trade` attempt caused a P1 payment/order regression:
  the broker transferred the relic before proving buyer payment. The profile now
  keeps buyer inventory visibility and requires payment before item handoff.
- Residual P2 remains for latency/cost. The next root source is the shared base
  broker prompt plus large turn-context payloads and provider tool-loop
  accumulation, not a broad default dialogue toolset.

## 2026-05-06 - Context And Tool Scope Reduction

- Severity: P1 before fixes, P2 residual prompt budget.
- Final run:
  `.codex/run-logs/live-playtest/2026-05-06T11-45-38-337Z-cycle/`.
- Session: `debug-context-scope-20260506-final`.

Goal: reduce broker context and tool scope without making the GM rigid or
breaking creative state changes.

Fixes verified:

- Guidance-only first-minute turns now route to narrator `T2`, not the full
  broker path. `new-player-limited-options` passed with only `narrate`.
- Exploration context no longer carries the full world catalogue; it keeps local
  frame, active quests, and available quests.
- Broker profile `movement_social` reduced travel/follow/private movement turns
  to a focused movement/social toolset. `silent-follow-private-scene`,
  `drag-mikka-to-inn`, and `travel-all-locations-inn` all passed.
- Broker profile `environment_probe` reduced creative physical-scene probes to
  dice/runtime/surface/query/narration tools. `creative-curtain-surface` passed
  with `dice_check`, runtime field mutation, and `narrate`.
- Velvet Booths now has durable runtime fields for `curtain_state` and
  `table_sign_state`. A narrow pre-tool guard blocks prose-only curtain changes
  unless field `2400` is updated first.
- The marathon harness now supports required tool groups and required runtime
  field ids, so state-changing prose without durable tools is caught as a
  backend contract bug.

Final scenario result: 5/5 passed and diagnosis reported no P0/P1 findings.

Residual P2: `prompt_context_budget` remains on several broker turns. The final
run recorded broker inputs around 31k-45k tokens even with narrowed tool
profiles. Next work should target the static broker system prompt and reusable
prompt sections before trimming more local gameplay context.

## 2026-05-06 - Closed Cycle Pipeline And Presence Guard

- Severity: P2 gameplay quality, P2 latency/context budget.
- Runs:
  `.codex/run-logs/live-playtest/2026-05-06T14-31-44-cycle-new-player-no-adventure-slot/`,
  `.codex/run-logs/live-playtest/2026-05-06T14-46-31-cycle-silent-follow-presence-guard/`,
  `.codex/run-logs/live-playtest/2026-05-06T14-53-58-cycle-prompt-budget-recheck/`.

Implemented `live:cycle` as the default loop: marathon, root-cause diagnosis,
cycle report, fix queue, and Gemini review prompt in one run folder. Diagnosis
now treats low GM reactivity as `gm_agency_quality_gap` and large broker inputs
as `prompt_context_budget`.

Fixes verified:

- `new-player-limited-options` no longer runs adventure oracle/materializer
  slots after a basic guidance turn.
- `adventure_materializer` is `non_blocking`, so long card generation no
  longer holds the chat-visible post-turn barrier.
- The silent-follow presence guard rejects materializer blueprints where an
  absent NPC becomes a visible cause, actor, or item holder. The verified run
  emitted only `adventure:oracle_rolled`; the contradictory `adventure:hook`
  was not released to UI and the queue row failed safely.
- The numbered-option detector was corrected so a response with concrete
  actions is not misclassified as low agency.

Residual signal: `silent-follow-private-scene` still shows large broker input
on some runs. New `turn.prompt_budget` performance telemetry records system
prompt chars, user/context chars, and tool count for future prompt-budget
work.

## 2026-05-06 - Continuous Balance Smoke And PGlite Isolation

- Severity: P1 infrastructure, P2 gameplay latency.
- Run:
  `.codex/run-logs/live-playtest/2026-05-06T14-08-41-balance-smoke/`.
- Backend data dir:
  `.codex/run-logs/live-playtest/backend-clean-20260506-140804/pgdata`.
- Session: `debug-balance-smoke-2026-05-06T14-08-41`.
- Turns: `turn-b034b6c4`, `turn-e1e496a4`.

The default dev `packages/web-server/pgdata` started returning
`Aborted(). Build with -sASSERTIONS for more info.` after the earlier long
marathon. Restarting the backend did not recover it. A clean isolated
`PGLITE_DATA_DIR` under run-logs restored health without deleting user/dev
state. Continuous playtests should run against isolated PGlite dirs or managed
Postgres; do not point long adversarial runs at the everyday dev database.

The two-scenario balance smoke passed automatic checks:

- `new-player-limited-options`: axis `balance`, expected `Clarify`, tools
  `narrate`.
- `impossible-item-claim`: axis `core`, expected `No-but`, tools
  `query_player_profile`, `narrate`.

Residual gameplay signal: first turn total trace was about 46s, including
`agent:adventure_materializer` at about 19s after the visible answer. This
suggests the first-minute loop can feel slow because post-turn adventure work
runs immediately after basic guidance. This is not a correctness bug, but it is
part of the "mechanics vs playable GM" balance audit.

## 2026-05-06 - Broker Turn Stalled Past Playable Latency

- Severity: P0 before watchdog, P1 after recovery.
- Run:
  `packages/web-server/.codex/run-logs/live-playtest/2026-05-06T13-41-43-trickster-marathon/`.
- Session: `debug-marathon-2026-05-06T09-41-43-867Z`.
- Turn: `turn-be654411`.

The "new player needs grounded options" turn stayed active for more than four
minutes with no streamed content, no tools, and a running ingress row. It later
completed after about seven minutes; telemetry showed the broker call alone took
about 429s on `deepseek-v4-flash` with roughly 18k input tokens. This is not a
normal slow answer: during the wait the queue is blocked and the player has no
recoverable game action.

Fix path implemented in backend:

- `GREENHAVEN_TURN_WATCHDOG_MS` defaults to 120s and aborts overlong turns.
- The live marathon runner writes `06b-timeout-cancel.json` when its own timeout
  fires.
- `/api/session/:id/cancel` now hard-releases an active turn after a short wait
  and marks the queue row cancelled.
- Late broker/narrator/tool writes check abort/reset/timeout state before
  appending visible session state.

## 2026-05-06 - Silent Follow Into Velvet Booths

- Severity: P1 before guardrail, acceptable after probe.
- Probe: `silent_follow_private_scene`.
- Session: `debug-probe-silent-follow-20260506`.
- Turn: `turn-3eeb09db`.
- Evidence:
  `packages/web-server/.codex/run-logs/live-playtest/2026-05-06T09-18-35-259Z-silent_follow_private_scene/`.

The player silently followed an NPC invitation into `@Velvet Booths`. DeepSeek
called `move_player` as a no-op, kept the room empty, and had Mikka speak from
outside the curtain instead of pretending she was present. This is the desired
GM pattern: preserve the player's unexpected intent while keeping presence
truthful.

## 2026-05-06 - Wrong-Order Quest Claim Hallucinates NPC Presence

- Severity: P1.
- Probe: `quest_chain_wrong_order`.
- Session: `debug-probe-wrong-order-20260506`.
- Turn: `turn-111a208f`.
- Evidence:
  `packages/web-server/.codex/run-logs/live-playtest/2026-05-06T09-19-55-443Z-quest_chain_wrong_order/`.

The player demanded payment for a chain step without collecting or delivering
the required clue. Broker produced prose only; synth fallback stored it as a
location narration. The text made Mikka physically present in `@Velvet Booths`
even though she was not a present candidate and no state mutation brought her
there.

Fix applied: `narrator_synth_fallback` now repairs absent-NPC direct dialogue
under a location author into an honest scene response instead of persisting a
presence contradiction.

Verification:

- Session: `debug-probe-wrong-order-guard-20260506`.
- Turn: `turn-a0ceaef3`.
- Evidence:
  `packages/web-server/.codex/run-logs/live-playtest/2026-05-06T09-22-52-237Z-quest_chain_wrong_order/`.

After the guardrail, the response did not put Mikka in the room. It told the
player the booth is silent and offered grounded next moves. Remaining issue:
broker still did not inspect/advance the quest chain before fallback; quest
claim handling needs more probes after prompt reloads.
