# Materializes: how the world responds

In an ordinary game, a door is either open or it is not, and the
scenarist decides which before the player arrives. In Greenhaven, a
door can **appear** — not pop out of thin air, but become visible and
walkable exactly when the hero has done something. Picked up a key.
Read a note. Earned the harbor scout's trust.

The mechanism is called **materialization**. If Greenhaven had one
single most important idea, this would be it. The world is not just
described — the world **changes from what the player does**.

## What a materialization block is

A materialization is a small block of four fields you write directly
into an ordinary note. Inside a location, inside a character, inside a
quest, inside a scene, even inside an item — wherever it fits.

The block answers four questions:

- **What appears?** — `Entity`
- **What kind of change is this?** — `Type`
- **Where does it act?** — `Scope`
- **What concretely is the effect?** — `Effect`

Here is what one looks like:

```markdown
- When the hero asks the way to the center:
  - Entity: `@Harbor Street`
  - Type: access / route
  - Scope: `@Greenhaven Port`
  - Effect: the route up `@Harbor Street` to `@Greenhaven Main Square`
    becomes a walkable exit.
```

Read it slowly. It makes a sentence:

> "When the hero asks the way to the center, the route `@Harbor
> Street` materializes inside the port — it opens as a new exit and
> leads to the main square."

That is the language of Greenhaven. You write a rule, and the engine
carries it out.

## Where to write them

Materializations live **inside** existing notes — in a `## Materializes`
section. There is no separate file for them. You can put them:

- In a location — what happens when the hero does something at this
  place.
- In a character — what happens when the hero does something in their
  presence.
- In a quest — what appears as a consequence of each outcome.
- In a scene — what is left behind after the scene.
- In an item — what happens when the item is used.

One block — one rule. Several rules — several blocks in a row.

## Live examples

### In a location

The port can open the street to the square, the noticeboard's clue,
and the cellar hatch — depending on what the hero does:

```markdown
## Materializes

- When the hero asks the way to the center:
  - Entity: `@Harbor Street`
  - Type: access / route
  - Scope: `@Greenhaven Port`
  - Effect: the route up `@Harbor Street` to `@Greenhaven Main Square`
    becomes a walkable exit.

- When the hero reads the sheet on the arrivals board:
  - Entity: `@Missing Passenger Notice`
  - Type: item / clue
  - Scope: `@Greenhaven Port`
  - Effect: the notice becomes an inspectable clue, opening the
    investigation of the missing passenger.

- When the hero opens the hatch under Blue Warehouse:
  - Entity: `@Blue Warehouse Cellar Door`
  - Type: access / threat
  - Scope: `@Greenhaven Port`
  - Effect: access to the cellar becomes an interactable threat
    object, opening the rats investigation and the first combat path.
```

### In a character

Tessa keeps a "true ledger" — a private notebook of what matters. When
the hero reveals a particular clue in her presence, the ledger becomes
a public record:

```markdown
## Materializes

- When the hero reveals the `@Cassian Flintbanner` wax pattern in my
  presence:
  - Entity: `@Stolen Guild Seal`
  - Type: state / public evidence
  - Scope: cross-hub
  - Effect: I take out my true ledger and add the seal to the public
    record.
```

### In a quest

In "Tessa's Compass," one outcome opens an additional possibility with
a neighboring character:

```markdown
## Materializes

- When the hero returns the compass to its true owner:
  - Entity: `@Mara Sunledger`
  - Type: state / square trust
  - Scope: `@Greenhaven Main Square`
  - Effect: Mara's underground notice exchange opens to the hero for
    one favor.
```

## Kinds of change

The `Type` field is a word or short phrase that signals to the engine
(and to you as the author) the kind of change being made. It is not a
rigidly fixed list — more a vocabulary of common labels. The most
frequent:

| Type                         | When to use                                       |
| ---------------------------- | ------------------------------------------------- |
| `access / route`             | Opens a new passage, route, or transition         |
| `item / clue`                | A new item or clue appears                        |
| `state / public evidence`    | A public state changes, an entry in a registry   |
| `state / square trust`       | A reputation or trust shifts                      |
| `location / district access` | A new district or location opens                  |
| `quest pointer`              | A pointer to a follow-up quest activates          |
| `access / threat`            | Access to a threat opens (monsters, enemies)      |

Do not over-think the vocabulary. Use what fits. What matters is that
**what changes** is visible.

## What Scope is

The `Scope` field is the **area of effect** of the materialization.
Where it is visible, where it operates.

- If the effect is in a single location, write the name of the
  location: `@Greenhaven Port`.
- If the effect spans several places, write `cross-hub`.
- If the effect is a shift between two characters, write `between
  hero and Tessa`.

## Inventory materialization

A cartridge can also use `Materializes` to put a real item into an
inventory. This is not narrator-only prose. At runtime the engine
creates or reuses the item entity, creates or reuses the inventory
catalog row, and writes the item into the target holder inventory.

Use this when a quest gives the hero a key, when an NPC pockets a
clue for a later scene, when a merchant receives a proof document, or
when a container should gain a newly revealed object.

There are two supported inventory scopes:

```markdown
Scope: hero inventory
Scope: `@Tamara Vey inventory`
```

The first grants the item to the active hero. The second grants the
item to the named non-player holder. The named holder can be an NPC,
a container, or a location that exists in the cartridge. Keep the
syntax exact: write the `@Name` immediately followed by `inventory`.
Do not invent translated variants or aliases for this contract.

The item count is optional. If omitted, the engine grants one item.
If you need more, put the machine token `count=N` in `Scope` or
`Effect`:

