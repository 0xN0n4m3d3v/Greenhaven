# @Sunday Night — Loop Broken

## Where And When

- Owner: `@Greenhaven Police Department`
- Location: `@Greenhaven City`
- Visibility: triggers when the hero prevents the gas attack and survives
  Sunday night — the loop is broken for the first and only time.

## Hook

Monday. 6:00 AM. The fluorescent lights buzz once and hold steady. No flicker.
No count.

You are standing in front of your locker, but something is different. Your hand
does not reach for the dial automatically. You pause. You look around. The
locker room is the same — same lockers, same bench, same mirror — but the air
feels LIGHTER. As if the city exhaled.

You open the locker. Your badge. Your revolver. Your notebook — and the pages
are full of notes from the week that finally finished. The case board through
the doorway: seven slots. All marked SOLVED. No new cases waiting.

You did it. Sunday is over. The attack is prevented. The chemist is stopped.
The loop is BROKEN. And the rain — the eternal rain — has stopped. Through the
department's small window, you see something you have never seen before: the
sky, grey but DRY. The asphalt outside is still wet, but no new drops are
falling.

The city is still there. The million windows still watch. The flickering sign
still flickers. But the loop no longer owns you. You own your Mondays now.

## Beat By Beat

1. The hero stands before the locker, noticing the absence of the flicker.
   The fluorescent light is steady. Almost peaceful. The ritual of checking
   the locker becomes, for the first time, a CHOICE rather than a looped
   action.
2. The hero checks their notebook — the accumulated notes from the successful
   loop. Every clue. Every testimony. Every connection. The notebook is a
   record of the week that STUCK. It will not be erased. It is real now.
3. The case board: seven cases. Seven SOLVED markers. The board is a
   monument — not to the hero, but to the process. The city's ledger has a
   new entry: someone broke the loop. Someone survived Sunday.
4. The hero looks in the mirror. The face looking back is the same face — but
   the eyes are different. The weight is still there (the loop leaves marks),
   but there is something else now. Something that was not there before.
   Peace? No. Not peace. Completion. The hero has done the thing they were
   trapped here to do.
5. If @The Hobo is nearby: the figure appears in the doorway to the locker
   room. It does not enter — the locker room is not its place. But it stands
   at the threshold, hood low, grey hands at its sides. And it speaks — one
   sentence, the longest sentence it has ever spoken: *"The count stops here.
   You are the first one I have ever stopped counting. The city will remember
   you. And so will the chemist. And so will @Lin. And so will I."* Then it
   turns and walks back into the rainless city, and the hero understands: the
   figure is not needed here anymore. The hero no longer needs a witness. The
   hero has become the witness.
6. The hero steps outside. The city is the same — the towers, the windows,
   the sign, the road. But the rain has stopped. For the first time since the
   hero arrived, the rain has stopped. The asphalt is drying. The gutters are
   quiet. The sky is grey but not weeping. And the hero walks — not toward a
   case, not toward a deadline, not toward a death. Just walks. Into a Monday
   that belongs to them.

## Player Choices

- Stand in the locker room for a while. Breathe. The loop is over. You have
  earned stillness.
- Check every solved case on the board. Read the names. Remember the people:
  the decoy, @Keller, @Holst, @Sera, @Dorn. They are part of the story now.
- Find @The Hobo. Thank the figure — or just sit beside it one last time.
- Walk outside. Into the city. Into the dry morning. Into whatever comes after
  the loop.

## Scene State

- `loop_broken`: true — permanent, never resets.
- `sunday_survived`: true — the gas attack was prevented.
- `monday_without_reset`: true — for the first time, Monday is just Monday.
- `rain_stopped`: true — the eternal rain pauses for the first time.
- `hobo_final_words`: *"The count stops here."* — recorded permanently.

## Success Result

The hero has broken the time loop. The cartridge's central conflict is
resolved. The hero is free — though the city remains. The city will always
remain. But it is no longer a prison. It is just a place. A cold, ancient,
watching place — but a place the hero has earned the right to call home.

## Failure Result

There is no failure in this scene. The loop is broken. This is the ending the
hero earned.

## Memory And String Changes

All permanent. The loop's end is the most significant memory the city will ever
keep. @The Hobo closes the ledger. The case board remains SOLVED. The hero's
name is written into the city's deepest mechanism — not as a gear, but as a
key.

## Materializes

- When the loop is broken and Monday arrives without a reset:
  - Entity: `@Greenhaven City`
  - Type: state / loop resolved permanently
  - Scope: `@Greenhaven City`
  - Effect: loop_count is archived. The time loop is deactivated. The city
    acknowledges the hero's achievement — the rain stops, the locker room
    lights hold steady, and the week can now proceed without reset.

## Do Not Do Here

Do not make this scene triumphant in a conventional sense. The loop is broken,
but the city is still the city. The million windows still watch. The sign still
flickers. The hero is free — but freedom in Greenhaven does not mean escape. It
means the right to continue without reset. Do not let the sun come out. Let the
sky be grey but DRY. That is enough. That is everything.

## Scene Image Brief

Image target: `images/sunday-night-loop-broken.png` (1:1). View from inside the
police department locker room, looking out through a small, grimy window. The
locker room interior is in the foreground — metal lockers, the edge of the
mirror, the corner of the case board with seven SOLVED slots visible through
the doorway. Through the window: the city skyline — crumbling towers, the
Crumbling Tower with its bell, the million windows — but the sky is a dry,
neutral grey. No rain. Damp asphalt below, but no new drops falling. The
quality of light is different — not warm, not hopeful, but STILL. The stillness
of something that has finally stopped. Style: contemplative noir, muted
palette, the window as the focal point. Square 1:1, 2048x2048. No text except
what naturally appears on the case board.

## Media Script

show_media("media_sunday_night_loop_broken", title="Sunday Night — The Loop Is Broken", caption="The locker room. The case board — all seven slots marked SOLVED. The rain has stopped.")
switch_music("music_loop_broken", label="Sunday Night — The Loop Is Broken", loop=false, volume=0.45)
