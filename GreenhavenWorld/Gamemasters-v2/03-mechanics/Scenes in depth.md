# Scenes in depth: rhythm and impact

For most of the game the world improvises. The narrator reads who is
present in a location, what their desires and fears are, and decides
what to say. But sometimes you need a **specific moment**. The first
meeting with Tessa needs to be exactly that. The brawl at the
gangway needs to advance by beats. The argument on the square needs
to play out the way you wrote it.

That is a scene — a prepared sequence with a trigger, beats, and
choice forks. This chapter is about how to write them.

## Two kinds of scenes

Scenes live either "with a character" or "with a place."

**Character-owned scene** belongs to a specific person and lives in
their folder: `npc/@Name/scenes/@Title.md`. Use it for anything that
is **about character**: first meeting, confession, duel, betrayal.

**Location-owned scene** belongs to a location and lives in
`@Location/scenes/@Title.md`. Use it for anything **about place**:
a brawl at the crates, an accusation at the gangway, a hearing at
the guild. Different participants can be drawn into it depending on
who is nearby.

The file name carries `@`. The level-one heading inside is
`# @Scene name`.

## Where And When — the trigger

This is where you describe the **conditions** under which the scene
"comes alive."

```markdown
## Where And When

- Owner: `@Tessa Wrenlight`
- Location: `@Greenhaven Port`
- Visibility: triggers after `@Dockside Accusation` first beat
  or when hero approaches the arrivals post for the second time.
```

There are three parts. **Owner** — who the scene belongs to.
**Location** — where it takes place. **Visibility** — the condition
that fires it. The condition must be **specific**: "after the first
beat of scene X," "when the hero approaches the noticeboard for the
second time." Not "sometimes," not "by mood."

## Hook — opening beat

What the player sees in chat the moment the scene fires. Short,
precise prose:

```markdown
## Hook

`@Tessa Wrenlight` stands by the crates, brass compass tucked into
her coat. She does not come over. She watches, decides, and will
speak first only if the hero looks competent.
```

Notice: the hook already has a **possibility of choice** baked in.
Tessa might not speak. It depends on how the hero carries themselves.
Good hooks leave that crack open.

## Beat By Beat — the beat-by-beat script

Beats are the scene's skeleton. Each beat is one turn for the
narrator. They unfold in order, unless the player does something
unexpected.

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

The cardinal rule of beats: they are a **skeleton**, not **rails**.
If the player walks out mid-scene, the narrator is under no
obligation to drag them back. If the player says something not
covered by the beats, the narrator improvises — but **in keeping
with** what the character is.

Beats are a dotted line. Between the dots is the living tissue, woven
by the narrator out of the character's voice.

## Player Choices — options for the player

This is a **hint** to the narrator, not a strict list. "Here is what
the player can do, and here is how the character reacts."

```markdown
## Player Choices

- Insist: ask her name. She gives it.
- Ask about the port: she answers briefly.
- Walk past: she watches and remembers.
- Pay for information: she refuses.
```

If the player does something not on the list, the narrator works it
out from the character. This section is not a cage; it is a map of
the most common moves.

## Success Result and Failure Result

What counts as "went well" and "went badly":

```markdown
## Success Result

If the hero asked her name and did not try to buy information,
positive strings with Tessa — the companion track opens.

## Failure Result

If the hero tried to pay or push, negative strings — Tessa closes
down.
```

## Memory And String Changes

What the world will remember and which relationships will shift:

```markdown
## Memory And String Changes

`@Tessa Wrenlight` writes down the first thing the hero said in her
mental ledger. This is the first +string or -string entry.
```

## A combat scene — an example

Scenes are useful for more than dialogue. Here is how a short combat
scene is written for Mikka:

```markdown
# @Mikka close combat dagger

## Where And When

- Owner: `@Mikka`
- Location: `@Town square`
- Visibility: triggers when an enemy closes to melee range with @Mikka
  while she is cornered and cannot retreat.

## Beat By Beat

1. @Mikka drops into a low stance, dagger reversed.
2. She aims for the enemy's weapon hand or belt — not the heart.
3. If the enemy overcommits, she sidesteps and cuts the back of the knee.
4. If the enemy retreats a step, she does not pursue.
5. She fights to open an escape window, not to kill.
```

Notice: even the fight is written as **character**. Mikka does not
fight to kill — she fights to break out. That is her voice, carried
into action. A combat scene is not "a damage mechanic"; it is
**character by other means**.

![[Gemini_Generated_Image_p4r02jp4r02jp4r0.png]]

## A few rules to take away

**A scene belongs to whoever's folder it sits in.** Character-owned —
character. Location-owned — atmosphere of the place. This is not just
administrative: it decides whose **voice** the scene will be in.

**Beats are not dialogue.** They are structure. The narrator picks
the words from the character's voice.

**`Materializes` inside a scene is a powerful tool.** A scene can
leave a clue, open a door, shift a relationship. If the moment is
important, materialize its consequences.

**`Memory Hooks` in a scene are not the same as `Memory Hooks` on a
character.** A scene remembers the **fact of the event**. A character
remembers the **relational stance**. They are two different memories
and they complement each other.
