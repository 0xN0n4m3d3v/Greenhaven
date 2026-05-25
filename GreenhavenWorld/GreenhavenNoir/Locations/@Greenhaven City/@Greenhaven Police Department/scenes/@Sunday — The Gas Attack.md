# @Sunday — The Gas Attack

## Where And When

- Owner: `@Greenhaven Police Department`
- Location: `@Greenhaven City` — the metro, deep underground
- Visibility: triggers on the VERY FIRST playthrough, when the hero enters
  @Greenhaven City. This is the inciting event — the death that starts the
  loop. After the first death, this scene fires again on Sunday of every loop,
  but the hero now arrives armed with everything learned Monday through
  Saturday.

## Hook

Sunday evening. The squad room is quiet — empty desks, stale coffee, the rain
ticking against the window. You are finishing a report that no one will read
when the call comes in.

"Metro control, Greenhaven Central. We have a situation. Passenger on the
southbound train, car four. White male, grey hair, long coat. Refusing to
leave. Says he is waiting for something. Train is stopped at the Lexington
platform. Can you check it out? It is probably nothing."

It is not nothing.

You grab your coat. You check your revolver — the same ritual, slide, cylinder,
safety, three times. You do not know yet that you will perform this ritual a
hundred more times. You do not know that the fluorescent lights flickering
overhead will become the first thing you see every Monday morning until you
solve the unsolvable.

You drive to the station. The rain on the windshield. The neon signs reflecting
in puddles. The city watching through a million windows. You descend the stairs
to the platform. The air is warm and smells of electricity.

And then you step into car four.

## Beat By Beat

1. The metro car is half-full — Sunday evening commuters, tired, heading home.
   A woman adjusts her scarf. A teenager pulls out earbuds. An old man checks
   his watch. And in the connector window between car four and car five: a
   figure. Grey hair. Long dark coat. Standing perfectly still while everyone
   around him shifts and fidgets.
2. You approach. Badge out. "Sir, I need you to step off the train." The man
   turns his head — slowly, like the movement costs something. His eyes are
   pale grey. Empty. Not angry. Not insane. Just... finished. He looks at you
   as if he has already seen this moment and has already decided how it ends.
3. He speaks — quietly, the voice of someone who stopped caring whether anyone
   was listening: *"You should not be here, detective. This is not for you.
   This is for the city. The city killed my daughter. The city will feel what
   I felt. Leave. Or do not. It does not change the outcome."*
4. Then the smell. Faint at first — something sweet. Bitter apples. Your
   training screams SARIN before your conscious mind catches up. The
   ventilation grate above you is hissing. The man is holding a small device in
   his right hand — a remote trigger. His thumb rests on the button. A dead
   man's switch.
5. The first passenger collapses — the teenager, clutching her throat, foam
   at the corner of her mouth. The woman with the scarf tries to stand and her
   legs fold. The old man's watch continues ticking. You draw your revolver —
   training overrides panic — but your hand is already trembling. Sarin
   absorbs through skin. There is no target here you can shoot. The man in the
   coat is behind glass. The gas is already in your lungs.
6. Your vision narrows. The lights flicker — once, twice. You do not know
   what the flickering means. You will learn. The man's lips move one last
   time. The shape of the words: *"Now the city feels it."*
7. Darkness. The smell of bitter apples. And then — nothing. And then —
   fluorescent light. Buzzing. Flickering. A locker door in front of you. The
   smell of stale coffee and gun oil. Your hand is already reaching for the
   combination dial, from a ritual you do not remember learning. Monday. 6:00
   AM. The week has begun. Again.

## Player Choices

- Speak to the man. Ask him who he is. He tells you about his daughter before
  the gas takes you. You will carry her name into the loop: @Lin.
- Draw your weapon. It will not help. But the instinct matters. You are a cop.
  You face the threat even when there is nothing to shoot.
- Try to evacuate the passengers. You cannot save them — the sarin works too
  fast. But you die trying, and that matters.
- Memorise his face. Burn it into your memory. You will hunt this face through
  seven days and seven deaths. And on the seventh Sunday, you will find it
  again.

## Scene State

- `first_playthrough`: true — the initial timeline, the first death.
- `sunday_attack_witnessed`: true — the hero has seen the gas attack firsthand.
- `chemist_face_remembered`: true — @The Chemist's face is burned into memory.
- `lin_name_heard`: true if the hero spoke to Voss — @Lin's name is known from
  the very beginning.
- `first_death_cause`: sarin gas, metro, Sunday — recorded permanently.
- `chemist_last_words`: *"Now the city feels it."* — recorded.

## Success Result

The hero dies. This is not failure — it is the beginning. The hero takes into
the loop: @The Chemist's face, the smell of bitter apples, and — if they
listened — the name @Lin. On the other side of death: Monday, 6:00 AM, the
locker room, and the first real chance to prevent what just happened.

## Failure Result

There is no failure. The hero dies. The loop activates. The game begins.

## Memory And String Changes

This scene is the ROOT MEMORY for the entire cartridge. Every Monday morning is
shaped by this death. The face of @The Chemist. The smell of sarin — bitter
apples, geraniums. The flickering lights that will become a countdown and a
greeting. And, if the hero spoke to him, the name of a seven-year-old girl who
died in a subsidence the city forgot to prevent.

## Materializes

- When the hero dies of sarin gas in the metro:
  - Entity: `@Monday Morning — The Loop Resets`
  - Type: scene / loop anchor
  - Scope: `@Greenhaven Police Department`
  - Effect: the hero awakens in the locker room. Monday, 6:00 AM. The first
    loop begins. Baseline inventory issued. The case board has seven empty
    slots. The hero remembers everything.

- When the hero dies of sarin gas in the metro:
  - Entity: `@Greenhaven City`
  - Type: state / loop counter
  - Scope: `@Greenhaven City`
  - Effect: loop_count is set to 1. The city's ledger of the hero's deaths
    begins. The ancient loop now has the hero's name in it.

- When the hero dies of sarin gas in the metro:
  - Entity: `@The Chemist`
  - Type: state / antagonist active
  - Scope: `@Greenhaven City`
  - Effect: @The Chemist is now an active antagonist. His face and his last
    words are part of the hero's permanent memory. The investigation has a
    target.

## Do Not Do Here

Do not let the hero survive this scene on the first playthrough. Death is the
door to the loop. Do not reveal the full motive here — only the mention of a
daughter. The name @Lin comes if the hero asks. The full story of her death
comes on Wednesday. Do not let the hero draw a weapon and shoot Voss through
the glass — the connector door is locked, the glass is reinforced. The hero is
not here to win. The hero is here to die, and to remember.

## Media Script

show_media("media_sunday_gas_attack", title="Sunday — The Gas Attack", caption="A metro car. A hissing vent. A grey-haired man. The smell of bitter apples. The first death.")
switch_music("music_sunday_gas_attack", label="Sunday — The Gas Attack", loop=false, volume=0.60)
