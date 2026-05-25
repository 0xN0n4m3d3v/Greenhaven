# Intimacy

Sex scenes are quest-tracked state machines. The Intimacy Coordinator (spec 41) drives the FSM; the cartridge ships per-NPC quests + sex_moves. Without this scaffolding, the broker writes intimate prose but routinely forgets the mechanic — trauma counter, string bumps, runtime field flips. The whole point is durable consequence.

The full ruleset lives in [packages/web-server/prompts/greenhaven.md:175-241](../../packages/web-server/prompts/greenhaven.md#L175-L241).

## Beat FSM

```
uninitialized → approach → consent → foreplay → climax → aftermath
                                                     ↘ skip
```

Beats:

- **approach** — initial framing, room/scene setup, partner present. No mandatory mutation yet.
- **consent** — explicit agreement; the partner says yes (in words, action, or unmistakable invitation). Mandatory: `start_quest` (cartridge or dynamic), `add_memory(owner=partner, text='consent token')`.
- **foreplay** — body action, mutual escalation. Mandatory: `string_award(npc=partner, delta=+1)` if first such beat in the encounter.
- **climax** — peak. Mandatory: advance/close the intimacy quest at the correct beat, fire `apply_intimacy_trigger('climax')` when a scripted rule applies, and award strings/memory as authored. `apply_runtime_field_patch` is used only for runtime fields that actually exist in context or in `sex_move.effect_args`.
- **aftermath** — closing beat. Mandatory: `complete_quest(outcome='completed')` if cartridge / dynamic quest reached its terminal stage. The `profile.sex_move` fires here for partners with one declared.
- **skip** — partner refuses, narrative pivot. `complete_quest(outcome='failed')` or `advance_quest` to a refusal stage.

The Coordinator model picks the beat based on player prose, partner state
(mood, strings), and recent intimate beats. It no longer emits mutation
`tool_plan` directly; `intimacyCoordinatorPolicy.ts` compiles the actual quest,
reward, string, and `profile.sex_move` tools from loaded state. See
[agents/intimacy-coordinator.md](../agents/intimacy-coordinator.md).

## Cartridge vs dynamic quest

Decision tree (in [packages/web-server/prompts/greenhaven.md:230-234](../../packages/web-server/prompts/greenhaven.md#L230-L234)):

- **Cartridge has a matching quest** in the preamble (`Mikka's Private Price` listed) → USE IT. `start_quest("<exact name>")` and follow Initiation/Mid/Climax stages.
- **Cartridge has nothing for this NPC + this kind of encounter** → `create_quest` with a fresh dynamic structure (typical 4 stages: `approach → consent → foreplay → climax → aftermath`).
- **Mid-scene the partner unexpectedly does something not covered** → `update_entity` on the partner OR add a new stage; don't abandon the quest.

Dynamic intimacy quest body example from the prompt: see lines 195-223.

## Mandatory tool calls per beat

The non-negotiable mechanic-persistence list. Drift here means the world goes out of sync with the prose:

| Beat | Mandatory tools |
|---|---|
| consent | `start_quest`, `add_memory(consent token)` |
| foreplay | `string_award(+1)` if first |
| climax | `advance_quest`/`complete_quest`, `apply_intimacy_trigger('climax')` if scripted, `string_award`/memory. Runtime patches only for listed fields. |
| aftermath | `complete_quest`, `profile.sex_move` effect_tool fires |

Plus the **scripted_intimacy_rules** from migration `0039` (see [packages/web-server/src/scriptedActions/intimacyActions.ts](../../packages/web-server/src/scriptedActions/intimacyActions.ts)). When `mode='intimacy'`, an addendum is appended to the broker system prompt listing trigger_tag → field_patches/string_delta/trauma_tag rules. Each rule with `one_shot=true` fires at most once per (player, partner) pair.

Failure mode the prompt explicitly calls out (line 241): "writing 3-4 narrate-handoff turns in a row without a single state-change tool. The cartridge sees a static encounter and the player's commitments aren't recorded. If this is beat #3 of an intimate scene and you've called only `narrate` so far, you're already off-spec."

## sex_move

Per-NPC permanent post-encounter effect. Schema and worked examples in [cartridge/sex-moves.md](../cartridge/sex-moves.md).

```ts
profile.sex_move = {
  trigger: 'post_climax' | 'post_aftercare' | 'on_first_strings_unlock',
  narrate_hint: string,
  effect_tool: 'add_memory' | 'apply_runtime_field_patch' | 'string_award' | 'inventory_transfer' | ...,
  effect_args: object,
}
```

Mikka's example: `add_memory` of leverage knowledge → unlocks a future bargain mechanic. Borek's example: `apply_runtime_field_patch` with the current cartridge's `field_id=8110` for free lodging at the Lantern. Both are durable — they persist through saves/loads, survive across sessions, and surface in the relevant scenes' affordances.

Quest profile must opt in via `rewards.sex_move_eligible: true`. Without that flag, the sex_move is harmless data — broker won't fire it.

## Payment substitution

When the cartridge defines a payment-recipe quest (e.g. Mikka's intel sells for
5 Gold Coin) and the player offers an *alternative* payment (a body action, a
tip-off, a String spend), the Intimacy Coordinator may only report the payment
or relationship intent. Runtime policy and the broker then decide which
cartridge-authored substitution tools are legal:

```ts
// Standard payment
inventory_transfer(from_player_id=<active player entity id>, to='Mikka Quickgrin', item='Gold Coin', count=5)

// Substituted with intimate beat
start_quest('Mikka\'s Private Price')        // intimacy quest replaces coin payment
```

The substitution is the cartridge author's contract — the quest's `profile.payment_substitution` lists allowed swaps. Broker reads, picks; if the substituted quest fails (refuse, walk-away), the original payment becomes due again.

## Tool budget

Per beat:
- **1** call (mid-beat narrate-only) — minimum. Even quiet beats should fire `add_memory` if the canon is shifting.
- **4** calls (initiation or climax) — typical max. `start_quest` + `add_memory` + `string_award` + `narrate` for initiation.

Hard rule: "If you used 0 tools on an intimacy beat, ask whether you skipped a state change — the preamble after this turn should be visibly different from before." If preamble looks identical, you missed a mutation.

For dynamic encounters the cartridge can attach `profile.sex_move` via `create_entity` or `update_entity` if you want a post-encounter mechanic beyond xp+memory. Dynamic-partner sex_move authoring is uncommon but supported.

## Sources

- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md) — Intimacy ruleset (lines 175-241)
- [packages/web-server/src/agents/intimacyCoordinatorPrompt.ts](../../packages/web-server/src/agents/intimacyCoordinatorPrompt.ts) — Intimacy Coordinator prompt
- [packages/web-server/src/scriptedActions/intimacyActions.ts](../../packages/web-server/src/scriptedActions/intimacyActions.ts) — scripted_intimacy_rules injection
- [packages/web-server/migrations/0039_scripted_intimacy_rules.sql](../../packages/web-server/migrations/0039_scripted_intimacy_rules.sql) — rules schema + seeds
