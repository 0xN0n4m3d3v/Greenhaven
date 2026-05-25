# @The City Speaks — Cold Design

## Where And When

- Owner: `@Greenhaven City`
- Location: `@Greenhaven City`
- Visibility: triggers on first arrival at the cartridge start, when the city
  notices the hero for the first time.

## Hook

The rain stops — not because the storm has passed, but because the air itself
has grown still. The flickering sign above you pauses mid-pulse. For one long
moment, the entire city holds its breath. And then the voice comes — not from
anywhere, but from everywhere at once. A grinding of metal. A hum of dying
current. Words formed out of infrastructure.

The road is empty. The sign is meaningless. And the city begins to speak.

## Beat By Beat

1. The city speaks its first truth: *"I am not a dot on a map. I am a machine
   someone forgot to turn off. A vast sleeping beast whose bones are forged
   from rusted iron and whose flesh is cast from blackened concrete."*
2. It describes what it feels: every step the hero takes through its asphalt
   arteries, every breath of poisoned air drawn into lungs that do not belong
   to it.
3. It confesses what it sees: *"I watch you through a million empty, shattered
   windows. You scurry below, in the eternal twilight, thinking your lives
   matter — thinking your suffering is unique."*
4. It delivers the cold verdict: *"I have existed too long. I know every story
   of yours before it begins. Because all of them are just a repetition of the
   same tired motif."*
5. The city pauses. The rain resumes — heavier now, as if the confession has
   cost something. The sign flickers back to its broken rhythm. But the hero
   knows: the city is awake. And it is watching.

## Player Choices

- Stand still and let the rain fall. The city notices stillness.
- Look up at the flickering sign. The pattern shifted during the monologue.
- Walk — try to find the source of the voice. It came from everywhere.
- Speak back. The city does not answer in words, but the rain changes rhythm.

## Scene State

- `city_has_spoken_first`: true after this scene finishes.
- `city_noticed_hero`: true — permanently set for this playthrough.

## Success Result

The hero has heard the city's first confession. The cold design is known. The
city is no longer background — it is presence.

## Failure Result

The hero cannot fail this scene — only refuse to listen. If the hero walks away
mid-monologue, the city records the refusal. The rain grows colder.

## Memory And String Changes

`@Greenhaven City` records that the hero listened — or ran. This shapes every
subsequent monologue.

## Materializes

- When the city finishes speaking:
  - Entity: `@Greenhaven City`
  - Type: state / city awareness
  - Scope: `@Greenhaven City`
  - Effect: the city moves from dormant observation to active narration. Future
    monologues become available.

## Do Not Do Here

Do not let the hero interrupt the city's first words. This is a one-time
confession. The city speaks; the hero listens. The monologue is sacred.

## Scene Image Brief

Image target: `images/cold-design.png` (1:1). A long, empty road stretching into
darkness. A single flickering neon sign on a pole — its light catching the rain
in frozen pulses. The asphalt is wet, reflecting the sign's broken glow. No
people. No vehicles. Just the road, the sign, the rain, and the dark. Style: film
noir photography, high contrast black and white with a single color accent — the
green-orange of the dying neon. Square composition with the sign centered at the
vanishing point.

## Media Script

show_media("media_cold_design", title="The City Speaks — Cold Design", caption="The empty road. The flickering sign. The city begins to speak.")
switch_music("music_cold_design", label="Cold Design — The City's First Confession", loop=true, volume=0.48)
