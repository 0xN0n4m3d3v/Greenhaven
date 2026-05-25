# Item reference

An item is anything in the world: a coin, a knife, a note, a
warehouse door. The file lives at
`Locations/.../items/@Name/ItemMind.md`. The folder name carries an
`@`. The file is always called `ItemMind.md`.

## Item Canon — passport of the item

**Why:** the item's type, where it sits, whether it can be taken,
whether it is visible immediately or hidden.

**Required:** yes.

## Description — description

**Why:** the game prose the player sees when they examine the item.
Not a memo to yourself — text for the world.

**Required:** yes.

## Usage — how to use it

**Why:** what the item gives the hero when applied. Concrete actions
and consequences, not vague language.

**Required:** yes.

## Visual Brief — icon brief

**Why:** the brief to the art generator for the item's icon. What it
looks like, in what light, on what background.

Details in [Images](../03-mechanics/Images.md).

The main icon should live here:

```text
items/@Rat Lantern/
|-- ItemMind.md
`-- images/
    `-- icon.png
```

You may use `png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, or an animated
square `webm` / `mp4`. Extra images can live beside the icon if a
quest or scene needs them.

## Media note — items do not auto-play music

The importer can read media files and a `Media Script` from an item
note, but ordinary item focus does not automatically fire music in the
same way locations, scenes, and NPC dialogue do. If using an item
should change music, put the music script on the scene, NPC, or
location that opens after the item is used.

## Materializes — what appears from use

Inventory note: this section can make another item appear in a real
inventory. Use `Scope: hero inventory` to grant the active hero an
item, or `Scope: @NPC Name inventory` to place the item into an NPC,
container, or location holder. Use `count=N` only as a machine token
when more than one item should appear.

**Why:** if using the item opens a door, activates a quest, or calls
in a character, describe it here. Format — four fields.

## Do Not Do Here — narrator boundaries

**Why:** what cannot be done with this item. For example: do not
allow the chest to be opened without a key, do not describe the door
as "already wide open."

---

## Special items: currency

Coins in Greenhaven follow a special rule. Their names are
**hard-coded**, and the engine searches for exactly these strings:

- `@Copper coin` — copper
- `@Silver coin` — silver
- `@Gold coin` — gold

They cannot be named anything else: not `@CopperPiece`, not
`@Copper`, not `@Coin`. Otherwise the compiler will not understand
that money is being discussed, and trade will break.

The exchange rate: one silver equals one hundred copper; one gold
equals one hundred silver.

Currency files live in a dedicated economy folder, not in locations:

```
GreenHavenWorld/
└── Economy/
    └── items/
        ├── @Copper coin/
        │   ├── CopperCoinMind.md
        │   └── images/icon.png
        ├── @Silver coin/
        └── @Gold coin/
```

Details in the [Economy chapter](../03-mechanics/Economy.md).

---

## Checklist

- [ ] `Item Canon` with type and placement
- [ ] `Description` written as game prose
- [ ] `Usage` describes concrete actions
- [ ] If the item needs an icon, `Visual Brief` is filled
- [ ] Inventory rewards use `Materializes` with `hero inventory` or
      `@Name inventory`
- [ ] `images/icon.*` exists if the item appears as a card or reward
- [ ] Currency names are exactly `@Copper coin`, `@Silver coin`,
      `@Gold coin`
