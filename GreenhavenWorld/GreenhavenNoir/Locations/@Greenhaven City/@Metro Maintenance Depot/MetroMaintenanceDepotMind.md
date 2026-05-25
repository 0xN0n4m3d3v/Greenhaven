# @Metro Maintenance Depot

@Metro Maintenance Depot is a cavern of concrete and iron beneath the streets —
where the city's underground transit system is maintained, repaired, and
forgotten between emergencies. The air smells of grease and ozone. The walls
sweat. And somewhere in the maze of tunnels beyond the locker room, a man named
@Dorn is running from what he helped build.

## First Entry Bubble

The depot is quiet — quieter than it should be for a weekday. The maintenance
crews are on the surface, dealing with a water main break that may or may not
be a coincidence. The locker room is empty except for one open locker. Inside:
a printed metro schematic with six points circled. A half-empty coffee cup, still
warm. And a note, handwritten, the ink smeared with something that might be
tears:

*"I didn't know about the gas. I swear I didn't know. He said it was a
ventilation test. He said it was for safety. Oh God. The canisters are already
in place. I put them there. I put them there."*

At the bottom, a name: @Dorn. And an arrow pointing toward the service tunnel
entrance. He went deeper. He is still down there.

## Place Canon

@Metro Maintenance Depot is the Friday investigation site. @Dorn is a
twenty-two-year veteran of the transit authority. Voss fed him a cover story —
a ventilation safety test, city-approved, off the books for bureaucratic
reasons. @Dorn believed it. He placed six canisters in six ventilation
junctions. He gave Voss a radio frequency for remote activation. And two days
ago, he realised what he had actually built.

Now he is running — through the service tunnels, toward the central hub, trying
to remove the canisters before Sunday. He knows the positions. He knows the
radio frequency. He knows the EXACT time Voss plans to trigger the dispersal:
Sunday, 8:45 PM. And he is the only person who can give the hero all of this
before it is too late.

## Sensory Identity

- Color: the sickly green of service tunnel emergency lights, the grey of
  concrete walls, the orange of a dropped wrench, the blue of a worker's
  overalls.
- Sound: the distant rumble of a metro train passing on another level, the
  drip of water through concrete, the echo of footsteps in tunnels, the
  hum of transformers.
- Smell: grease, ozone, wet concrete, stale coffee from the open locker,
  sweat and fear.
- Texture: the rough concrete of tunnel walls, the cold metal of locker
  doors, the vibration of trains felt through the floor.
- Motion: emergency lights pulsing, water dripping, a dropped wrench still
  rocking slightly where @Dorn dropped it.

## Visible Exits

- Back to @Greenhaven City. Tomorrow: @Metro Service Tunnels — the canisters
  themselves.

## Points Of Interest

- @Dorn's Locker — open, abandoned in haste. The schematic, the note, the
  coffee. Also: a family photo tucked into the door — @Dorn, a woman, two
  teenagers. He has a family. He is not running to save himself. He is
  running because he cannot face them.
- The Service Tunnel Entrance — a heavy door marked AUTHORISED PERSONNEL
  ONLY. It has been propped open with a wrench — @Dorn's wrench. Beyond
  it: darkness, emergency lights, the sound of running footsteps fading.
  The chase begins.
- The Radio Log — on a desk in the maintenance office: a log of recent
  radio frequency tests. One entry stands out. A frequency test on a
  restricted band — the same band used for emergency remote triggers.
  @Dorn logged it as "equipment calibration." He was calibrating Voss's
  dead man's switch.
- The Canister Blueprint — not Voss's — @Dorn's. He drew his own diagram of
  the six deployment points, with notes: "Canister 3 — near substation, temp
  runs hot. Canister 5 — junction box, corroded, handle with care." @Dorn
  knows these tunnels better than Voss ever could. His notes contain
  information Voss does not have: the temperature anomaly near the
  substations.
