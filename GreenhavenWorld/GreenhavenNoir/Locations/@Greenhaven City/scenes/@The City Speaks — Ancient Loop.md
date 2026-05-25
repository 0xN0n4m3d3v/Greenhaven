# @The City Speaks — Ancient Loop

## Where And When

- Owner: `@Greenhaven City`
- Location: `@Greenhaven City`
- Visibility: triggers when the hero experiences a defeat, death, or
  irreversible loss in the city — the moment when hope breaks.

## Hook

Something has broken. A plan. A life. Perhaps your own. The rain hits harder
now — each drop a small accusation. The city does not comfort. It does not
apologize. Instead, the grinding beneath the pavement grows louder: the sound of
gears that were turning long before you arrived, and will turn long after you
are gone.

The voice returns — not triumphant, not cruel. Simply factual. A machine
reporting its observations.

## Beat By Beat

1. The city states the fact of the loop: *"I digest your hopes. I chew through
   your fates. And when you break — when your bodies finally cool on my wet
   sidewalks — nothing changes for me. The circle simply begins again."*
2. The city recites the elements of the loop — the same elements the hero has
   already experienced: *"You will die. And the circle starts from the top: the
   cold rain. The icy river. The dark that cannot stop. The sign. The empty
   road. The pain."*
3. The city reveals its perspective: *"I have seen this exact sequence play out
   more times than you have drawn breath. You are not the first to lie here
   bleeding. You will not be the last. Your tragedy is not original — it is
   maintenance."*
4. The grinding beneath the pavement slows. The city has finished its report.
   The rain continues. The sign continues to flicker. Nothing has changed —
   except that the hero now knows the shape of the loop they are trapped in.

## Player Choices

- Lie still and accept the city's verdict. The loop will start again.
- Stand up. Defiance is also part of the loop — the city has seen it before.
- Ask the city: *how many times?* The answer is not a number. It is the sound
  of rain on a million windows.
- Refuse to believe. The city does not argue. It has time.

## Scene State

- `city_revealed_loop`: true after this scene finishes.
- `hero_entered_loop`: permanently true for this playthrough — the hero is now
  part of the cycle.

## Success Result

The hero has heard the oldest truth of @Greenhaven City: the loop exists.
Everything repeats. Knowing this is the first step toward understanding the
city — or surrendering to it.

## Failure Result

There is no failure state. The city's truth does not depend on the hero's
acceptance. The loop continues regardless.

## Memory And String Changes

`@Greenhaven City` records the moment the hero learned about the loop. This
knowledge changes the tone of all future city monologues — from introduction to
continuation.

## Materializes

- When the city finishes the loop confession:
  - Entity: `@Greenhaven City`
  - Type: state / eternal cycle acknowledged
  - Scope: `@Greenhaven City`
  - Effect: the city treats the hero as a knowing participant rather than a
    newcomer. The hero is now threaded into the loop.

## Do Not Do Here

Do not offer comfort. The ancient loop is not a tragedy to be soothed — it is a
fact to be faced. Do not break the fourth wall to suggest the player reload a
save. The loop is in-fiction, not meta.

## Scene Image Brief

Image target: `images/ancient-loop.png` (1:1). A wet sidewalk in extreme
close-up. Raindrops hitting the asphalt in frozen concentric circles. In the
reflection of the water: a flickering neon sign, an empty road, and a
silhouetted figure lying still. The reflection is a perfect circle — suggesting
repetition, a loop. Beyond the puddle: darkness. Style: abstract noir
photography, extreme shallow depth of field, almost monochromatic with a single
thread of neon green cutting through the reflection. Square composition. No
text.

## Media Script

show_media("media_ancient_loop", title="The City Speaks — Ancient Loop", caption="A wet sidewalk. A puddle reflecting a flickering sign. The circle begins again.")
switch_music("music_ancient_loop", label="Ancient Loop — The Circle Begins Again", loop=true, volume=0.45)
