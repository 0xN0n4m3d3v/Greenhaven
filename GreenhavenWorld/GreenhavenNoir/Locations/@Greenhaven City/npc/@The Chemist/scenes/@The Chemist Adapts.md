# @The Chemist Adapts

## Where And When

- Owner: `@The Chemist`
- Location: `@Greenhaven City`
- Visibility: triggers at the start of the THIRD loop (loop_count >= 3) when
  the hero exits @Greenhaven Police Department on Monday morning. Voss is
  waiting across the street. He has begun to remember.

## Hook

Monday morning. The locker room. The fluorescent lights. You check your
revolver — three times, same as always. But this time, when you step out into
the rain, the city feels different.

Across the street, in the shadow of a boarded-up shopfront: a figure in a long
dark coat. Grey hair. Gaunt face. He is looking at YOU. Not at the police
department. Not at the street. At you.

@Dr. Aldric Voss. Outside the metro. On a MONDAY.

He does not approach. He does not speak. One hand is inside his coat pocket —
not the remote trigger. Something heavier. The shape of a revolver.

Then he turns and walks into the rain toward @Iron Row. And you understand,
with a coldness that has nothing to do with the weather: he is starting to
remember. Not everything. Not clearly. But enough. Enough to know your face.
Enough to know something is wrong with time.

The game has changed. The chemist is learning.

## Beat By Beat

1. Voss stands in the shadow across the street. His expression: not the
   peace of a man who has accepted his fate. Puzzlement. The look of a
   scientist whose data does not fit the hypothesis. He is sure he has seen
   this detective die. Several times. And yet — Monday morning. Alive.
2. Voss raises one hand. A gesture: STOP. Stay back. The other hand remains
   in his coat pocket. The revolver is there. You can tell by the weight of
   the fabric. He bought it. He is ready to use it.
3. He walks away — toward @Iron Row, toward the district where his daughter
   died. The hero can follow but Voss disappears into the industrial maze.
   He knows these streets better than anyone. He planned here for six months.
   He is already gone.
4. The rain continues. The sign flickers. The city has witnessed this. A new
   entry in the ledger: the chemist is adapting. The loop is no longer a
   weapon that only the hero wields.

## Scene State

- `chemist_adapting`: true — Voss has noticed the loop. From loop 3 onward:
  carries a revolver on Saturday and Sunday.
- `chemist_has_revolver`: true — revolver encounters active.
- `chemist_seen_on_monday`: true — hero confirms the adaptation.

## Player Choices

- Follow Voss toward @Iron Row. He is gone before you reach the corner —
   but the direction tells you something. He was heading toward the subsidence
   site. Where @Lin died.
- Report to @Captain Harrow. He will dismiss it: "The suspect is underground,
   detective. Not strolling past the precinct." File it anyway.
- Tell @Detective Vex. They write it down. They ask: "How did he know you
   would walk out that door at exactly that moment?" You cannot answer.
- Say nothing. Process it. Adapt. The chemist is learning. So must you.

## Success Result

The hero has confirmed: Voss is adapting. From loop 3 onward: revolver
encounters in @Metro Service Tunnels and @Metro Central Hub. Loop 5:
canisters repositioned. Loop 7: hub approaches trapped.

## Materializes

- When Voss is seen on Monday (loop 3+):
  - Entity: `@The Chemist`
  - Type: state / antagonist armed
  - Scope: cross-hub
  - Effect: Voss now carries a revolver during Saturday/Sunday encounters.

- When Voss is seen on Monday (loop 5+):
  - Entity: `@Metro Service Tunnels`
  - Type: state / canisters repositioned
  - Scope: `@Metro Service Tunnels`
  - Effect: two canisters moved. @Dorn's map partially outdated.

- When Voss is seen on Monday (loop 7+):
  - Entity: `@Metro Central Hub`
  - Type: state / hub trapped
  - Scope: `@Metro Central Hub`
  - Effect: hub approaches trapped — tripwires, chemical alarms.

## Do Not Do Here

Do not let the hero catch Voss here. This is a sighting. The fight comes
Saturday and Sunday. Do not let Voss speak yet. He is collecting data — a
scientist does not engage until the hypothesis is ready.
