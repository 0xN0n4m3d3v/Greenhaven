# @The City Speaks — Crimson Dusk

## Where And When

- Owner: `@Greenhaven City`
- Location: `@Greenhaven City`
- Visibility: triggers when the hero stands still under the rain for the first
  time — the city responds to stillness with a darker confession.

## Hook

You stop walking. The rain does not stop falling, but it changes — the drops
grow heavier, warmer, as if the sky is pressing down. Above you, the skyline
turns its hollow visage toward a dying, crimson sun. The towers do not gleam.
They bleed.

The city's voice returns — lower now, almost a growl. It wants to show you
something.

## Beat By Beat

1. The city shows the skyline: *"The towers turn their hollow faces toward the
   dying sun. It does not bring relief. It only paints my barren spires the
   color of clotted blood. Sparks of fire and short circuits flare in golden
   storms of smog."*
2. The city describes its gutters: *"This is when my gutters choke. It is not
   just water that flows through them — it is a mixture of freezing rain, cheap
   alcohol, and your spilled blood. Crimson rivers flood the drains, flushed
   with drunken red."*
3. The city shows the shadows: *"The shadows twist in violent spasms at my
   crossroads. Madness dances its dance for those who are already dead but have
   not yet understood it. Watch. This is what happens every dusk in the cold
   design."*
4. The rain slows. The crimson in the sky begins to drain, leaving only the
   permanent grey. The city's voice drops to a murmur: *"You will see this
   sunset again. You will see it many times. And each time, you will stand a
   little closer to the gutter."*

## Player Choices

- Watch the skyline bleed. The city respects a spectator.
- Look down at the gutter. There is something in the water that was not there
  before.
- Close your eyes. The city will still describe what it sees to you.
- Ask the city why it shows you this. The answer comes in the next toll of the
  distant bell — heavy, iron, without explanation.

## Scene State

- `city_showed_dusk`: true after this scene finishes.
- `hero_watched_skyline`: true if the hero watched; false if they turned away.

## Success Result

The hero has seen the city's second face — the bleeding skyline, the dancing
shadows, the truth of what flows through the gutters at sunset.

## Failure Result

If the hero turns away before the skyline bleeds, the city records the
cowardice. The rain grows fractionally colder for the rest of the playthrough.

## Memory And String Changes

`@Greenhaven City` records whether the hero watched the crimson dusk or looked
away. Future monologues reference this choice.

## Materializes

- When the city finishes showing the crimson dusk:
  - Entity: `@Greenhaven City`
  - Type: state / city deeper awareness
  - Scope: `@Greenhaven City`
  - Effect: the city has shown the hero its blood. The relationship between city
    and hero deepens from observation to shared witness.

## Do Not Do Here

Do not make the sunset beautiful. It is not beautiful. It is hemorrhaging. The
colors are the colors of a wound, not a painting. Do not let the hero save
anyone in the gutter during this scene — the monologue is about inevitability,
not intervention.

## Scene Image Brief

Image target: `images/crimson-dusk.png` (1:1). A skyline of crumbling concrete
towers silhouetted against a dying sun — the sky bleeding from deep orange to
surgical red to the bruised purple of night. In the foreground, a gutter
overflowing with water that has a distinctly red tint, reflecting the sky.
Steam rises from a grate. Two shadows on a nearby wall are bent at angles that
do not match any visible light source. Style: dark painterly noir, heavy on the
reds, wet surfaces throughout. Square composition. No text, no UI, no people
visible — only their wrong shadows.

## Media Script

show_media("media_crimson_dusk", title="The City Speaks — Crimson Dusk", caption="The skyline bleeds. The gutters choke. The shadows twist in violent spasms.")
switch_music("music_crimson_dusk", label="Crimson Dusk — The Skyline Bleeds", loop=true, volume=0.55)
