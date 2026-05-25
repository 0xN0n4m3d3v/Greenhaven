# Quest branching: real choices

The biggest difference between a "quest" in an ordinary game and a
quest in Greenhaven is the **real choice**. Not "pick one of two
lines and nothing changes" but "choose, and the world goes a
different way." This chapter is about how to describe those forks.

## Stages — the foundation

Every quest is built out of stages. A stage is a step. If stages run
one after another, the quest is linear:

```markdown
## Stages

1. Talk to `@Bram Caskbright`.
2. Find evidence in `@Blue Warehouse Row`.
3. Bring the evidence to `@Tessa Wrenlight`.
```

The player walks through 1, then 2, then 3, and the quest closes. That
is fine for service quests and short side-stories. But when you want
to give the player a **fork**, you need a different construct.

## Choice — the point of decision

If at some stage the player must make a decision, the last stage is
replaced with a special `next_stage` block typed as `choice`:

```markdown
## Stages

1. Find a companion.
2. Choose a route to the port.
3. next_stage:
   - kind: choice
   - options:
     - target_stage_id: harbour_route
       label: Take the harbor route (faster, more dangerous)
     - target_stage_id: street_route
       label: Take the street route (slower, safer)
```

Let's unpack it. When the player arrives at stage 2, the engine
presents two buttons: "harbor route" and "street route." Whichever the
player clicks, the quest follows that branch.

Two important fields inside each option:

- `target_stage_id` is the internal name of the stage to jump to. Any
  short English string without spaces: `harbour_route`,
  `return_to_tessa`, `sell_to_fixer`. The name is for the engine — the
  player does not see it.
- `label` is the text on the button. The player sees this. Write it
  in plain language: "Take the harbor route (faster, more dangerous)."

In the compiled quest, the stages a choice points to **must exist**.
Otherwise the engine has nowhere to jump and the validator will flag
the error.

## Prerequisites — conditions on an option

Sometimes you want an option to be **visible** but only **available**
to someone who has earned it. For example, "quietly pick the lock" is
only available to a character with lockpicking.

This is solved through `prerequisites` — a list of conditions that
must be met:

```markdown
## Stages

1. Find the entry to the cellar.
2. next_stage:
   - kind: choice
   - options:
     - target_stage_id: stealth_entry
       label: Quietly pick the lock
       prerequisites:
         - type: skill_check
           skill: lockpicking
           dc: 14
     - target_stage_id: force_entry
       label: Kick the door in
       prerequisites:
         - type: skill_check
           skill: athletics
           dc: 12
```

`dc` is the *difficulty class* — the level of the check. Higher is
harder. The player sees both options, but if their lockpicking is
not enough, the "quietly pick the lock" button is disabled.

## Timers — pressure of time

Some stages have a meaning bound to time. For example: "find the
evidence before the fixer notices the tail." Technically this is
written:

```markdown
## Stages

1. Find the evidence before the fixer notices the tail.
   - turns_remaining: 5
   - timeout_action: advance_to
   - timeout_target: fixer_disappears
```

Three fields:

- `turns_remaining` — how many turns the player has.
- `timeout_action` — what to do if time runs out. `advance_to` means
  "jump to a stage."
- `timeout_target` — which stage to jump to on timeout.

In this example: if the player has not finished the stage in five
turns, the quest automatically jumps to `fixer_disappears` — a branch
in which the fixer leaves and the evidence is lost. This is **not a
failure** of the quest; it is **another branch**, with its own tasks.

## Success and failure at the quest level

In addition to the overall `Success Result` and `Failure Result`,
each branch of a fork can carry its own outcome. In simple cases the
general ones are enough:

```markdown
## Success Result

If returned to Tessa: positive strings, unlock of the follow-up quest.

## Failure Result

If sold to the fixer: negative strings, an entry in the ledger.
```

In more elaborate quests with many branches you can write outcomes
**inside the branch**, in the stage itself.

## When the quest ends on its own

If the quest reaches its last stage and has nowhere left to go
(`next_stage` not specified), it closes automatically and rewards and
consequences apply.

Even if the last stage carries no concrete objectives, the quest
still closes. This is handled by a fix in the engine (tagged
internally as GH-BUG-096, for reference).

## A few last rules

- Every `target_stage_id` must correspond to a real stage in the
  `Stages` list. A reference "into nothing" is flagged by the
  compiler.
- Do not leave orphan stages — stages no path leads to. They are
  unreachable and only add noise.
- Timers decrement by one each player turn.
- `prerequisites` are re-checked every time the engine recomputes
  option availability.

If a choice should change not only the next stage but **the world
itself**, attach a `Materializes` block describing what appears after
the choice. For example: "when the hero chooses the harbor route,
materialize an encounter with the harbor watch." That is what makes
Greenhaven not merely a game with branching but **a world with
memory**.
