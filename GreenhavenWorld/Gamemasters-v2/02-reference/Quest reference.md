# Quest reference

In the tutorial we wrote a single quest — "Tessa's Compass." This
chapter spells out every section in detail, in case you are now writing
your tenth quest and have forgotten the exact word for something.

![[Gemini_Generated_Image_dygb8hdygb8hdygb.jpg]]

The quest file lives either inside a character (`npc/@Name/quests/Title.md`)
or inside a location (`@Location/quests/Title.md`). The file name has
no `@`, uses spaces normally, and ends in `.md`. The level-one heading
inside is the quest title.

## Source — origin

**Why:** a short passport for the quest: who gives it, where it
starts, and what must happen for it to become available.

```markdown
## Source

- Giver: `@NPC`
- Where it starts: description of the place
- Triggered when: condition
```

The condition in `Triggered when` can be soft ("a good relationship
with the character"), strict ("after quest X"), or specific ("after
the hero publicly refuses the fixer").

## Hook — opening beat

**Why:** a small scene of inciting incident. The text the player sees
in chat as the quest's first message. Written in prose, like the
opening sentence of a short story.

## Objective — the goal

**Why:** a short line that answers "what do they want from me?" It
appears as the title in the player's quest log. Do not summarize the
plot here — one clear task.

## Stages — steps

**Why:** the steps leading from the inciting incident to the end.
Each stage is a separate list item.

```markdown
## Stages

1. First stage with `@NPC` in `@Location`.
2. Second stage.
3. Third stage.
4. Choice: return to `@NPC1` or sell to `@NPC2`.
```

A few rules:

- Stages can be numbered (`1.`, `1)`) or marked with a dash, a plus,
  or an asterisk. The engine recognizes the start of a new stage by
  the marker.
- If a line does not start with a marker, it attaches to the previous
  stage. That is how you write longer multi-line stages.
- Every stage should contain `@` names — that anchors it to specific
  people and places.

## Fork in the stages

If at some point the player must choose, you use the `next_stage`
construct with `kind: choice`:

```markdown
5. next_stage:
   - kind: choice
   - options:
     - target_stage_id: return_to_tessa
       label: Return it to Tessa
     - target_stage_id: return_to_child
       label: Return it to the child
```

Details in [Quest branching](../03-mechanics/Quest%20branching.md).

## Success Result — on success

**Why:** what good happens in the world if the quest goes well. There
can be several branches, depending on the player's choice.

## Failure Result — on failure

**Why:** what bad happens in the case of failure or an undesired
choice. Also can have several branches.

## Reward And Consequence — rewards and long aftermath

**Why:** what the player receives and what shifts in the world for a
long time. Not to be confused with `Success Result`: that one is the
immediate outcome of the scene; this one is the long tail.

## Materializes — what appears in the world

**Why:** the concrete entities that come into being after the quest:
new characters, opened doors, surfaced items. The format is the same
as for characters and locations.

Quest rewards that should become real inventory must also be written
here. Use `Scope: hero inventory` for the active player, or
`Scope: @NPC Name inventory` for an NPC/container/location holder. Add
`count=N` in `Effect` only when the quest grants more than one item.

Details in [Materializes](../03-mechanics/Materializes.md).

## Do Not Do Here — narrator boundaries

**Why:** the list of things the narrator must not do in this quest.
For example: do not let a key clue happen offscreen, do not turn two
characters into mirror copies of each other.

---

## Checklist

- [ ] `Source` with giver, location, and trigger condition
- [ ] `Hook` written in prose
- [ ] `Objective` in a single line
- [ ] At least three steps in `Stages`
- [ ] Stages reference `@` entities
- [ ] `Success Result` and `Failure Result` are written
- [ ] At least one `Materializes` block
