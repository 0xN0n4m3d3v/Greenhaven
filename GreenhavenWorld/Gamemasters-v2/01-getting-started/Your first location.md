# Your first location

A good place in a game is not a guidebook description — it is the
sensation that you have actually arrived. When the hero steps into the
port, they should feel the warm planks under their boots, hear the
customs clerk shouting, notice the two strangers in black armbands
watching them a little too openly. A location is atmosphere, choice, and
threat, all packed into a single file.

![[Gemini_Generated_Image_rmvs9rrmvs9rrmvs.jpg]]

In this chapter we will turn the skeleton port you set up in the last
chapter into a place worth lingering in.

## What a location is made of

A location's mind file (your `PortMind.md`) is divided into sections.
Each section starts with a level-two heading `##` and an English service
name. Do not be alarmed by the count: only one is strictly required; the
rest are tools you bring in as the place gets more complex.

**Required:**

- **First Entry Bubble** — the first frame the player sees on arrival.

**Strongly recommended:**

- **Place Canon** — a quick passport of the place: its character, time of
  day, mood.
- **Sensory Identity** — the five senses: color, sound, smell, texture,
  motion.
- **Visible Exits** — where you can go from here.
- **Points Of Interest** — a few key objects or sub-places the hero can
  approach.
- **Immediate Player Actions** — what the player can do in the first few
  seconds.
- **Hostile And Rival Pressure** — who or what threatens the hero here.
- **Memory And Consequence Hooks** — what the world will remember about
  the hero's actions here.
- **Materializes** — what appears in the world when the hero does
  something.
- **Do Not Do Here** — a list of "don'ts" for the narrator.

Let's walk through them — and at the end you will see the finished port.

## First Entry Bubble — the heart of the place

This is the most important section. The text under it is what the player
sees in chat as the port's first message. Not a note to yourself as the
author — the actual sentence with which the world says *hello*.

Bad version — this is a memo to yourself:

> A port. Sunny. Has a gangway, customs, crates.

Good version — this reads like a living scene:

> The wind smells of citrus crates, hot rope, and fish glue. A customs
> clerk in a faded sash is shouting at a dockhand about a missing crate.
> A young woman is pinning a fresh sheet of paper to the arrivals board,
> her teeth caught on her lower lip. Two dockworkers in black armbands
> are watching you a little too openly. The sun is bright enough that
> everything looks like the poster for an adventure novel.

Do you feel the difference? The second one has specific people (clerk,
woman, dockworkers), specific smells, specific tension (the strangers
watching the hero). The player immediately sees a choice: approach the
woman, talk to the clerk, watch the dockworkers. The place is not
described — it is *happening*.

The trick: write as if it were the first sentence of a novel. Not "here
is what is here," but "here is what is happening as you arrive."

## Sensory Identity — the five senses

The engine uses this section, between events, to slip in small
atmospheric beats. If you skip it, the world will speak in flat
generalities. If you fill it in, it will start smelling, ringing, and
moving on its own.

Write one sense per line, with concrete detail in each:

```markdown
## Sensory Identity

- Color: turquoise water, indigo and orange sails, sun-bleached planks,
  red customs-house tile.
- Sound: gulls, capstans, cargo bells, the distant horns of skyships.
- Smell: citrus crates, hot rope, tar, frying fish.
- Texture: warm planks under your boots, wet rope fiber on the rails.
- Motion: porters running between nets, a skyship descending on three
  cables, a courier limping down the stairs.
```

Notice: I do not say "pleasant smell" or "loud sounds." I name the
**objects** that produce those smells and sounds. Citrus crates. Bells.
A courier limping down the stairs. That gives the narrator material to
shape new sentences out of, every time.

## Visible Exits — where you can go

Every living place has exits. They are not just arrows on a map — they
are promises: "you can go that way, and something is happening there
too."

```markdown
## Visible Exits

- Up @Harbor Street to @Greenhaven Main Square.
- Up @Charter Steps to @Greenhaven Adventurers' Guild.
```

Street and square names carry the `@`. The engine sees them and builds
the navigation buttons in the interface automatically. The player clicks
and moves. If `@Greenhaven Main Square` does not exist yet — no problem,
you will write it later. What matters is that the name matches when you
do.

## Hostile And Rival Pressure — the threats

Without a threat, a location is a postcard. If nobody in the port is
getting in anyone's way, the player has nothing to choose. A good threat
is not necessarily a sword at the throat. It is pressure: "here is a
situation that will get worse if you do nothing; here are people who
play on a different side from yours."

```markdown
## Hostile And Rival Pressure

- A rival adventuring team is already in the port. They wear black
  armbands and laugh at other people's mistakes.
- A smuggler-fixer circulates between the warehouse and customs offering
  "help" that always leaves someone else holding the blame.
- The harbor watch is ready to arrest the wrong person quickly if the
  crowd pushes them.
```

Each of these threats creates a fork. The rival team is competition. The
fixer is temptation. The watch is the pressure of the mob. The player
will have to choose whose back to turn on.

## Materializes — how the world responds

This is the section in which Greenhaven's central promise actually
happens: **the world changes because of what the player does.** Here you
describe what appears in the world after specific actions by the hero.

```markdown
## Materializes

- When the hero asks the way to the center:
  - Entity: `@Harbor Street`
  - Type: access / route
  - Scope: `@Greenhaven Port`
  - Effect: the route up `@Harbor Street` to `@Greenhaven Main Square`
    becomes a walkable exit.

- When the hero reads the fresh sheet on the arrivals board:
  - Entity: `@Missing Passenger Notice`
  - Type: item / clue
  - Scope: `@Greenhaven Port`
  - Effect: the notice becomes an inspectable clue, opening the
    investigation of the missing passenger.
```

Each block has the same shape — four fields. What appears, what kind of
change, where it acts, what the effect is. At first this can feel
formal, but that is exactly its power: the writer states one simple rule
and the engine carries it out the moment the hero performs the trigger
action.

There is a whole chapter on materializations:
[Materializes](../03-mechanics/Materializes.md). For now remember this:
if you want the world to change, describe it here.

## A short checklist

Before you close the location file, ask yourself:

- Does the `First Entry Bubble` read like game prose, not like a note to
  yourself?
- Does `Sensory Identity` cover all five senses?
- Do the `Visible Exits` lead to real or planned locations?
- Is there at least one threat in `Hostile And Rival Pressure`?
- Are there at least three blocks in `Materializes`?
- Are all entity names written with `@`?

If everything is "yes" — the location is ready.

## What's next

The place exists. Time to settle a real person in it. Open
[Your first NPC](Your%20first%20NPC.md).

---

## Reference

**Required section**

- `## First Entry Bubble`

**Recommended sections**

- `## Place Canon`
- `## Sensory Identity`
- `## Visible Exits`
- `## Points Of Interest`
- `## Immediate Player Actions`
- `## Hostile And Rival Pressure`
- `## Memory And Consequence Hooks`
- `## Materializes`
- `## Do Not Do Here`
- `## Establishing Image Brief` — for generating the location's image.

**Full specification** lives in the
[Location reference](../02-reference/Location%20reference.md).
