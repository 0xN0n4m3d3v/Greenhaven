# Quest Watcher

Async post-turn specialist. It reads the just-finished turn and the player's active quests, then proposes whether each current stage should advance, complete, or stay unchanged.

The Watcher is not canonical by itself. Since Spec 87, every non-`no_change` decision goes through `questTransitionArbiter`, which reloads fresh quest state, checks same-turn duplicates, validates stage topology, and dispatches existing quest tools with numeric `quest_id`.

## Mode

`async` post-turn hook with Spec 86 presentation slot `post.quest_watcher`.

Visible output is emitted through `ctx.presentation.emit('quest:auto_advanced', ...)`, so cards are ordered by the post-turn slot registry and not by raw async completion time.

## Contract

The specialist output schema is:

```ts
{
  decisions: [{
    quest_id: number,
    action: 'advance' | 'complete' | 'no_change',
    to_stage?: string,
    outcome?: 'completed' | 'failed',
    reason: string,
  }]
}
```

The prompt tells the model that player prose is intent/evidence, not canonical quest state by itself. Canonical progress must be supported by successful tools, dice outcomes, explicit stage objectives, or visible narrative already accepted by the turn.

## Arbiter

`packages/web-server/src/quest/questTransitionArbiter.ts` owns deterministic validation:

- Same-turn duplicate detection checks both `turnRecord.toolHistory` and persisted `tool_invocations`.
- Duplicate matching is id/title compatible, so a broker call with `quest: "<title>"` suppresses a later Watcher proposal with `quest_id`.
- `expectedCurrentStageId` must still match the current DB row.
- `to_stage` must be the declared next stage or an allowed choice target.
- Rejected proposals write deterministic telemetry and emit no player-visible quest card.

## Sources

- [questWatcher.ts](../../packages/web-server/src/agents/questWatcher.ts)
- [questWatcherPrompt.ts](../../packages/web-server/src/agents/questWatcherPrompt.ts)
- [questTransitionArbiter.ts](../../packages/web-server/src/quest/questTransitionArbiter.ts)
- [spec 87](../../packages/web-server/plans/execution-roadmap/specs/87-quest-progression-arbiter.md)
