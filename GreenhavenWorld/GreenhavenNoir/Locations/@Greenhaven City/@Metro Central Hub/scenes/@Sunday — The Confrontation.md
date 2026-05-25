# @Sunday — The Confrontation

## Where And When

- Owner: `@Metro Central Hub`
- Location: `@Metro Central Hub`
- Visibility: triggers on SUNDAY, loops 1-2, when the hero enters the central
  hub with all six prior cases solved. Voss does not yet know about the loop.
  He is unarmed. He is waiting to explain.

## Hook

The central hub opens around you — six levels of catwalks, green emergency
lights, the hum of the city's ventilation system. And at the centre, on the
lowest catwalk beside the master control panel: @Dr. Aldric Voss. Grey coat.
Gaunt face. The remote trigger in his right coat pocket. The dead man's switch.

He looks up as you enter. His expression is not surprise. It is the peace of a
man who has already said goodbye.

*"Detective,"* he says. *"I wondered if you would find me. You have been
following my trail all week. The laboratory. The warehouse. The storage unit.
@Sera's office. @Dorn's tunnels. You are thorough. I respect thoroughness."*

He gestures at the control panel. Six canister indicators — all armed. *"You
have fifteen minutes. I suggest you use them to say what you came to say."*

## Beat By Beat

1. Voss stands beside the control panel. He does not draw a weapon — he has
   none. His weapon is the remote trigger, the dead man's switch, the six
   canisters throughout the metro. He wants to talk. He has been alone with
   this plan for six months. Someone is finally here to listen.
2. *"You found the photograph,"* he says. *"The one behind the cabinet. @Lin,
   age seven. Last day. I left it there on purpose. I wanted someone to know
   her name before the end."*
3. The hero can talk, move toward the temperature controls, or approach Voss
   directly. Voss watches calmly. He is not afraid of the hero. What does a
   man with a dead man's switch have to fear from a detective with a revolver?
4. If the hero talks about @Lin — shows understanding, not just knowledge —
   Voss listens. *"You went to the subsidence site. You stood where I stood.
   You looked at the city through my eyes. No one has ever done that."* The
   Talk-down path opens.
5. If the hero moves toward the temperature controls: Voss notices. *"The
   access codes. You found them. @Sera."* He does not stop the hero. He
   watches. He is curious. What will the detective choose?
6. If the hero approaches Voss directly: *"You could shoot me. The remote is
   a dead man's switch. My heart stops, every canister opens at once. You
   need me alive, detective. You need me to disarm it. And I will not."* A
   pause. *"Unless you can give me a reason."*
7. The resolution — several possible outcomes depending on what the hero
   found and what they choose. All three endings (Talk-down, Temperature,
   Force) are available if the hero has the right evidence. The difference
   from loop 3+ is that Voss is not fighting back — he is waiting to be
   understood.

## Player Choices

- Talk about @Lin. Show Voss the photograph, the drawing, the letter from
  the strongbox. Prove that someone understands. The Talk-down path.
- Move to the temperature controls. Use the access codes. Raise the ambient
  temperature above 28°C. Evacuate the metro. The Temperature path.
- Jam the remote and advance on Voss. Neutralise the dead man's switch.
  Detain him. The Force path.
- Ask Voss to explain. Let him tell his story. Every word he speaks is a
  word that is not a gunshot or a gas dispersal. Time is running. But
  listening matters.

## Scene State

- `confrontation_began`: true — the final scene is underway.
- `voss_listening`: true if the hero chose to talk. Talk-down path active.
- `temperature_override_active`: true if the hero is raising the temperature.
- `jammer_active`: true if the hero used the jammer.
- `voss_talked_down`: true if the hero persuaded Voss. Best ending.
- `voss_detained`: true if the hero used force. Neutral ending.
- `voss_dead`: true if the hero shot Voss. Hollow victory.

## Success Result

Voss is stopped — by understanding, by temperature, or by force. The gas
attack is prevented. The loop is broken. @Sunday Night — Loop Broken triggers.

## Failure Result

The hero fails to stop Voss. The gas disperses at 8:45 PM. The hero dies.
The loop resets. Monday, 6:00 AM. Voss will not remember this conversation —
but the hero will. And next time, Voss WILL remember (loop 3+).

## Materializes

- When Voss surrenders (talked down):
  - Entity: `@Sunday Night — Loop Broken`
  - Type: scene / loop resolution — best ending
  - Scope: `@Greenhaven City`
  - Effect: Voss disarms the canisters himself. The loop is broken. @Lin is
    remembered.

- When Voss is detained (force):
  - Entity: `@Sunday Night — Loop Broken`
  - Type: scene / loop resolution — neutral ending
  - Scope: `@Greenhaven City`
  - Effect: Voss is arrested. The canisters are disarmed. The loop is broken.

- When Voss dies (hollow victory):
  - Entity: `@Sunday Night — Loop Broken`
  - Type: scene / loop resolution — hollow ending
  - Scope: `@Greenhaven City`
  - Effect: the loop breaks, but Voss is dead. The hero must disarm the
    canisters before 8:45 PM. @Lin's story dies with her father.

## Do Not Do Here

Do not make Voss aggressive in this scene. Loops 1-2 are the TALKING loops.
He wants to be understood. The revolver comes in loop 3. Let the first two
confrontations feel like a conversation — tense, sad, but a conversation.

## Media Script

show_media("media_sunday_confrontation", title="Sunday — The Confrontation", caption="The central hub. A gaunt man with a dead man's switch. Fifteen minutes.")
switch_music("music_sunday_confrontation", label="Sunday — The Confrontation", loop=false, volume=0.55)
