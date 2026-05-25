# Your first quest

A quest is not "kill ten rats." A quest is **why** the hero is going
somewhere right now. It has a beginning (something happens, the hero
gets pulled in), a middle (the steps they take), a fork (the moment
where a choice must be made), and a consequence (the world shifts, and
the shift is remembered).

![[Gemini_Generated_Image_dygb8hdygb8hdygb.jpg]]

In this chapter we will write Tessa's quest — the one about a brass
compass found in someone else's crate.

## Where the quest lives

Quests hide inside one of two folders:

- **Character-owned quest** — in `npc/@Name/quests/Title.md`. Tessa's
  quests live here, because they start from her.
- **Location-owned quest** — in `quests/Title.md` inside the location.
  These are quests that any random visitor in the port might trigger.

The file name is the quest title, no `@`, the `.md` extension. Ours
will be:

```
npc/@Tessa Wrenlight/quests/Tessa's Compass.md
```

## What a quest is made of

**Required:**

- **Source** — who gives it and under what conditions.
- **Hook** — the opening beat, a small scene of inciting incident.
- **Objective** — the goal in one line.
- **Stages** — the steps.

**Strongly recommended:**

- **Success Result** — what happens on success.
- **Failure Result** — what happens on failure.
- **Reward And Consequence** — payouts and long-term shifts.
- **Materializes** — what appears in the world afterward.
- **Do Not Do Here** — boundaries for the narrator.

Let's go through them in order.

## Source — the origin

Who gives the quest, where this happens, when the quest becomes
available. Not prose — short bullet points:

```markdown
## Source

- Giver: `@Tessa Wrenlight`
- Where it starts: at her usual spot by the crates near
  `@Blue Warehouse Cellar Door`.
- Triggered when: the hero has positive strings with Tessa.
```

