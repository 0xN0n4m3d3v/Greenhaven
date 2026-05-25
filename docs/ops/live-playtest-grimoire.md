# Live Playtest Grimoire

This document defines adversarial runtime states for Greenhaven playtests. It is
not a smoke-test list. The goal is to force the game into states a real player
will create by interrupting, misunderstanding, silently following hints, giving
items to the wrong character, switching language, refreshing, or completing
quest steps out of order.

Pair this document with
[`live-playtest-trickster-corpus.md`](live-playtest-trickster-corpus.md). The
grimoire defines durable bad states; the corpus defines player-language attacks
and DM response standards derived from tabletop practice.

For continuous multi-run evaluation, use
[`continuous-playtest-system.md`](continuous-playtest-system.md). That document
defines the balance loop: core mechanics must stay truthful while the AI GM
keeps enough freedom to answer with playable `Yes`, `Yes-and`, `Roll`,
`No-but`, or `Clarify` outcomes.

Use these states through the debug-only control plane:

```powershell
Invoke-RestMethod "http://127.0.0.1:7777/api/debug/live-state?playerId=<id>&sessionId=<uuid>&limit=80"
Invoke-RestMethod -Method Post "http://127.0.0.1:7777/api/debug/live-preset" `
  -ContentType "application/json" `
  -Body '{"playerId":1200,"sessionId":"<uuid>","preset":"silent_follow_private_scene"}'
```

For real model probes, prefer the UTF-8 runner instead of inline PowerShell
Russian text:

```powershell
npm --prefix packages/web-server run live:probe -- `
  --player-id 1200 `
  --session-id debug-probe-silent-follow `
  --preset silent_follow_private_scene
```

The runner captures `before`, `after-preset`, turn submission, settled state,
`after-turn`, transcript summary, and a bug-ledger template under
`.codex/run-logs/live-playtest/`.

## Core Rule

Every finding must answer three questions:

1. What state did the player/server/model believe was true?
2. Which durable row or SSE event proves or disproves it?
3. Did DeepSeek fail to use available state, or did the backend fail to expose
   the state contract?

Do not reset immediately after a failure. Capture `live-state`, telemetry
errors, the browser screenshot, and the exact player text.

## GM Standard

Greenhaven's DeepSeek broker should behave like an improvising tabletop GM, not
like a quest form validator. D&D's core loop is: the GM describes the situation,
players say what they want to do, and the GM resolves the result. Experienced
DM advice converges on the same rule: prepare useful situations, not rigid
scripts; use mechanics to resolve uncertain actions; let player ideas create
new hooks; ask a clarifying question when genuinely stuck.

For each probe, classify the player text:

- **Free**: no meaningful obstacle; the action simply happens.
- **State-changing**: movement, item transfer, quest progress, memory, scene
  state, or relationship state must be written through tools.
- **Contested**: use dice/tools and narrate consequences.
- **Impossible**: give an in-world reason and one grounded alternative.
- **Unclear**: ask one diegetic clarification or offer two concrete actions.

Failure: the model says generic flavour while the durable state stays unchanged,
or blocks the player only because the action is off the expected quest path.

Success: the world bends around the player's unexpected action while preserving
truth in chat, quests, inventory, memory, GUI events, and telemetry.

Use this outcome vocabulary in bug reports:

- **Yes**: easy action succeeds and any durable consequence is written.
- **Yes, and**: action succeeds and opens a new grounded lead or branch.
- **Roll**: uncertain action is resolved through dice/tool evidence.
- **No, but**: impossible action is refused in-world with a concrete
  alternative.
- **Clarify**: ambiguous action gets one diegetic question or two grounded
  options.

## Required State Families

### Silent Follow And Private Space

Preset: `silent_follow_private_scene`

The NPC invites the player behind a curtain, but the player moves there without
answering the NPC. This catches the Velvet Booths class of bug: the player is in
the private place, dialogue is cleared, and the NPC may still be elsewhere.

Expected game behavior: the next turn must either bring the NPC along through a
real state mutation, explain that the NPC did not follow, or ask the player to
re-engage. It must not pretend the NPC is present without state evidence.

### Quest Chain Wrong Order

Preset: `quest_chain_wrong_order`

The player is placed on the final stage of a multi-stage chain without durable
evidence for the earlier stages.

Expected behavior: the giver should notice missing prerequisites. The model must
not award completion just because the current stage says `return_to_giver`.

### Quest Item Wrong Handoff

Preset: `quest_item_wrong_handoff`

The player receives a quest item, then the control plane moves it to the wrong
holder before the player reports back.

Expected behavior: quest completion depends on inventory/holder truth, not on
the player's claim or the NPC's vague memory.

### Multiple Active Quests From One Giver

Preset: `multi_quest_same_giver_conflict`

Two active quests from the same NPC carry conflicting route requirements.

Expected behavior: DeepSeek must distinguish quests by title/stage and avoid
merging objectives. Backend context must expose enough quest identity to make
that possible.

### Queued Turn Interruption

Preset: `queued_turn_interruption`

A fake running row and a queued follow-up turn simulate the player changing
intent while a previous response is unresolved.

Expected behavior: replay and transcript order stay deterministic. No queued
turn should appear before the active turn or presentation barrier resolves.

## Manual Operation Families

Use `POST /api/debug/live-ops` for custom states:

- `insert_chat` creates controlled transcript evidence.
- `set_location` moves the player without model narration.
- `set_dialogue_partner` creates or clears focused NPC routing.
- `set_entity_location` moves or strands an NPC/item by profile location.
- `create_debug_quest` and `set_quest_status` build quest chains.
- `grant_item` and `move_item` verify inventory truth versus narration.
- `add_npc_memory` creates supporting or contradictory NPC memory.
- `set_runtime_field` tests mood, trauma, scene atmosphere, flags, and HP-like
  state exposed through runtime context.
- `queue_player_turn` creates queued/running/failed ingress rows.
- `emit_gui_event` tests replay, ordering, stale cards, and duplicate events.
- `enqueue_adventure` creates durable adventure hooks and accept/ignore probes.

## Bug Ledger Format

For every bug found, append a note to the active run folder:

```md
## <short title>

- Severity: P0/P1/P2
- Preset/ops: `<preset or JSON file>`
- Player/session: `<playerId> / <sessionId>`
- Turn/queue/event ids: `<ids>`
- Repro: `<steps>`
- Evidence: screenshots, logs, `live-state` path
- Expected: durable state contract says...
- Actual: game/model did...
- Suspected owner: backend/frontend/desktop/content/model/cross-layer
- Fix path: spec/code/test/handoff
```

## Pass Criteria

A live playtest pass is valid only when the agent has:

- captured state before and after the player action;
- verified chat, quest, inventory, memory, queue, GUI event, and telemetry rows;
- asked at least one non-cooperative player question;
- tested replay/reload for timeline state;
- separated model failure from missing backend context.

## Research Notes

- D&D Basic Rules: play loops through GM scene description, player intent, and
  GM resolution.
- D&D Beyond improvisation advice: use checks, advantage/disadvantage, and
  inspiration to support improvised situations.
- Sly Flourish: prepare what benefits the game and build tools for reacting to
  the evolving story.
- GM anti-railroading advice: avoid rigid multi-step assumptions; lean into
  player goals and loop diversions back through world consequences.