```markdown
## Materializes

- When Tamara accepts the hero as a witness:
  - Entity: `@Blue Warehouse Key`
  - Type: item / access-state
  - Scope: hero inventory
  - Effect: the hero receives the key to the Blue Warehouse hatch.

- When Tamara prepares the raid:
  - Entity: `@Dock Pass`
  - Type: item / clue
  - Scope: `@Tamara Vey inventory`
  - Effect: Tamara keeps count=2 dock passes for the next scene.
```

Currency is intentionally excluded from this materializer path. Coins
belong to the economy and reward/trade tools, because currencies need
denomination rules and price math.

If the `Entity` item does not exist yet, the runtime creates a
deterministic materialized item entity for this playthrough. If the
item already exists in the cartridge, the runtime reuses it. Either
way, the materializer is still idempotent: the same rule fires only
once for the hero's current playthrough.

## Runtime creation

Materializers are the official cartridge-side way to create runtime
state. The `Entity` field may point to an existing `@Name` or to a
new `@Name` that will be created only when the trigger happens.

Common runtime creation patterns:

```markdown
## Materializes

- When the hero breaks the cellar lock:
  - Entity: `@Rats Under The Blue Warehouse`
  - Type: state / threat
  - Scope: `@Greenhaven Port`
  - Effect: the rat threat becomes active under the warehouse.

- When the hero finds the hidden stair:
  - Entity: `@Blue Warehouse Cellar`
  - Type: location / hidden-exit
  - Scope: `@Greenhaven Port`
  - Effect: a walkable route opens between the port and the cellar.

- When Mikka agrees to travel:
  - Entity: `@Mikka Companion Contract`
  - Type: state / service
  - Scope: between hero and `@Mikka`
  - Effect: Mikka becomes available as a paid companion for this run.
```

The author writes the rule in the cartridge. The engine applies it in
the live world, records that it was applied, and avoids duplicate
creation on later turns.

## Hero directives

Materializers can also change the active hero. This is how a
cartridge scenarist gives the hero a local starting condition,
adds a cartridge-specific backstory correction, or lets the hero
speak a scripted line when the world has earned it.

For `hero / ...` materializers, `Entity` should normally point to
the existing quest, scene, or location that owns the beat. The runtime
applies the effect to the active hero; using a brand-new `@Hero ...`
entity is usually unnecessary and will make validation ask a create
question.

Use these sparingly. The player still owns the hero. A cartridge
directive should not erase the player's created character; it should
add the facts this world needs in order to react correctly.

### Backstory and profile prompt

Use `hero / backstory`, `hero / profile`, or `hero / profile-prompt`
when this cartridge needs to reinterpret part of the hero's origin.
The effect is saved into the hero profile as a cartridge directive
and is included in future narrator/player context.

```markdown
## Materializes

- When the hero accepts Tamara's witness contract:
  - Entity: `@Tamara's First Contract`
  - Type: hero / backstory
  - Scope: active hero profile
  - Effect: Treat the hero as someone whose past contains one
    unresolved contact with port smuggling. Do not invent the exact
    crime; use it only as pressure when Blue Warehouse evidence
    appears.
```

This does not delete the original backstory. It appends a durable
cartridge correction. Later NPCs and scenes can react to that
correction because it is part of the hero context.

### Starting or scene status

Use `hero / status` when the cartridge needs a compact state on the
hero: mood, wound, disguise, oath, marked, hunted, blessed, cursed,
or any other short status your scenes can reference.

The clearest form is:

```markdown
## Materializes

- When the hero opens the Blue Warehouse hatch:
  - Entity: `@Rats Under The Blue Warehouse`
  - Type: hero / status / mood
  - Scope: active hero
  - Effect: value=watchful; intensity=0.75; reason=the hatch feels
    familiar from the hero's corrected port backstory
```

`Type: hero / status / mood` sets the status kind to `mood`. The
`Effect` may contain `value=...` and `intensity=0.0..1.0`. If omitted,
the engine uses the first sentence of the effect as the status value.

### Scripted hero voice

Use `hero / voice` when the cartridge gives the hero permission to
speak without waiting for a typed player command. This is for rare
authored beats: oaths, involuntary memories, recognition lines,
ceremonial answers, or a moment where the player's created hero has
already committed to a role.

```markdown
## Materializes

- When Tamara asks whether the hero recognizes the black ribbon mark:
  - Entity: `@Arrival With A Revolver`
  - Type: hero / voice
  - Scope: active hero speech
  - Effect: line=I know this mark. Someone used it on the last
    manifest I was paid to forget.
```

The line is persisted as a hero chat bubble with source
`cartridge_hero_voice`. NPCs present in the location can treat it as
something the hero actually said. Do not use this to steal ordinary
player agency; use it only after the player has accepted the scene,
quest, oath, bond, or consequence that justifies the line.

## A few important rules

**The entity carries `@`.** If you materialize `@Mara Sunledger` and
she does not yet exist in the cartridge, that is fine — the record
flags her as a "concept character." But the name must be unified: if
you create Mara later, the name must match letter for letter.

**Effect — a concrete action.** Not "something changes" but "the
route opens as a walkable exit." The more precise you are, the less
the narrator has to guess.

**A materialization fires once.** When the condition is satisfied and
the effect applies, it does not repeat. This is not a loop, it is a
move in the story.

**Conditions must be observable.** Not "when the hero behaves
honestly" but "when the hero publicly refuses the fixer." This rule is
universal across Greenhaven: write actions, not intentions.

## How a materialization reaches the game

To make the off-stage process clear:

1. You write a materialization block in a note.
2. When the world is assembled into a cartridge, a script reads those
   blocks and turns them into a list of rules.
3. While the game runs, the engine checks on every turn: has any
   condition been satisfied?
4. If it has, the effect applies and the player sees the result.

For now, hold onto one idea: you write rules in plain words, and the
engine carries them out.
