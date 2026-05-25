# @Revolver Standoff — Hub

## Where And When

- Owner: `@Metro Central Hub`
- Location: `@Metro Central Hub`
- Visibility: triggers on SUNDAY, loop 3+, when the hero enters the central
  hub. Voss is on the upper catwalk. Armed. Waiting.

## Hook

The central hub opens around you — six levels of catwalks, green emergency
lights, the hum of the city's breath. And from the fourth-level catwalk, a
voice: *"Detective. I wondered which approach you would take this time."*

The sound of a revolver cylinder rotating. Hammer cocking.

@Dr. Aldric Voss. High ground. Armed. He has been expecting you.

## Beat By Beat

1. Voss speaks from the shadows above. *"At first I thought it was deja vu.
   Then madness. But the data is consistent. You have died. Multiple times.
   And yet — Sunday. 8:30 PM. The same Sunday. The same detective. A temporal
   loop. And I am the experiment you are trying to disrupt."*
2. A shot — aimed at the catwalk near the hero's feet. Warning. *"I am not
   violent, detective. I am a scientist. But you are the variable. And in
   any experiment, the variable must be controlled."*
3. The hero acts: return fire (difficult — high ground), jam the remote
   (neutralise dead man's switch), advance up the catwalks (close distance),
   or talk (the hardest path — Voss is listening but armed).
4. If the hero jams the remote: Voss's pocket goes dead. The remote is
   neutralised. For the first time, fear crosses his face. His plan has a
   flaw. Now it is just two people. Revolvers. A concrete cathedral.
5. If the hero talks about @Lin, about @The Hobo, about the photograph and the
   drawing and the lock of hair in the strongbox: Voss listens. The revolver
   wavers. Lowers. Not safely. But lower. This is the Talk-down path.
6. If the hero kills Voss: he falls from the catwalk. The remote clatters.
   Canisters still armed. Clock still ticking. Last words: *"Tell the city...
   I only wanted it to remember her name."*

## Player Choices

- Return fire. Long-range duel.
- Jam the remote. Neutralise the dead man's switch.
- Advance. Close the distance.
- Talk. Tell him about @Lin. The hardest path. The best path.

## Scene State

- `hub_standoff_occurred`: true.
- `voss_killed_in_hub`: true if shot. Hollow victory.
- `voss_talked_down`: true if persuaded. Best ending.
- `hero_wounded`: true if Voss shot the hero.

## Success Result

Voss stopped. By bullet or by words. Loop broken.

## Failure Result

Death. Loop resets. Voss remembers. Voss adapts.

## Materializes

- When Voss surrenders:
  - Entity: `@Sunday Night — Loop Broken`
  - Type: scene / loop resolution — best ending
  - Scope: `@Greenhaven City`
  - Effect: Voss disarms the canisters. Loop broken. @Lin remembered.

- When Voss is killed:
  - Entity: `@Sunday Night — Loop Broken`
  - Type: scene / loop resolution — hollow victory
  - Scope: `@Greenhaven City`
  - Effect: loop broken but Voss dead. @Lin's story ends.

## Media Script

show_media("media_revolver_standoff_hub", title="Revolver Standoff — Hub", caption="The chemist on the high catwalk. A revolver. A dead man's switch. The end of the loop.")
switch_music("music_revolver_standoff", label="Revolver Standoff", loop=false, volume=0.65)
