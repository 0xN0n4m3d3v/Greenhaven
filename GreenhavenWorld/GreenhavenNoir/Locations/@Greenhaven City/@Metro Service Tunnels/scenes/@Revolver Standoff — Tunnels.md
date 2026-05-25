# @Revolver Standoff — Tunnels

## Where And When

- Owner: `@Metro Service Tunnels`
- Location: `@Metro Service Tunnels`
- Visibility: triggers on SATURDAY, loop 3+, if the hero encounters @The
  Chemist in the service tunnels. Voss is checking his canisters. The hero
  rounds a corner. Voss draws.

## Hook

The service tunnels are dark — green emergency lights pulsing, condensation
dripping, the distant hum of the substation. You are moving toward Canister 3
when you hear it: footsteps. Not yours. Not @Dorn's. Slow. Deliberate.

You round the junction corner. @Dr. Aldric Voss. Grey coat. Gaunt face.
Standing beside his canister. A clipboard in one hand. A revolver in the other.

He looks up. His thumb cocks the hammer. *"You,"* he says. *"Again. How many
times have you died, detective? I have been keeping count. And I have decided:
this time, I will not wait for Sunday."*

## Beat By Beat

1. Voss fires. The first shot goes wide — he is a chemist, not a gunslinger.
   The bullet ricochets off a pipe. The sound is deafening in the confined
   space. Emergency lights flicker. Steam hisses from a punctured vent.
2. The hero has seconds. Options: draw and fire, dive for cover behind a
   junction box, or retreat around the corner and lose him in the dark.
3. If the hero fires: a revolver duel in the tunnel. Voss is not trained but
   he is CALM. A hit on Voss wounds him — he retreats. A hit on the hero:
   wounded status, reduced mobility for Sunday.
4. If the hero takes cover: Voss advances, firing twice more. Six shots total.
   He counts them. The hero can flank through a crawlspace or wait for the
   reload. The reload takes four seconds. Four seconds is a long time.
5. If the hero retreats: Voss does not pursue. But he calls after: *"Sunday.
   8:45. Bring a better plan than last time."*
6. If the hero kills Voss: the chemist falls beside his own canister. The
   remote clatters to the floor. But the canisters are still armed. The dead
   man's switch was in his heartbeat — and his heart has stopped. The backup
   timer is running.

## Player Choices

- Draw and fire. Revolver duel. Fast, dangerous, decisive.
- Take cover. Tactical. Wait for the reload window.
- Retreat. Live to fight Sunday. Voss now knows you are coming.
- Talk. *"I know about Lin."* Voss pauses. The revolver wavers.

## Scene State

- `tunnel_standoff_occurred`: true.
- `voss_wounded`: true if the hero shot Voss.
- `hero_wounded`: true if Voss shot the hero.
- `voss_killed_in_tunnels`: true if the hero killed Voss. Sunday changes.

## Success Result

Survived. Voss wounded, killed, or driven off. Investigation continues.

## Failure Result

Death. Loop resets. Voss will be faster next time.

## Materializes

- When Voss is killed in the tunnels:
  - Entity: `@The Chemist`
  - Type: state / antagonist dead
  - Scope: cross-hub
  - Effect: Voss dead. Sunday: no confrontation, but canisters remain armed.
    Talk-down ending FORECLOSED. @Lin's story dies with him.

## Media Script

show_media("media_revolver_standoff_tunnels", title="Revolver Standoff — Tunnels", caption="A corner in the dark. A gaunt man with a revolver. The chemist is learning.")
switch_music("music_revolver_standoff", label="Revolver Standoff", loop=false, volume=0.65)
