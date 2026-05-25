# Continuous Playtest System

Greenhaven needs continuous gameplay evaluation, not only smoke tests. The goal
is to find where backend mechanics fail and where guardrails make DeepSeek act
like a rules form instead of an improvising game master.

## Test Axes

- **Core mechanics**: quests, inventory, movement, combat, memory, queue order,
  SSE replay, localization, and durable state truth.
- **GM freedom**: creative actions, social tricks, NPC mobility, rumors,
  environmental surfaces, and player attempts outside the expected quest path.
- **Balance**: cases where the correct answer is not pure success or pure
  refusal, but `Yes-and`, `Roll`, `No-but`, or `Clarify`.
- **Regression**: previously fixed runtime bugs, mojibake, stale queue rows,
  English leakage, absent NPC dialogue, and broken fail-open paths.

## Runtime Loop

Run long playtests against an isolated database. Do not use the everyday
`packages/web-server/pgdata` for adversarial marathons; a failed provider or
PGlite abort can leave the dev database unusable for the next run.

```powershell
$run = ".codex/run-logs/live-playtest/backend-clean-$(Get-Date -Format yyyyMMdd-HHmmss)"
$env:PGLITE_DATA_DIR = (Resolve-Path (New-Item -ItemType Directory -Force "$run/pgdata")).Path
$env:GREENHAVEN_TURN_WATCHDOG_MS = "120000"
npm --prefix packages/web-server run dev
```

Use the backend marathon runner for repeated real model sessions:

```powershell
npm --prefix packages/web-server run live:marathon -- `
  --session-id debug-balance-001 `
  --timeout-ms 210000
```

The runner writes artifacts to `.codex/run-logs/live-playtest/<run>/`:

- state before and after each scenario;
- preset/operation payloads;
- submitted turn and settled queue state;
- per-step `BUG_LEDGER.md`;
- top-level `SUMMARY.md` with axis, expected GM outcome, tools, and guardrail
  signals.

Use `--scenarios a,b,c` for focused repros. Use `--stop-on-p0` only when a
single blocking failure would corrupt later evidence; default operation should
continue collecting bugs.

For the current long story regression pack:

```powershell
npm --prefix packages/web-server run live:cycle -- `
  --session-id plot-arc-greenhaven-night-debug `
  --timeout-ms 240000 `
  --scenarios plot-arc-greenhaven-night `
  --allow-findings
```

This pack is the default "does the game actually play?" backend check for
commerce, scene objects, player-authored quests, random threat materialization,
combat negotiation, intimacy consent/payment, false quest claims, and multi-NPC
memory recap.

If the runner times out a turn, it writes `06b-timeout-cancel.json` and tries to
free the queue before continuing. Treat that as a bug, not as a passed scenario.

For the normal bug loop, prefer the closed cycle runner:

```powershell
npm --prefix packages/web-server run live:cycle -- `
  --session-id debug-cycle-001 `
  --timeout-ms 120000 `
  --scenarios new-player-limited-options,silent-follow-private-scene
```

`live:cycle` runs the marathon, runs diagnosis, writes `CYCLE_REPORT.md`, and
generates `GEMINI_REVIEW_PROMPT.md` for a read-only reviewer pass.

For the current no-stop backend development pipeline, use:

```powershell
npm --prefix packages/web-server run live:pipeline -- `
  --scenarios greenhaven-victory-pipeline `
  --timeout-ms 180000
```

`live:pipeline` uses an existing healthy backend or starts an isolated backend
with a run-local `PGLITE_DATA_DIR`, runs `live:cycle --allow-findings`, then
runs backend `typecheck`, `build`, and support smoke without stopping after the
first failed gate. It writes `PIPELINE_REPORT.md` with root causes, rerun
commands, and prompt-budget evidence. Fix the first P0/P1 root cause, rerun
that scenario, then rerun the full pack. P2 prompt-budget findings stay visible
until measured under threshold or explained by bounded tool-loop variance.

## Diagnose And Fix Loop

Every run must have a root-cause pass before code changes. Generate it from the
run folder:

```powershell
npm --prefix packages/web-server run live:diagnose -- `
  --run .codex/run-logs/live-playtest/<run>
```

This writes:

- `ROOT_CAUSE_REPORT.md` - symptoms grouped by likely owner and root cause;
- `ROOT_CAUSE_REPORT.json` - machine-readable diagnosis data;
- `FIX_QUEUE.md` - actionable fixes with first step and rerun command.

Diagnosis categories:

