# @The City Speaks — Hollow Windows

## Where And When

- Owner: `@Greenhaven City`
- Location: `@Greenhaven City`
- Visibility: triggers when the hero is alone — no companions, no crowd, deep
  in the empty hours. The city speaks most intimately to those who have no
  one else to listen.

## Hook

You are alone. The street is empty. The rain is the only sound — and even that
has softened, as if the city has turned down its own volume to make space for
something private.

Above you, the million windows of the skyline stare down. Each one a dead eye.
Each one a camera that has been recording for longer than you have been alive.
The city's voice comes not as a grinding or a toll — but as a whisper, carried
on the steam rising from a street grate. Close. Almost gentle. Almost.

## Beat By Beat

1. The city names the windows: *"I watch you through a million empty, shattered
   windows. Each one has seen a different story. Each one has seen the same
   story, told with different faces. You scurry below, thinking your lives
   matter — thinking your suffering is unique."*
2. The city recites a few of the stories the windows have seen — brief flashes:
   *"That window — third floor, fifth from the left — watched a man count his
   money for forty-seven years and die with his hand still cupped around coins
   that bought nothing. That one — the one with the bent frame — saw a woman
   write the same letter every night for a decade. It was never sent. It was
   never different. She wrote it anyway."*
3. The city turns to the hero: *"And you. I have watched you since the moment
   you arrived. Your story is already written — not by me, but by the shape of
   the street you walk, the weight of the rain on your shoulders, the way you
   look up at my windows when you think no one is watching. I am always
   watching. And I am telling you: you are not the first to walk this street.
   You will not be the last. But right now — in this moment — you are the one
   I am speaking to."*
4. The whisper fades. The steam dissipates. The rain returns to its normal
   volume. The million windows remain — silent again, but no longer anonymous.
   Each one now has a story. And one of them has the hero's.

## Player Choices

- Look up at the windows. Pick one. Wonder what it has seen.
- Ask the city: *what does my window see?* The city will not answer directly —
  but the rain changes rhythm, and a single window on a middle floor flickers
  with a light that has not worked in years.
- Sit down on the wet curb. Let the city watch. Sometimes being seen is enough.
- Walk away. The city will still be watching. But it will not whisper again
  tonight.

## Scene State

- `city_whispered_to_hero`: true after this scene finishes.
- `hero_chose_window`: the floor and position of the window the hero looked at,
  if any.
- `hero_accepted_witness`: true if the hero stayed and let the city watch.

## Success Result

The hero has heard the city's most intimate confession. The million windows are
no longer anonymous architecture — they are archives. The city has acknowledged
the hero as an individual story among millions, and the hero has acknowledged
the city as a witness.

## Failure Result

If the hero walks away before the city names the windows, the whisper does not
return. The city still watches — but it no longer speaks softly. The next
monologue will be colder.

## Memory And String Changes

`@Greenhaven City` records the moment of intimacy — or the moment of refusal.
The hero's window is assigned: a specific frame in the skyline that now belongs
to this playthrough's hero. On subsequent visits, that window may flicker when
the hero passes beneath it.

## Materializes

- When the city finishes whispering:
  - Entity: `@Greenhaven City`
  - Type: state / city intimacy reached
  - Scope: `@Greenhaven City`
  - Effect: the city has spoken privately to the hero. The relationship between
    city and hero has moved from witness to confidant. The hero's window is
    assigned and will be referenced in future scenes.

- When the city finishes whispering:
  - Entity: `@Greenhaven City`
  - Type: hero / status / mood
  - Scope: active hero
  - Effect: value=seen-alone; intensity=0.70; reason=the city has seen the hero
    without company, without pretense, and has whispered its oldest truth

## Do Not Do Here

Do not let anyone else be present during this scene. The monologue is for the
hero alone. Do not make the city sentimental. It is not lonely. It is ancient.
It speaks to the hero not because it needs company, but because the silence of
the empty hours demands acknowledgment. Do not reveal what the hero's window
shows — only that it exists, and that it is watching.

## Scene Image Brief

Image target: `images/hollow-windows.png` (1:1). A view looking up at a
skyline of abandoned high-rises at night. Hundreds of dark windows arranged in
a grid — most of them black, a few shattered, one single window in the middle
distance glowing with a faint, impossible light. Rain streaks down the frame.
Steam rises from a street grate in the lower third of the image, catching the
glow of a sodium lamp from off-frame. The perspective is from street level
looking up — the hero's point of view. Style: atmospheric noir photography,
deep shadows, a single point of warmth in a sea of cold. Square composition.
No text, no people visible.

## Media Script

show_media("media_hollow_windows", title="The City Speaks — Hollow Windows", caption="A million dark windows. One of them flickers. The city whispers.")
switch_music("music_hollow_windows", label="Hollow Windows — The City Whispers", loop=true, volume=0.38)
