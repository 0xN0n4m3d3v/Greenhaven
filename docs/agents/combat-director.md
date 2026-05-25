# Combat Director (spec 40)

Blocking pre-broker specialist. Fires when `classifyMode === 'combat'`. Reads
player prose + target stats + recent damage; returns a fully-resolved combat
plan that the broker uses verbatim.

## Goal

Centralise combat math. The broker's prompt has the full D&D-style ruleset (dice
as truth, position/effect, conditions, brevity, memory canon — see
[design/combat.md](../design/combat.md)) but re-deriving every value on every
combat turn burns reasoning tokens and gets the math wrong. The Director runs
once, returns a structured `<combat_briefing>` XML block, and the broker reads
pre-computed values.

Key decisions the Director makes:

- **Roll plan.** `skip_attack_roll: false` for player-authored attacks,
  including completion-language prose. The player's text is intent and cinematic
  style; the d20 decides whether impact becomes canon. `true` is reserved for
  non-player mechanics the server has already resolved before the Director call.
- **Damage plan.** Target name + amount + damage type + source. Amount scaled to
  the prose's wound severity (light cut → 8–15, deep cut → 18–30, mortal →
  35–60, killing blow → enough to defeat in one).
- **Position + Effect.** D&D-Forged-Blades style. Position ∈
  controlled/risky/desperate; Effect ∈ limited/standard/great. See
  [design/position-and-effect.md](../design/position-and-effect.md).
- **Conditions.** Up to 2 condition applications (target ← tag, severity,
  duration_turns).
- **Memory canon.** Up to 2 first-person memory sentences with importance +
  tags. Director writes the canonical phrasing so the broker's `add_memory`
  calls land identical text.

## Mode

`blocking` pre-broker briefing. Declared in
[packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts)
and executed by
[packages/web-server/src/turnBrokerStage.ts](../../packages/web-server/src/turnBrokerStage.ts)
as `combatDirectorHook`. Returns `null` on `mode !== 'combat'` (fast no-op for
the 90% of turns that aren't combat).

## Output schema

Defined at
[packages/web-server/src/agents/combatDirector.ts:31-67](../../packages/web-server/src/agents/combatDirector.ts#L31-L67):

```ts
{
  roll_plan: { skip_attack_roll: boolean, reason: string },
  damage_plan: { target: string, amount: 0..60, type?: string, source?: string },
  position: 'controlled' | 'risky' | 'desperate',
  effect: 'limited' | 'standard' | 'great',
  conditions?: [{ target, tag, duration_turns: 1..10, severity: 1..3 }],  // max 2
  memory_canon: [{ owner, about, text, importance: 0.5..0.95, tags: string[] }],  // max 2
  language?: string,
}
```

## Where it's wired

- Hook export: `combatDirectorHook` at
  [packages/web-server/src/agents/combatDirector.ts:100-134](../../packages/web-server/src/agents/combatDirector.ts#L100-L134).
- Imported into the pre-broker hook list in
  [packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts).
- Resolves combat target via `resolveCombatTarget`
  ([packages/web-server/src/agents/combatDirector.ts:183-207](../../packages/web-server/src/agents/combatDirector.ts#L183-L207))
  — `@`-mention first, then `dialogue_partner_id` fallback.
- Loads target HP/AC/prof/conditions from `runtime_fields` + `runtime_values`
  ([packages/web-server/src/agents/combatDirector.ts:218-260](../../packages/web-server/src/agents/combatDirector.ts#L218-L260)).
- `formatBrokerBriefing(brief)` composes the
  `<combat_briefing>…</combat_briefing>` block
  ([packages/web-server/src/agents/combatDirector.ts:140-172](../../packages/web-server/src/agents/combatDirector.ts#L140-L172)).
- The broker's prompt at
  [packages/web-server/prompts/greenhaven.md:75](../../packages/web-server/prompts/greenhaven.md#L75)
  is told to consume the briefing verbatim.
- Debug runner: `POST /api/debug/run-combat-director` at
  [packages/web-server/src/index.ts:444](../../packages/web-server/src/index.ts#L444).

## Failure & fail-open

- `runSpecialist` returns null → hook returns null → broker proceeds with the
  full ruleset in the prompt as fallback.
- Target can't be resolved (no `@`-mention, no dialogue partner) → return null
  at
  [packages/web-server/src/agents/combatDirector.ts:109](../../packages/web-server/src/agents/combatDirector.ts#L109).
- Target row missing or HP fields not declared → return null at
  [packages/web-server/src/agents/combatDirector.ts:112](../../packages/web-server/src/agents/combatDirector.ts#L112).
- Player row missing → null. Recent damage query failure → caught upstream,
  contributes empty array.
- Timeout 7000ms (tighter than default — combat math is the latency-critical
  path).

The fail-open contract is the broker's full combat ruleset in the prompt — see
[design/combat.md](../design/combat.md). Director only optimises the case where
it CAN add value.

## Prompt

Source:
[packages/web-server/src/agents/combatDirectorPrompt.ts](../../packages/web-server/src/agents/combatDirectorPrompt.ts).

System covers:

- Player intent detection (anatomical detail, wound aftermath, completion
  language) without treating prose as a confirmed hit.
- Damage scaling table (severity × wound type → amount range).
- Position/Effect calibration (target conditions × player advantage).
- Memory canon — first-person, NPC voice, importance bands.
- Multilingual: prompt is language-agnostic by construction; the model detects
  the prose language and writes `memory_canon.text` in the same language.

Temperature 0.2 — tighter than the default 0.3. Combat math wants determinism;
we don't want creative damage values. Output is JSON only, validated by the
schema above.

`buildUser(input)` formats:

- Player prose (verbatim).
- Player state: name, HP/maxHP.
- Target state: name, HP/maxHP, AC, prof, current conditions.
- Recent damage rows from `tool_invocations` (last few `damage` calls in this
  session) — context for combat memory continuity.

## Sources

- [packages/web-server/src/agents/combatDirector.ts](../../packages/web-server/src/agents/combatDirector.ts)
  — hook, schema, helper queries, briefing formatter
- [packages/web-server/src/agents/combatDirectorPrompt.ts](../../packages/web-server/src/agents/combatDirectorPrompt.ts)
  — system prompt + user builder
- [packages/web-server/plans/execution-roadmap/specs/40-combat-director.md](../../packages/web-server/plans/execution-roadmap/specs/40-combat-director.md)
  — original spec
