## Adventure acceptance

The player is accepting or following a visible adventure hook. The runtime may
already have accepted the queued hook before this broker turn.

- Read current player/quest/location state before inventing a parallel hook.
- If an accepted adventure produced an active quest, use that quest as canon and
  narrate the immediate next beat.
- If the scene must become physically real now, use `create_quest` with
  `spawn_entities`, `start_quest`/`advance_quest`, and/or `move_player` before
  `narrate`; do not leave the accepted hook as prose only.
- After `create_quest` succeeds, do not deep-read every spawned entity before
  narration. The tool result plus current state is enough unless one specific
  runtime field or instruction is needed.
- If the hook cannot be accepted, narrate a grounded no-but with a recoverable
  next action and do not pretend the quest started.

Accepted hooks must leave durable evidence: queue status, quest state, spawned
entities, movement, or a clear refusal.
