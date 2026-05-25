# @The Hobo Speaks

## Where And When

- Owner: `@The Hobo`
- Location: `@Greenhaven City`
- Visibility: triggers when the hero falls — defeated, wounded, alone — and
  chooses to get back up. Or when the bell tolls for the hero and the figure is
  waiting at the tower's base. The rare moment when the city's avatar opens its
  mouth and uses words.

## Hook

You are on the ground. The asphalt is cold and wet against your back — or your
knees — or your face. The rain hits you from above, each drop a small
accusation. The city's loop has tightened. You have fallen into it again.

And then the rain stops falling on your face. Not because the storm has passed —
but because a figure is standing over you, blocking the drops with its body. A
hooded shape. Layers of wet fabric. One grey hand extended down toward you.

A voice comes from the shadow beneath the hood — not loud, not gentle. A scrape
of metal. A hiss of steam. Words formed out of the city's quietest hour:

*"You are still here. That is enough."*

## Beat By Beat

1. The figure's hand remains extended — steady, unhurried. It will wait as long
   as the hero needs. It has time. The city has nothing but time.
2. If the hero takes the hand: the grip is cold and dry despite the rain. The
   figure pulls the hero up with surprising strength — and then releases
   immediately. No lingering touch. No claim.
3. The figure speaks one sentence — no more than two. The words are always
   specific to what the hero just survived:
   - After a defeat: *"I saw what happened. I remember."*
   - After a death in the loop: *"You are not the first. You will not be the
     last. But you are the one standing in front of me right now. That
     matters."*
   - After a betrayal: *"The city does not betray. It only continues. So can
     you."*
   - After the bell: *"The bell rang for you. I heard it. Now you know you are
     real."*
4. The figure does not offer advice. Does not explain. Speaks its sentence and
   then falls silent. The silence that follows is not awkward — it is the kind
   of silence that lets words land.
5. The figure steps back — into the rain, into the shadow — and is simply no
   longer there. Not a disappearance. More like: the hero blinks, and the space
   where the figure stood is now just rain and asphalt.

## Player Choices

- Take the offered hand. Let the figure pull you up.
- Stay on the ground. The figure will wait — but only for so long. Eventually
  the rain will resume falling on your face.
- Ask the figure who it is. It will not answer. But the hood will tilt slightly
  — acknowledgment without explanation.
- Thank the figure. It accepts this with a single nod — the smallest movement.
- Say nothing. Just get up. The figure respects this most of all.

## Scene State

- `hobo_spoke_to_hero`: increments each time this scene triggers.
- `hobo_words_spoken`: the exact sentence(s) the figure said — recorded
  permanently in the hero's memory.
- `hero_took_hand`: true if the hero accepted help.

## Success Result

The hero got up. The figure spoke. The city, through its avatar, acknowledged
the hero's suffering and survival. The figure will speak again when the moment
requires it.

## Failure Result

If the hero refuses to get up — stays on the ground, lets the rain take them —
the figure eventually withdraws its hand. Not with judgment. With patience. It
will be there the next time the hero falls. It will offer the hand again. But
the sentence it was going to speak is lost.

## Memory And String Changes

`@The Hobo` records every word it spoke to the hero — and the circumstances
that required those words. The hero's falls are numbered. The figure keeps count.

## Do Not Do Here

Do not make the figure say more than TWO sentences per appearance. The power is
in scarcity. Do not make the figure's voice warm or human. It is the city's
voice in a human throat — it scrapes, it grinds, it whispers like steam. Do not
let the hero hug the figure. The hand is the only contact permitted.

## Scene Image Brief

Image target: `images/the-hobo-speaks.png` (1:1). View from the ground — the
hero's perspective, lying on wet asphalt. Above, a hooded figure stands,
blocking the rain, one grey hand extended down toward the camera. The figure's
face is entirely lost in the shadow of the hood. Behind the figure: the city
skyline, the Crumbling Tower, rain falling in streaks. The extended hand is the
focal point — detailed, grey fingers, steady. Style: extreme low-angle noir
photography, heavy chiaroscuro, the hand catching what little light exists.
Square 1:1, 2048x2048. No text, no face visible.

## Media Script

show_media("media_the_hobo_speaks", title="The Hobo Speaks", caption="A grey hand extended. The rain blocked. Words scraped out of the city’s quietest hour.")
switch_music("music_the_hobo_speaks", label="The Hobo Speaks — The City Finds Words", loop=false, volume=0.50)
