# Scene reference

A scene is a staged moment. Most of the time the world improvises:
the narrator picks what to say. But sometimes you want to set a
**specific moment** to fire at a particular instant. That is a scene.

Scenes come in two kinds:

- **Character-owned scene** — lives in `npc/@Name/scenes/@Title.md`.
  It belongs to this specific person: first meeting, confession,
  betrayal, duel.
- **Location-owned scene** — lives in `@Location/scenes/@Title.md`.
  It belongs to the place: a fight at the port, a row on the square,
  a hearing at the guild — any suitable character can be drawn into
  it.

The file name carries an `@`. The level-one heading inside is the
scene's name with an `@`.

## Where And When — where and when

**Why:** the condition under which the scene "comes alive." Who owns
it, where it happens, when it becomes visible.

```markdown
## Where And When

- Owner: `@Tessa Wrenlight`
- Location: `@Greenhaven Port`
- Visibility: triggers after `@Dockside Accusation` first beat
```

The condition in `Visibility` must be **specific**: "after the first
beat of scene X," "when the hero approaches the object for the
second time," "when quest Y moves to its third stage." Not
"sometimes" and not "when it seems appropriate."

## Hook — opening beat

**Why:** what the player sees in the moment the scene fires. Short
prose.

## Beat By Beat — beat-by-beat script

**Why:** the beats that make up the scene. Each beat is one narrator
turn.

```markdown
## Beat By Beat

1. The hero notices her. She does not look away.
2. If the hero greets her, she answers with an observation, not a
   name.
3. She gestures at `@Missing Passenger Notice` — or at
   `@Blue Warehouse Cellar Door`, if the hero is listening for the
   cellar.
4. She lets the hero decide whether to continue the conversation.
```

Critical rule: beats are a **skeleton**, not rails. The player can
leave, interrupt, or do something unexpected — the narrator is not
obliged to drag them through all four beats if the scene has broken
on its own.

## Player Choices — player's choices

**Why:** the options the player has in this scene. This is not an
exhaustive list (the player can do something else); it is a **hint**
to the narrator: "here are the main moves, and here is how the
character reacts to each one."

```markdown
## Player Choices

- Insist: ask her name. She gives it.
- Ask about the port: she answers briefly.
- Walk past: she watches and remembers.
- Pay for information: she refuses.
```

## Success Result and Failure Result

**Why:** the different outcomes the scene can have. A scene can have
many outcomes, not only two. What matters is to describe what
separates "went well" from "went badly."

## Memory And String Changes

**Why:** what the character will remember and which relationships
will shift.

```markdown
## Memory And String Changes

`@Tessa Wrenlight` writes down the first thing the hero said in her
mental ledger. This is the first +string or -string entry.
```

## Materializes — what appears after the scene

**Why:** a scene, too, can change the world — open a passage, leave a
clue, launch a quest.

Details in [Materializes](../03-mechanics/Materializes.md).

## Scene Image Brief — scene card or event card

**Why:** a scene can have its own image or short loop separate from the
location card and NPC portrait. Use this for fights, confessions,
discoveries, gates opening, a clue under a lantern, or a mass scene on
the square.

Put scene media beside the scene file:

```text
scenes/@Arrival With A Revolver/
|-- SceneMind.md
`-- images/
    `-- arrival-with-a-revolver.webm
```

Use a square image or square `webm` when the card should fit beside
NPC and location cards.

## Media Script — scene music and transitions

**Why:** a scene script fires when the authored scene opens. This is
the right place for combat music, mystery tension, romance music, a
short reveal sting, or a transition from ordinary location ambience to
a focused dramatic track.

```markdown
## Media Script

switch_music("music_arrival_with_a_revolver", label="Arrival With A Revolver", loop=true, volume=0.66)
```

Scene scripts override the current location or NPC atmosphere when
they run. When the scene ends, the next location or NPC focus can
switch music again.

## Do Not Do Here — narrator boundaries

**Why:** what cannot be done in this scene. If it matters that a
specific clue be shown, not mentioned offstage, write it here.

---

## Checklist

- [ ] `Where And When` with a specific condition
- [ ] `Hook` written in prose
- [ ] `Beat By Beat` — at least 3 beats
- [ ] `Player Choices` — options with reactions
- [ ] `Success Result` and `Failure Result` are written
- [ ] `Memory And String Changes` is written
- [ ] `Scene Image Brief` exists if the scene has its own card
- [ ] `Media Script` exists if the scene changes music or plays a sting

The deep guide to scenes lives in
[Scenes in depth](../03-mechanics/Scenes%20in%20depth.md).
