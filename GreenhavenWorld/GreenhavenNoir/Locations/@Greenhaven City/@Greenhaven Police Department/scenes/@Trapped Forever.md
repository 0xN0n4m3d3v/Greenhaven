# @Trapped Forever

## Where And When

- Owner: `@Greenhaven Police Department`
- Location: `@Greenhaven City`
- Visibility: triggers when the hero reaches loop_count >= 10 without breaking
  the loop. OR when the hero chooses to collapse during @The Cop Breaks. OR
  when the hero has loop_count >= 7 and chooses to give up entirely — stops
  investigating, stops trying, simply exists.

## Hook

You stop opening the locker. You stop looking at the case board. You stop
leaving the precinct. What is the point? You have died ten times. You have
solved every case. You have confronted Voss with every tool, every piece of
knowledge, every ending. And every time — every single time — something goes
wrong. A bullet. A timer. A word you did not say fast enough.

The loop does not care. The city does not care. Monday comes. Monday always
comes. And you have stopped caring too.

You sit on the bench in the locker room. The fluorescent lights flicker —
TEN times. You do not count them anymore. @Detective Vex brings you coffee.
You do not drink it. @Captain Harrow stops asking questions. The case board
gathers dust.

The rain outside the window is the only thing that still moves. You are not
moving. You are not dead. You are not alive. You are a gear in the machine.
And the machine has finally worn you smooth.

## Beat By Beat

1. The hero stops. Just... stops. Does not open the locker. Does not check
   the case board. Does not go to @Iron Row. The investigation is over. The
   investigation has BEEN over for loops. The hero knows every piece of
   evidence. Every code. Every password. Every conversation. It does not
   matter. Nothing changes. Nothing will ever change.
2. Days pass without the hero leaving the precinct. @Detective Vex tries to
   help — brings food, brings coffee, brings case files the hero does not
   read. Eventually Vex stops coming too.
3. @The Hobo appears in the locker room doorway. The figure should not be
   here — this is not its place. But it stands at the threshold, hood low,
   grey hands at its sides. It speaks — quietly, the scrape of a manhole
   cover: *"You have stopped counting. So have I. The count only matters if
   you are still trying. Are you still trying, detective?"*
4. If the hero answers: the figure waits. The silence stretches. And then the
   figure turns and walks back into the rain. It will not return. The witness
   has left. The ledger is closed. The hero is no longer a story the city is
   interested in telling.
5. Sunday comes. The gas disperses. The metro fills with the smell of bitter
   apples. Passengers die. The city feels it — briefly, faintly, the way a
   machine feels a gear slip. And then: Monday. 6:00 AM. The locker room. The
   fluorescent lights flicker — ELEVEN times. The hero is still on the bench.
   Still not moving.
6. This is the Trapped Forever ending. The loop continues — without the hero.
   The hero becomes like the other detectives in the precinct: hazy, repeating,
   not quite real. A ghost in a locker room. A gear that no longer turns but
   cannot be removed. The city digests another soul. And the rain keeps
   falling.

## Player Choices

- Answer @The Hobo. "No. I am not trying anymore." The figure leaves. The
  ending is sealed.
- Stand up. Defy the ending. Walk out of the locker room and back into the
  investigation. This is the ONLY way out. But it requires the hero to
  choose — actively, deliberately — to keep fighting after ten deaths.
- Do nothing. Sit on the bench. Let the scene play out. The ending arrives
  whether you choose it or not.

## Scene State

- `trapped_forever`: true — the worst ending. Permanent.
- `hero_gave_up`: true — the hero stopped trying.
- `hobo_abandoned`: true — @The Hobo has closed the ledger.

## Success Result

There is no success in this ending. The only way to "succeed" is to REJECT
the ending — to stand up, walk out, and continue the investigation. This
requires the hero to choose defiance at the darkest moment.

## Failure Result

The Trapped Forever ending is the failure. The hero is lost. The loop
continues without them. The city wins — not by killing the hero, but by
digesting them slowly, the way it digests everything.

## Materializes

- When the hero accepts the Trapped Forever ending:
  - Entity: `@Greenhaven City`
  - Type: state / hero consumed
  - Scope: `@Greenhaven City`
  - Effect: the hero is no longer an active participant in the loop. The
    hero becomes a permanent fixture of @Greenhaven Police Department — a
    ghost in the locker room, a detective who is always there and never
    leaves. The case board stays empty. The city has a new resident.

## Do Not Do Here

Do not make this ending feel like a game over screen. It is a CHOICE. The hero
can always stand up and walk out. The bench is comfortable. The rain is
hypnotic. The loop is easy to surrender to. But the door is right there. The
hero can leave at any moment. The tragedy is that after ten deaths, leaving
feels harder than staying.

## Media Script

switch_music("music_loop_broken", label="Trapped Forever", loop=true, volume=0.25)
