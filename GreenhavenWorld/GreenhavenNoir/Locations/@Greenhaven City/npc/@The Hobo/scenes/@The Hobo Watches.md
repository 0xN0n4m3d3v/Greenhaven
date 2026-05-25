# @The Hobo Watches

## Where And When

- Owner: `@The Hobo`
- Location: `@Greenhaven City`
- Visibility: triggers after the hero witnesses a city monologue and did not
  walk away — or when the hero, alone and aimless, wanders into a back alley
  where a trash-can fire is burning without apparent fuel.

## Hook

You turn a corner the city has not shown you before — or perhaps it has, and
you simply did not notice. A narrow alley. Wet brick. A single overturned crate.
And on the crate: a figure wrapped in layers of faded coat and torn scarf,
sitting perfectly still before a trash-can fire.

The fire crackles, but the flame is wrong — too steady, too silent, as if it is
not consuming anything. The figure does not look up. But one grey hand lifts —
slowly, without urgency — and gestures toward the empty space on the crate
beside it.

An invitation. Not to talk. Just to sit.

## Beat By Beat

1. The figure remains still. The fire burns. The rain falls everywhere except
   directly above the crate — as if the alley itself is holding its breath over
   this one spot.
2. If the hero sits: the figure nods once — the smallest movement of the hood.
   Then silence. Long, comfortable silence. The fire pops. The rain provides
   the only conversation. After a minute, the figure slowly extends one hand
   toward the fire, palm up — as if catching warmth, or offering it.
3. If the hero speaks: the figure listens. Does not answer in words. But the
   angle of the hood shifts slightly — attention given. The hero is being heard.
   Not by a person. By the city, through this form.
4. If the hero stays long enough: the figure reaches into a coat pocket and
   produces something small — a dry matchbook, a smooth stone, a scrap of paper
   with a single word written on it. The figure places it on the crate between
   them without explanation. Then returns to stillness.
5. When the hero leaves: the figure does not say goodbye. Does not wave. But
   when the hero looks back from the end of the alley, the fire is already out
   and the crate is empty — as if no one was ever there.

## Player Choices

- Sit beside the figure. Share the silence. The city notices.
- Speak. Say anything — a confession, a question, a curse at the rain. The
  figure listens to all of it equally.
- Stand and watch from a distance. The figure will not pressure you. The
  invitation remains open.
- Take what the figure offers. Examine it. Keep it or leave it.
- Walk past without stopping. The figure does not react. But the fire dims
  slightly as you pass.

## Scene State

- `hobo_watched_hero`: increments each time this scene triggers.
- `hero_sat_with_hobo`: true if the hero ever sat beside the figure.
- `hobo_gave_gift`: the item the figure gave, if any.

## Success Result

The hero has shared a silence with the city's avatar. The figure has witnessed
the hero in stillness. If the hero sat: a small object is given — nothing
powerful, but a token that the city was paying attention.

## Failure Result

If the hero walks past three times without ever stopping, the figure stops
appearing in alleys. It will still come when the hero falls — but it will no
longer invite. The crate will be empty. The fire will not burn.

## Memory And String Changes

`@The Hobo` records every visit. Whether the hero sat. Whether the hero spoke.
What the hero said. The exact date and time — or what passes for time in the
cold design.

## Materializes

- When the hero sits beside the figure for the first time:
  - Entity: `@The Hobo`
  - Type: state / witness bond formed
  - Scope: between hero and `@The Hobo`
  - Effect: the figure now considers the hero someone worth sitting beside —
    not just watching from a distance. Future visits may include small gifts.

## Do Not Do Here

Do not make the figure speak during this scene. This is not @The Hobo Speaks.
This is silence. Presence. Witness. Do not describe the figure's face — even
by firelight, the hood holds its shadow. Do not let the hero touch the figure.

## Scene Image Brief

Image target: `images/the-hobo-watches.png` (1:1). A narrow wet alley at night.
A trash-can fire burning in the centre — flames steady and unnatural. On an
overturned wooden crate beside the fire: a figure wrapped in layers of faded
coats and scarves, hood pulled low, face entirely in shadow. One grey hand
extended toward the fire. An empty space on the crate — clearly an invitation.
Rain falling everywhere except the small zone around the fire. Brick walls
streaked with rust and old graffiti. Style: noir painterly, the fire as single
warm light in cold darkness, deep chiaroscuro. Square 1:1, 2048x2048. No text.

## Media Script

show_media("media_the_hobo_watches", title="The Hobo Watches", caption="A trash-can fire. A hooded figure. An empty space on the crate beside it.")
switch_music("music_the_hobo", label="The Hobo Watches", loop=true, volume=0.38)
