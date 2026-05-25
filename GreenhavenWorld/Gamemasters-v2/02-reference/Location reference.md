# Location reference

A location's mind file lives at
`Locations/.../@Location/<NameWithoutSpaces>Mind.md`. The level-one
heading is `# @Name`. After that come sections, each with a `##`
heading.

## First Entry Bubble — first frame

**Why:** exactly the text the player sees the first time they enter
this place. This is the **most important** section in any location.
Write it as the first sentence of a novel, not as a memo to yourself.

**Required:** yes.

Detailed walkthrough in
[Your first location](../01-getting-started/Your%20first%20location.md).

## Place Canon — passport of the place

**Why:** the character of the location, its parent place, time of
day, weather, mood.

## Sensory Identity — the five senses

**Why:** the raw material the narrator uses for atmospheric beats.
One sense per line: color, sound, smell, texture, motion. With
concrete details, not generalities.

## Visible Exits — where you can go

**Why:** a list of exits with the names of other locations through
`@`. The engine builds navigation buttons automatically.

```markdown
## Visible Exits

- Up `@Harbor Street` to `@Greenhaven Main Square`.
- Up `@Charter Steps` to `@Greenhaven Adventurers' Guild`.
```

## Points Of Interest — what to touch here

**Why:** the list of important objects inside the location: a
noticeboard, crates, the warehouse door, a chipped stone. The hero can
approach them.

## Immediate Player Actions — first moves

**Why:** what the player can do in the first few seconds. Helps the
narrator offer meaningful actions instead of leaving the hero in a
vacuum.

## Hostile And Rival Pressure — threats

**Why:** who or what in this place presses on the hero. Without
threat a location is a postcard. Details in
[Your first location](../01-getting-started/Your%20first%20location.md).

## Memory And Consequence Hooks — what the world remembers

**Why:** which of the hero's actions in this location should be
recorded for the long term. Not "the hero stood next to the lantern"
but "the hero publicly accused the wrong dockhand."

## Materializes — what appears from actions

**Why:** changes in the world that occur after specific player
actions in this location. Format — four fields.

Details in [Materializes](../03-mechanics/Materializes.md).

## Do Not Do Here — narrator boundaries

**Why:** the "do not do" list for this place.

## Establishing Image Brief — establishing-shot brief

**Why:** the brief to the art generator for the "view of the place":
what to show, in what light, in what mood. If the location should
have a postcard-style image the player sees on arrival, fill this in.

Details in [Images](../03-mechanics/Images.md).

The actual card file should live next to the location mind file:

```text
@Greenhaven Port/
|-- GreenhavenPortMind.md
`-- images/
    `-- establishing.png
```

You may use `png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, `mp4`, or
`webm`. A square `webm` is useful for a living establishing card:
rain, signs, smoke, sails, candlelight, crowd movement.

## Media Script — location music and ambience

**Why:** music attached to a location starts when the hero enters that
place or when a saved session restores into it. Use it for district
themes, market ambience, tavern music, rain, distant bells, or any
sound bed that belongs to the place itself.

Put the audio file inside the location folder:

```text
@Greenhaven Port/
|-- GreenhavenPortMind.md
`-- music/
    `-- greenhaven-port.mp3
```

Then reference it from the location mind:

```markdown
## Media Script

switch_music("music_greenhaven_port", label="Greenhaven Port", loop=true, volume=0.55)
```

The file name becomes a role automatically. `music/greenhaven-port.mp3`
becomes `music_greenhaven_port`. Supported audio formats are `mp3`,
`ogg`, `m4a`, and `wav`. Supported video formats are `mp4` and `webm`.

Use location music as the default atmosphere. If a scene or NPC later
needs a stronger theme, their own `Media Script` can switch away from
the location track.

---

## Checklist

- [ ] `First Entry Bubble` written as game prose
- [ ] `Sensory Identity` covers all five senses
- [ ] `Visible Exits` lead to real or planned locations
- [ ] At least one threat in `Hostile And Rival Pressure`
- [ ] At least three blocks in `Materializes`
- [ ] `Establishing Image Brief` matches `images/establishing.*`
- [ ] `Media Script` exists if the place has its own music or ambience
- [ ] All entity names carry `@`
