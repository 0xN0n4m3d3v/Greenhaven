# @The City Speaks — Midnight Bell

## Where And When

- Owner: `@Greenhaven City`
- Location: `@Greenhaven City`
- Visibility: triggers when the hero approaches the Crumbling Tower at night —
  drawn by the sound of grinding metal, or by the silence that precedes
  something vast.

## Hook

The Crumbling Tower rises above you — a black spire against a blacker sky. For
a long moment, there is nothing. The rain seems to hold its breath. The
flickering sign in the distance pauses mid-pulse. Even the grind beneath the
pavement goes quiet.

And then — a sound that is not a sound. A vibration that starts in the soles of
your boots and climbs through bone, through blood, through the spaces between
your thoughts. The copper lung at the tower's peak expands. Contracts. And
speaks.

The bell. The midnight bell. The city's heartbeat made audible. It has been
silent for longer than you have been alive. But tonight, it reclaims its power.
And it bares its heavy, iron tongue.

## Beat By Beat

1. The bell tolls once. The sound is not loud — it is DEEP. It rearranges the
   air. Windows that have been dark for decades flicker with the vibration.
   The rain briefly falls upward.
2. The city speaks through the bell's resonance: *"High upon my crumbling
   tower, through the booming copper lung, the midnight bell reclaims its
   power. And bares its heavy, iron tongue."*
3. Toll two. The city tells the hero what the bell means: *"This is my
   heartbeat. This is my reminder to you. The dark. The empty road. The
   flickering sign. The pain that cannot be stopped. The bell does not warn —
   it confirms. You are here. You are part of this. And you will hear this
   sound again."*
4. Toll three. The city's voice drops to something almost tender — the
   tenderness of inevitability: *"I have rung this bell for every soul that
   has passed through my streets. You are not special. But you ARE counted.
   The bell knows your name. And it will tell the city."*
5. The final toll fades. The rain resumes its downward path. The sign resumes
   its broken rhythm. The grinding beneath the pavement returns — but now it
   has a partner: an echo, a resonance, the memory of the bell living in the
   iron bones of the city.

## Player Choices

- Stand at the base of the tower and let the vibrations pass through you.
  The city marks you.
- Look up at the bell. It is still swinging, slowly, a dark shape against
  the clouds.
- Touch the tower's wall. The iron is warm — alive — and you can feel the
  bell's echo traveling down through the stone.
- Walk away before the final toll. The city will remember. The bell will not.

## Scene State

- `bell_tolled_for_hero`: true after this scene finishes.
- `hero_marked_by_bell`: true — the hero's name is now known to the city's
  deepest mechanism.
- `bell_toll_count`: the number of times the bell rang (starts at 1, increments
  each time the scene triggers in a playthrough).

## Success Result

The hero has heard the city's heartbeat. The midnight bell has tolled. The city
has counted the hero among its known souls — not special, but acknowledged. The
bell will toll again, and each time it does, the hero will feel it before they
hear it.

## Failure Result

If the hero flees before the third toll, the city records the flight. The bell
will not ring for them again — not out of punishment, but because the bell
rings only for those who stay.

## Memory And String Changes

`@Greenhaven City` records that the bell has tolled for this hero. The bell toll
count is permanent and cumulative across scenes.

## Materializes

- When the bell finishes its tolling:
  - Entity: `@Greenhaven City`
  - Type: state / city heartbeat acknowledged
  - Scope: `@Greenhaven City`
  - Effect: the bell is now awake. The city's deepest mechanism is active. Every
    subsequent midnight scene in the cartridge will reference this toll.

- When the bell finishes its tolling:
  - Entity: `@Greenhaven City`
  - Type: hero / status / mood
  - Scope: active hero
  - Effect: value=resonant; intensity=0.80; reason=the copper bell's vibration
    still lives in the hero's bones

## Do Not Do Here

Do not make the bell sound beautiful. It is not music. It is the sound of a
machine that was not built to be heard by human ears. It shakes, it does not
sing. Do not explain what the bell is for. The bell is for the city to know
who is standing at its tower. Nothing more. Nothing less.

## Scene Image Brief

Image target: `images/midnight-bell.png` (1:1). View from the base of a
crumbling concrete tower, looking straight up. The tower fills most of the frame
— its surface cracked, streaked with rust, a single searchlight rotating slowly
near the top. At the very peak, a massive dark copper bell — its surface wet
with rain, its iron tongue visible in the moment of striking. Rain falls toward
the camera. The sky behind the tower is absolute black except for one razor-thin
line of crimson at the horizon. Style: extreme low-angle noir, heavy
chiaroscuro, the bell as the single focal point. Square composition. No text,
no people.

## Media Script

show_media("media_midnight_bell", title="The City Speaks — Midnight Bell", caption="The copper lung booms. The midnight bell bares its iron tongue.")
switch_music("music_midnight_bell", label="Midnight Bell — The Copper Lung Speaks", loop=false, volume=0.70)