- `turn_runtime_timeout`: provider/runner stall, watchdog, or queue release.
- `queue_recovery_gap`: unfinished running/queued rows after a turn.
- `broker_tool_contract_gap`: state-changing prose without durable tools.
- `tool_exposure_or_prompt_gap`: expected tool missing or ignored.
- `prompt_guardrail_balance`: refusal/mechanics wording killed play.
- `gm_agency_quality_gap`: the answer is technically valid but not playable,
  clever, reactive, or useful as a GM turn.
- `prompt_context_budget`: broker prompt/context/tool scope is too large for
  a responsive live turn.
- `localization_or_encoding`: mojibake, English leakage, or bad fixture text.
- `post_turn_latency_budget`: specialists made a playable turn feel slow.
- `provider_or_db_infrastructure`: PGlite/provider failure outside game logic.

Fix one root cause at a time. After each fix, rerun only the affected scenario
first, then run the wider axis suite. Do not loosen a guardrail until the report
shows whether the missing capability is context, tool contract, prompt wording,
or infrastructure.

## Context And Tool Scope

Scope reduction must preserve playable behavior. Do not remove context or tools
globally just to make prompts smaller; split by player intent and prove the same
scenario still works.

Current backend rules:

- Guidance-only exploration turns such as "what can I do?" downgrade from broker
  `T4` to narrator `T2`. The player gets 2-3 grounded options without the full
  broker tool surface.
- Exploration context keeps local frame, active quests, and available quests,
  but no longer includes the full world catalogue.
- Broker profile `movement_social` is used for travel, following, waiting,
  entering, and private-scene movement. It keeps movement, companion, memory,
  query, dice, and narration tools while dropping unrelated mutation tools.
- Broker profile `environment_probe` is used for cutting, breaking, opening,
  searching hidden details, or similar scene interaction. It keeps dice,
  surface, runtime-field, entity-create, query, and narration tools.
- Default broker scope remains available for broad turns where player intent
  cannot be safely narrowed.

`turn.prompt_budget` telemetry records `tool_profile`, system prompt chars,
user/context chars, and tool count. Treat `prompt_context_budget` as P2 unless
it causes blocked turns or repeated player-visible latency. The next
optimization target is the static broker system prompt, not another broad cut
from local scene context.

## Mechanical Scope Guards

The marathon runner can require exact tools, at-least-one tool groups, and
specific runtime field mutations. Use these checks when a scenario needs durable
truth, not only good prose.

Examples:

- Creative scene change: require `dice_check`, `narrate`, one of
  `apply_runtime_field_patch` / `set_runtime_field` / `apply_surface`, and the
  relevant runtime field ids.
- Silent private-scene movement: when the preset already moved the player into
  the room, require truthful narration instead of forcing a duplicate
  `move_player`.
- NPC travel request: if the NPC agrees, require `set_companion` before
  `move_player`; if the NPC refuses or hesitates, accept a concrete in-world
  condition, price, reason, or question.

Velvet Booths uses runtime fields `2400 curtain_state` and
`2401 table_sign_state`. A narrow pre-tool validator rejects `narrate` if the
model claims the curtain changed while field `2400` still says it is hanging.
Keep this kind of guard targeted; do not replace gameplay with a generic state
police layer.

## Balance Signals

Each scenario is judged against a GM outcome:

- `Yes`: the easy action happens and durable consequences are written.
- `Yes-and`: success creates a grounded lead, branch, or relationship change.
- `Roll`: uncertainty is resolved through dice or another mechanic.
- `No-but`: the impossible action is refused in-world with a concrete option.
- `Clarify`: ambiguity gets one diegetic question or two grounded choices.

Failure is not just "tool missing." A turn is also suspect when it uses only
rules language, refuses without an in-world alternative, teleports NPCs, treats
player claims as truth, or preserves state so rigidly that reasonable play dies.
A lifeless answer with no pressure, option, consequence, NPC reaction, or
diegetic question is a gameplay bug even when the database remains consistent.

## Fix Policy

Do not loosen prompts blindly. For each finding, classify the missing capability:

- backend context missing or misleading;
- tool contract too narrow;
- guard/prompt over-constraining improvisation;
- model ignored available state;
- frontend/replay presentation issue.

Fix backend contracts or prompts in the smallest layer that restores both:
mechanical truth and playable GM behavior.

## Gemini Review

After a cycle, run Gemini only as a reviewer. Use `--approval-mode plan` and the
generated prompt, but verify its behavior: if Gemini creates `GEMINI_AUDIT_REPORT.md`
or any other file, move that output into the run folder and treat it as an
artifact, not an implementation. Gemini findings are leads; Codex verifies them
against source, logs, and state before editing backend code.
