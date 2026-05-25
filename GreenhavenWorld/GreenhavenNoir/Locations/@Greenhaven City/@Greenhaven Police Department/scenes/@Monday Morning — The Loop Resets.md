# @Monday Morning — The Loop Resets

## Where And When

- Owner: `@Greenhaven Police Department`
- Location: `@Greenhaven Police Department`
- Visibility: triggers every time the hero dies in @Greenhaven City. The week
  resets. Time rewinds. The hero opens their eyes in front of the locker.

## Hook

The fluorescent lights buzz twice and catch. You know that sound. You have
heard it before. Many times.

You are standing in front of your locker. Metal door. Combination lock. Your
hand is already reaching for the dial — muscle memory from a ritual you do not
remember learning. The locker room smells the same as always: stale coffee, gun
oil, wet wool. The case board through the doorway has seven empty slots.

You check yourself. No wounds. No blood. Your coat is dry — no rain, not yet.
You are whole. You are reset.

And somewhere in the back of your mind, a voice that is not quite yours
whispers: *you have done this before. You died. And now you are back.*

Monday. 6:00 AM. The week begins again.

## Beat By Beat

1. The hero stands before the locker. The fluorescent light flickers — one,
   two, three times — before holding steady. A small detail: the number of
   flickers matches the number of times the hero has died. One flicker for the
   first death. Two for the second. Three for the third. The hero may not
   notice. But @The Hobo would.
2. The hero spins the combination lock. The same numbers. The same sequence.
   The locker opens with a familiar click. Inside: the baseline inventory —
   service revolver, badge, notebook, pen, handcuffs, coins, cigarettes. The
   same objects. The same positions. The loop does not alter what belongs to
   the hero.
3. If this is NOT the first loop — if the hero has died at least once — there
   is a moment of dissonance. A flash of memory: the way they died. The case
   they were working. The face of the person they failed to save. The memory
   hits like a physical blow and then fades — still there, but bearable. The
   city does not let the hero forget. It only lets them continue.
4. The hero checks their reflection in the mirror above the sink. The face
   looking back is their own — but the eyes are fractionally older. Not
   physically. The age is in the weight behind the pupils. The mirror does not
   lie. It does not comfort. It shows exactly what the loop has done to the
   person staring into it.
5. The case board in the squad room updates. If this is a fresh loop, seven
   new cases are pinned to the board. If the hero has solved cases in previous
   loops, those slots remain marked SOLVED — but new cases fill the remaining
   days. The board is a record of progress across loops. The only one the
   department keeps.
6. The hero is ready. The locker is closed. The badge is on the belt. The
   revolver is checked. The first case of the week is waiting. And the city —
   the eternal city — is still there, beyond the department's front door, rain
   falling steadily, indifferent to the loop but aware of it.

## Player Choices

- Check the locker. Take the baseline inventory. Prepare for the week.
- Look at the case board. Study the cases. Pick the first one.
- Stare into the mirror. Count the loops in your own eyes.
- Step outside immediately — into the rain, into the city, without the ritual.
  The department will still be here when you come back.
- Find a note you left for yourself in a previous loop — if you were clever
  enough to write one and pin it inside the locker. The one thing that
  persists beyond the department's memory: the hero's own words to their
  future self.

## Scene State

- `loop_count`: increments by 1 each time this scene fires (the hero's death
  count).
- `loop_awakenings`: tracks every Monday morning the hero has experienced.
- `baseline_inventory_issued`: true — the hero's inventory has been reset.
- `previous_death_cause`: the reason the hero died in the previous loop
  (recorded for narrative use).
- `cases_solved_previous_loop`: which cases were carried over from earlier
  loops.

## Success Result

The hero has accepted the loop. The week has begun. The baseline inventory is
restored. The case board is set. The hero remembers everything — and that
memory is the only weapon the loop cannot take away.

## Failure Result

There is no failure in this scene. The hero can refuse to open the locker, can
walk out without the badge, can ignore the case board — but the loop does not
care. The loop has already reset. The week has already begun. The only failure
is to refuse to act.

## Memory And String Changes

`@Greenhaven City` records: the loop count, the cause of death, which cases
were carried over. `@The Hobo` records the same — and, when the hero next meets
the figure, may comment on the loop number.

## Materializes

- When the hero opens the locker:
  - Entity: Detective's Badge
  - Type: item / loop inventory
  - Scope: hero inventory
  - Effect: the hero pins the badge to their belt. Count=1. Only if not
    already present.

- When the hero opens the locker:
  - Entity: @Silver coin
  - Type: item / loop currency
  - Scope: hero inventory
  - Effect: the hero takes the weekly operating funds — 100 @Silver coin.
    Count=100. Only if the hero has fewer than 100.

- When the hero opens the locker:
  - Entity: Service Revolver
  - Type: item / loop weapon
  - Scope: hero inventory
  - Effect: the hero checks the cylinder and holsters the revolver. Count=1.
    Only if not already present.

- When the hero opens the locker:
  - Entity: Detective's Notebook
  - Type: item / loop tool
  - Scope: hero inventory
  - Effect: the hero pockets the notebook and pen. Count=1. Only if not
    already present.

- When the hero opens the locker:
  - Entity: persistent evidence
  - Type: item / loop persistence
  - Scope: hero inventory
  - Effect: any evidence items stored in the evidence locker from previous
    loops are returned to the hero's inventory.

- When the hero looks in the mirror:
  - Entity: `@Greenhaven Police Department`
  - Type: hero / status / mood
  - Scope: active hero
  - Effect: value=remembering; intensity=0.40 + (loop_count * 0.02);
    reason=the mirror shows the weight of every death the hero has carried into
    this new Monday

- When the hero checks the case board:
  - Entity: `@The Loop Cases`
  - Type: state / weekly cases active
  - Scope: `@Greenhaven Police Department`
  - Effect: the seven cases for the current loop are pinned to the board. Each
    unsolved case has a title, a location, and a first lead. The hero must
    solve one per day.

## Do Not Do Here

Do not make the awakening peaceful. The loop reset is not sleep — it is
reassembly. The hero feels the echo of every death. Do not let anyone else in
the department acknowledge the loop. The other cops say "morning, detective"
the same way every Monday. They do not know. Only the hero knows. Only @The
Hobo knows. Do not reveal the week's cases in this scene — only their titles on
the board. The cases themselves unfold when the hero pursues them.

## Scene Image Brief

Image target: `images/monday-morning.png` (1:1). First-person perspective,
standing before an open metal locker in a run-down police locker room. The
locker door is partially open — inside: a leather holster, a detective's badge
catching the fluorescent light, a folded notebook, a pack of cigarettes. The
hero's hand — their actual hand — rests on the locker door, about to reach
inside. A mirror on the far wall reflects a blurred, shadowed figure — the
hero, but indistinct, as if seen through rain or memory. Fluorescent lights
buzz overhead. Through the doorway: the edge of a case board with seven slots.
Style: gritty procedural noir, first-person composition, desaturated colours
with a sickly green-white cast from the lights. Square 1:1, 2048x2048. No
visible face in the mirror — only a silhouette.

## Media Script

show_media("media_monday_morning", title="Monday Morning — The Loop Resets", caption="The locker. The fluorescent light. The week begins again.")
switch_music("music_monday_morning", label="Monday Morning — The Loop Resets", loop=false, volume=0.50)
