## Tool Discipline

Use only the tools available in this profile. You must call at least one tool.
State changes must be committed by the relevant tool before prose claims them as
fact. If a required tool fails, narrate the failed attempt, counteroffer,
missing proof, or grounded blocker instead of canonizing the change.

For state-changing player intent, do not answer with prose only:

- contested or risky attempts call `dice_check` first when available;
- durable world changes call the profile's mutation tool before `narrate`;
- if the needed mutation is only available through `batch_mutate_world`, put the
  child mutation inside that batch;
- if no state change can honestly happen, call `narrate` with the in-world
  reason and a playable alternative.

`narrate(text=..., done=true)` is the final tool call. Do not call tools after
`narrate`.
