# Quest Pacer

Quest Pacer is a deterministic async post-turn advisor. It reads active quests, recent quest progress, and giver presence in chat, then writes advisory signals into `players.metadata.quest_pacer`.

It never calls mutation tools and never changes gameplay state outside its own metadata block.

## Signals

| Signal | Threshold | Meaning |
|---|---|---|
| `overload` | More than 7 active quests | Too many open arcs. |
| `stale` | No progress for more than 24 hours | The quest should be nudged or closed. |
| `dead_npc_arc` | Giver absent for more than 5 days and the quest is stale | The giver is no longer present in play; reintroduce or close the arc. |

## Persisted Shape

`players.metadata.quest_pacer`:

```ts
{
  signals: [{
    signal_type: 'overload' | 'stale' | 'dead_npc_arc',
    quest_id?: number,
    quest_title?: string,
    giver_entity_id?: number,
    giver_name?: string,
    details: string,
    suggestion: string,
  }],
  updated_at_turn: string,
  updated_at: string,
}
```

Each signal also emits an ordered GUI event through the Spec 86 presentation slot `post.quest_pacer`. Payload fields include `questId`, `questTitle`, `giverEntityId`, `giverName`, `details`, and `suggestion`.

## Data Rules

- Active quests come from `player_quests JOIN entities` where `status='active'`.
- Progress lookup scans `tool_invocations` for quest refs in args or results. It compares JSON refs as text and does not cast arbitrary strings to bigint.
- Giver lookup prefers `entities.profile.giver_entity_id`; legacy `profile.giver` is fallback only.
- Giver presence matches by `chat_messages.author_entity_id` when an id exists, then by legacy display name.

## Sources

- [questPacer.ts](../../packages/web-server/src/agents/questPacer.ts)
- [spec 87](../../packages/web-server/plans/execution-roadmap/specs/87-quest-progression-arbiter.md)