- @Chief Engineer Pallas — runs the depot. Protective of @Dorn.
  Has the code to the ventilation control terminal. Will give it
  up if the hero promises to bring @Dorn back alive.
- @Ventilation Control Terminal — in the control room. Locked with
  a six-digit code. Pallas has it: **1189DK**. Monitors all six
  canister positions and ambient temperature.

- @Dorn's Trail — a dropped wrench at the tunnel entrance, a boot print in
  the dust further in, a half-eaten sandwich on a maintenance ledge deeper
  still. @Dorn is heading for the central hub. He is going to try to disarm
  the canisters himself. If the hero does not reach him first, he will die
  trying.

## Immediate Player Actions

- Read @Dorn's note. Understand that Voss used him. @Dorn is not a
  conspirator — he is a victim.
- Follow @Dorn's trail into the service tunnels. The chase is on.
- Check the radio log. Find the restricted frequency test. This is the
  frequency for Voss's remote trigger — the key to the jammer.
- Study @Dorn's canister blueprint. Note the temperature anomaly at
  Canister 3 — this connects to Thursday's access codes and Saturday's
  investigation.
- Chase @Dorn. Catch him before he reaches the canisters. He is scared,
  guilty, and armed with a wrench — not a threat, but a danger to himself.

## Hostile And Rival Pressure

@Dorn is running. If the hero does not catch him, he reaches the central hub
and tries to disarm a canister himself. The canisters are booby-trapped —
motion sensors. @Dorn dies. The hero loses the radio frequency, the confirmed
positions, the exact attack time, and a witness who can testify against Voss.
Also: the service tunnels are a maze. It is easy to get lost. The emergency
lights are the only guide.

## Memory And Consequence Hooks

Record: whether the hero caught @Dorn alive, whether the hero recovered the
radio frequency, whether @Dorn's canister notes were recovered, whether @Dorn
survived to testify.

## Materializes

- When the hero catches @Dorn and calms him down:
  - Entity: `@Dorn`
  - Type: state / witness secured
  - Scope: cross-hub
  - Effect: @Dorn gives the hero: confirmed canister positions, the radio
    frequency for Voss's remote trigger (jammer path), the exact attack time
    (Sunday 8:45 PM), and the temperature anomaly at Canister 3 (temperature
    path). This unlocks BOTH the Force and Temperature endings.

- When the hero recovers the radio frequency from the log:
  - Entity: `@Remote Trigger Frequency`
  - Type: state / countermeasure knowledge
  - Scope: cross-hub
  - Effect: the hero knows the frequency. A jammer can be built or acquired.
    The Force ending path is unlocked.

- - When @Chief Engineer Pallas gives the hero the ventilation terminal code:
  - Entity: `@Ventilation Control Terminal`
  - Type: state / password clue known
  - Scope: @Metro Maintenance Depot
  - Effect: the hero knows the terminal code: 1189DK. The inspection scene will offer the code option.

When @Dorn survives and agrees to testify:
  - Entity: `@Dorn`
  - Type: state / witness for Sunday
  - Scope: cross-hub
  - Effect: @Dorn can be called as a witness during the Sunday confrontation —
    another voice to reach Voss, another proof that the city is made of people,
    not machinery.

## Do Not Do Here

- When the hero catches @Dorn and recovers the radio frequency and confirmed canister positions:
  - Entity: `@Greenhaven Police Department`
  - Type: state / friday solved
  - Scope: @Greenhaven Police Department
  - Effect: Friday's case is solved. The workday ends. The hero returns to @Greenhaven Police Department. The case board updates. @Metro Service Tunnels — the canisters themselves — will be the next lead in the morning.


Do not let @Dorn die easily. The hero should have a real chance to save him —
but also a real chance to fail. Do not make the chase trivial. The tunnels are
dark, disorienting, and @Dorn knows them better than the hero. Catching him
requires attention and persistence. Do not let @Dorn reveal Voss's current
location — he does not know where Voss is now. He only knows where Voss will
be on Sunday.