`Triggered when` is the condition under which the quest appears. Here
it is soft ("good relationship needed"). It can be stricter ("only after
quest X") or more specific ("after the hero publicly refuses the
fixer").

## Hook — the opening beat

A small scene that gets the quest going. Written in prose, like a
location's `First Entry Bubble`. The player will see this text in chat
as the quest's first moment.

```markdown
## Hook

Tessa lifts a small straw-wrapped bundle from a cargo crate: a brass
compass with the letter J on the back — slightly more polished than
her own. She closes her hand around it. "Joran's had a silver rim.
This one is plain. But the J is the same maker's mark. The question is
why it's here."
```

Notice: the hook does not explain the quest. It shows it. The player
does not yet know what to do — they only sense that something has
begun.

## Objective — the goal

A single line that answers "what do they want from me?":

```markdown
## Objective

Find out where the compass with the J mark came from, and decide whose
it should be.
```

This line appears in the hero's quest log as the title. It needs to be
short and clear.

## Stages — the steps

Stages are the steps that lead from the inciting incident to the end.
Each stage is its own list item. You can number them as `1.`, `1)`, or
use dashes — the engine recognizes any list marker.

```markdown
## Stages

1. Check the crate's manifest with `@Bram Caskbright` at the Blue
   Warehouse office.
2. Cross `@Greenhaven Main Square` and ask `@Mara Sunledger` whether a
   notice has come in about a compass with a J mark.
3. Trace the maker's stamp inside the lid — it leads to a workshop on
   Honeybright Lane (concept, not yet active).
4. Decide: return the compass to Tessa, return it to its true owner
   (a child whose father went missing a month ago), or sell it to the
   smuggler for fast coin.
```

A few rules for stages:

- Every stage contains `@` names — this anchors the step to specific
  people and places.
- Stages are written as instructions to the hero. Not "the hero speaks
  to Bram" but "check the manifest with Bram."
- The final stage is a fork. More on that next.

## The fork — a real choice

A linear quest — "1 → 2 → 3 → end" — is fine. But the interesting quest
is the one where, at some point, the hero chooses **how** the story
ends.

Technically, a fork looks like this:

```markdown
5. next_stage:
   - kind: choice
   - options:
     - target_stage_id: return_to_tessa
       label: Return it to Tessa
     - target_stage_id: return_to_child
       label: Return it to the child
     - target_stage_id: sell_to_fixer
       label: Sell it to the fixer
```

It looks unfamiliar at first — almost like code. But the meaning is
simple: "at this step, give the player three options, and depending on
which one they pick, the quest branches." `target_stage_id` is the
internal name of another stage to jump to. `label` is the text the
player sees on the button.

The full structure of forks has its own chapter:
[Quest branching](../03-mechanics/Quest%20branching.md). For your
first quest you can start linear and add a fork later.

## Success Result and Failure Result

What good happens if the quest goes well, and what bad happens if it
goes wrong. This is not only about rewards — it is about how the world
shifts.

```markdown
## Success Result

If returned to Tessa: positive strings, a quiet evening conversation,
unlocks `Tessa's Brother's Last Contract`.
If returned to the child: an ally on the square, respect from
`@Mara Sunledger`.

## Failure Result

If sold to the fixer: negative strings with Tessa, an entry in her
hidden ledger.
If left in the crate: a faction operative collects it, and another
investigation begins later.
```

Notice: in a single quest we already have **four** distinct outcomes —
three flavors of success and two of failure. That is a real choice.
Every move leaves a mark.

## Reward And Consequence — long aftermath

The long-tail consequences of the quest: doors opened, relationships
shifted, new quests that will appear later.

```markdown
## Reward And Consequence

- Positive strings with `@Tessa Wrenlight` or with the concept-NPC on
  the square.
- Respect from `@Mara Sunledger`.
```

## Materializes — what appears in the world

If the quest gives the hero a real item, use `Scope: hero inventory`.
If the quest puts an item into an NPC or container for a later scene,
use `Scope: @Name inventory`. This is cartridge-controlled runtime
state, not just flavor text.

If an outcome of the quest should bring a new person on stage, open a
new door, or place a new item — write it here.

```markdown
## Materializes

- When the hero returns the compass to its true owner:
  - Entity: `@Mara Sunledger`
  - Type: state / square trust
  - Scope: `@Greenhaven Main Square`
  - Effect: Mara's underground notice exchange opens to the hero for
    one favor.
```

## Do Not Do Here — boundaries

Sometimes you have a clear sense of how scenes **should not** unfold.
For example, you want the maker's stamp to be shown on stage, not
mentioned offscreen. This section gives the narrator those guardrails:

```markdown
## Do Not Do Here

Do not make the compass an exact copy of Tessa's — the difference
matters.
Do not allow the maker's-stamp step to happen offscreen.
```

## A short checklist

- The quest has at least three stages.
- Every stage names `@` entities.
- There is at least one meaningful fork.
- Both `Success Result` and `Failure Result` are written.
- There is at least one `Materializes` block.

## What's next

You now have a location, a character, and a quest. That is enough to
compile and run a tiny world. If you want to go deeper, move on to the
next step.

- Full references for every entity:
  [NPC reference](../02-reference/NPC%20reference.md) and the others.
- Deeper mechanics:
  [Materializes](../03-mechanics/Materializes.md),
  [Quest branching](../03-mechanics/Quest%20branching.md),
  [Scenes in depth](../03-mechanics/Scenes%20in%20depth.md).

---

## Reference

**Required sections**

- `## Source`
- `## Hook`
- `## Objective`
- `## Stages`

**Recommended**

- `## Success Result`
- `## Failure Result`
- `## Reward And Consequence`
- `## Materializes`
- `## Do Not Do Here`

**Stages:** each is a single line starting with a list marker (`1.`,
`1)`, `-`, `*`). Lines without a marker attach to the previous stage.

**Fork:** `next_stage:` with `kind: choice` and a list of `options`,
each with a `target_stage_id` and a `label`.

**Full specification** lives in the
[Quest reference](../02-reference/Quest%20reference.md).
