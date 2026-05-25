# @Next Morning

## Where And When

- Owner: `@Greenhaven Police Department`
- Location: `@Greenhaven Police Department`
- Visibility: triggers when the hero solves a day's case — the critical evidence
  is found, the district gives up its secret, and the workday ends. The hero
  returns to the department. The next morning begins.

## Hook

You push through the precinct door. The fluorescent lights buzz their familiar
buzz. The coffee is three hours old — a fresh pot, which means it was made at
5 AM and you are the first to drink it. The rain ticks against the window.

The case board has changed. One more slot shows SOLVED. One fewer case remains.
@Detective Vex is at their desk, already writing. They look up as you enter.
"Morning, detective. The board updated. Whatever you found yesterday — it
worked. What is next?"

You pour a coffee. You check your revolver — three times. The ritual. The same
ritual. And then you look at the board. The next district is highlighted. The
next day is waiting.

## Beat By Beat

1. The hero enters the squad room. The case board reflects the previous day's
   work — the solved slot glows with a green marker. The next slot blinks,
   awaiting attention. Tuesday. Or Wednesday. Or whichever day comes next.
2. @Detective Vex is already at their desk. They have been tracking the
   hero's progress. "I updated the file. And I ran those names you asked
   about. The ones from @Iron Row? @Holst's brother-in-law? @Keller works at
   a shipping depot near the port. Just like you thought." Vex is useful.
   Vex is learning. Vex does not know about the loop — but they are starting
   to trust the hero's instincts.
3. @Captain Harrow may or may not appear — depending on how many loops the
   hero has survived and whether the hero has been cooperative. If relations
   are good: a nod from the office doorway. Grudging respect. If relations
   are bad: a memo on the desk. "See me. — H."
4. The hero checks the locker — the baseline inventory from Monday is still
   there. No reset this morning. Just a continuation. The notebook has notes
   from yesterday. The evidence locker has the previous day's findings.
5. The hero is ready. The next district awaits. The case board blinks. The
   rain continues outside. Another day. Another piece of the puzzle. Sunday
   is coming.

## Player Choices

- Check the case board. Review what is solved. Plan the day.
- Brief @Detective Vex. Share information — or keep it close.
- Visit the evidence locker. Retrieve stored evidence from previous days and
  previous loops.
- Talk to @Captain Harrow — if he wants to talk. Or avoid him.
- Step outside. The next district is waiting. The rain has not stopped.

## Scene State

- `morning_routine_complete`: true — the hero is ready for the new day.
- `yesterday_solved`: which district was just completed.
- `today_target`: which district is next.

## Success Result

The hero has returned to the department, reviewed the case board, and prepared
for the next day's investigation. The next district is accessible. The loop has
not reset — this is CONTINUATION, not repetition.

## Failure Result

There is no failure in this scene. The hero can skip the coffee, skip Vex, skip
Harrow. But the next district still awaits.

## Materializes

- When the hero prepares for the new day:
  - Entity: `@Greenhaven Police Department`
  - Type: hero / status / mood
  - Scope: active hero
  - Effect: value=ready; intensity=0.50; reason=the investigation continues —
    another day, another district, another piece of the puzzle

## Do Not Do Here

Do not make this scene feel like the Monday loop reset. This is NOT a death.
This is progress. The fluorescent lights do not flicker. The locker combination
is not forgotten. The hero is not reassembling — the hero is CONTINUING.

## Media Script

switch_music("music_police_department", label="Greenhaven Police Department — Next Morning", loop=true, volume=0.40)
