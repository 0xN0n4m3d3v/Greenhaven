# Intimacy Coordinator

Blocking pre-broker specialist. Fires when `classifyMode === 'intimacy'`.
It classifies the intimacy beat and proposes narrow non-tool data; deterministic
runtime policy compiles the actual mutation plan before the broker sees it.

## Goal

Keep intimate scenes as durable quest/state beats without letting one model own
quest mutation, rewards, memory tools, runtime fields, and location spawning.

FSM:

```text
uninitialized -> approach -> consent -> foreplay -> climax -> aftermath
                                                   -> skip
```

For each turn the model may propose:

- `phase`: the beat classification.
- `dynamic_quest_copy`: localized `title` / `summary` / `goal_text` only.
- `resource_intents`: payment or small relationship-delta intent, not tool
  calls.
- `memory_canon`: up to 2 first-person memory sentences.
- `handoff_recommend`: whether narrator-quality prose is needed.

Runtime policy then compiles the final broker briefing:

- cartridge quest stages become canonical `advance_quest` / `complete_quest`;
- dynamic quest copy becomes a sanitized `create_quest` with canonical stages,
  tags, rewards, and no spawned entities;
- early XP and direct model `add_memory` are impossible because the model no
  longer outputs `tool_plan`;
- string deltas and XP are clamped;
- `profile.sex_move.effect_tool` can fire only during aftermath.

## Mode

`blocking` preBrokerPhase. Hook export:
[intimacyCoordinator.ts](../../packages/web-server/src/agents/intimacyCoordinator.ts).

If state loading returns no active dialogue partner, the hook returns `null`.

## Model Output

Defined in
[intimacyCoordinatorTypes.ts](../../packages/web-server/src/agents/intimacyCoordinatorTypes.ts)
as `CoordinatorModelOutput`:

```ts
{
  phase: 'approach' | 'consent' | 'foreplay' | 'climax' | 'aftermath' | 'skip',
  dynamic_quest_copy?: {
    title?: string,
    summary?: string,
    goal_text?: string,
  } | null,
  resource_intents?: Array<
    | {kind: 'inventory_transfer', item?: string, count?: number | string, from_player_id?: number, to_player_id?: number, to?: string, reason?: string}
    | {kind: 'relationship_delta', npc?: string, delta?: number, reason?: string}
  >,
  memory_canon: Array<{owner: string | number, about: string | number | null, text: string, importance: number, tags: string[]}>,
  handoff_recommend: boolean,
  reason: string,
  language?: string,
}
```

The broker never receives this shape directly. It receives `CoordinatorBrief`,
which is compiled by
[intimacyCoordinatorPolicy.ts](../../packages/web-server/src/agents/intimacyCoordinatorPolicy.ts)
and formatted by
[intimacyCoordinatorBriefing.ts](../../packages/web-server/src/agents/intimacyCoordinatorBriefing.ts).

## Ownership

- [intimacyCoordinatorState.ts](../../packages/web-server/src/agents/intimacyCoordinatorState.ts)
  loads partner, participants, mood, strings, `profile.sex_move`, active quest
  phase, and recent intimate beats.
- [intimacyCoordinatorBeatPrompt.ts](../../packages/web-server/src/agents/intimacyCoordinatorBeatPrompt.ts)
  owns beat classification rules.
- [intimacyCoordinatorProposalPrompt.ts](../../packages/web-server/src/agents/intimacyCoordinatorProposalPrompt.ts)
  owns weak proposal boundaries.
- [intimacyCoordinatorPrompt.ts](../../packages/web-server/src/agents/intimacyCoordinatorPrompt.ts)
  only assembles the prompt and builds the user input.
- [intimacyCoordinatorPolicy.ts](../../packages/web-server/src/agents/intimacyCoordinatorPolicy.ts)
  owns deterministic tool-plan compilation.
- [intimacyCoordinatorBriefing.ts](../../packages/web-server/src/agents/intimacyCoordinatorBriefing.ts)
  owns broker briefing formatting and defensive grounding.

## Failure

`runSpecialist` returns `null` on timeout/provider failure. The hook then
returns `null`, and the broker continues with the normal intimacy rules and
scripted intimacy addendum. The model timeout is still short because this is a
blocking pre-broker specialist, but its output can no longer inject raw tools.
