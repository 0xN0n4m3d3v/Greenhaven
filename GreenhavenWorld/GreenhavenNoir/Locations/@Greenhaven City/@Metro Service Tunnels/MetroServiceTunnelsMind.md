# @Metro Service Tunnels

@Metro Service Tunnels are the city's veins — a network of concrete passages,
ventilation shafts, and maintenance crawlspaces running beneath every street and
station. The air is warm from the substations. The walls sweat condensation. The
emergency lights pulse green at irregular intervals. And somewhere in the dark,
six stainless steel canisters are waiting for Sunday.

## First Entry Bubble

The service tunnel door closes behind you with a sound like a vault sealing.
The emergency lights paint everything green — the walls, the pipes, your hands.
The air is warmer than it should be. Somewhere ahead: the hum of a transformer.
And attached to a ventilation junction grille: the first canister.

It is a stainless steel cylinder, custom-machined, about the size of a fire
extinguisher. A small radio receiver is wired to a dispersal valve. A motion
sensor blinks red — active. And on the side, a label in Voss's precise
handwriting: *"GB-7. Unstable above 28°C. Degrades to non-lethal within 2
hours. Do NOT place near heat sources."*

@Dorn placed it near a heat source.

## Place Canon

@Metro Service Tunnels is the Saturday investigation site — but it is not an
investigation anymore. It is a mission. The hero enters the tunnels to do
three things: confirm the canister positions, test the jammer (if the radio
frequency was recovered Friday), and discover the chemical flaw that makes the
sarin vulnerable to temperature.

This is the last piece of preparation before Sunday. What the hero does here
determines which tools are available for the final confrontation.

## Sensory Identity

- Color: the pulsing green of emergency lights, the silver of stainless steel
  canisters, the red blink of motion sensors, the grey of concrete sweating
  condensation.
- Sound: the hum of transformers, the drip of condensation, the distant rumble
  of a metro train on another level, the red blink of the motion sensor —
  almost inaudible, a tiny click with each pulse.
- Smell: warm concrete, machine oil, a faint chemical sweetness near the
  canisters — the sarin residue.
- Texture: the warm metal of pipes near the substation, the cold steel of
  the canister casing, the rough concrete of the tunnel walls, the sweat
  on the hero's palms.
- Motion: emergency lights pulsing, condensation dripping, the motion sensor's
  red eye blinking, the hero's shadow stretching and contracting with each
  pulse of green light.

## Visible Exits

- Back to @Greenhaven City — if the hero can find the way out. Tomorrow:
  @Metro Central Hub. The final confrontation.

## Points Of Interest

- Canister 3 — near the substation. The casing is warm to the touch. The
  label confirms the temperature instability: above 28°C, the sarin degrades
  in two hours. The substation CAN be used to raise the temperature — if
  the hero has the access codes from Thursday. This is the TEMPERATURE PATH.
- Canister 1 — the first one, near the tunnel entrance. Its radio receiver is
  active. If the hero has the frequency from Friday, they can TEST THE JAMMER
  here. Point the jammer at the receiver. The red light goes dark. The valve
  stays closed. The jammer WORKS — range: fifty metres. The hero now has a
  working countermeasure for Voss's dead man's switch. This is the FORCE PATH.
- The Motion Sensor — each canister has one. They are sensitive — too much
  vibration, too close an approach, and the canister disperses early. The
  hero can attempt to disarm one or two canisters manually, but each attempt
  is a risk. Success means fewer canisters on Sunday. Failure means a small
  sarin dispersal here and now — survivable if the temperature is raised
  first, deadly if not.
- The Substation Controls — near Canister 3. Old, analogue, covered in dust.
  If the hero has the access codes, the controls can be overridden to
  increase ambient temperature throughout this section of the tunnels. But
  the override is not subtle — the power draw will be noticed. Voss will
  know someone is in the system.
- @Substation Control Panel — on the wall near Canister 3. An old
  analogue panel with a combination padlock on the master override.
  The combination is written in half-erased chalk: **7-19-3** — the
  date @Lin died. Crank the voltage to raise the temperature above
  28°C. The sarin degrades. Voss will know.

- The Central Hub Access Hatch — at the far end of the tunnels, sealed. This
  hatch leads directly to @Metro Central Hub — Voss's position on Sunday.
  It is locked. But the lock is the same model as the maintenance hatches
  @Dorn used to place the canisters. @Dorn's key — if the hero has it —
  opens this hatch. A direct route to Voss on Sunday. No detours. No delays.

## Immediate Player Actions

- Inspect Canister 3 near the substation. Read the label. Discover the
  temperature instability. This is the chemical flaw.
- Test the jammer on Canister 1's radio receiver. Confirm it works.
  Understand the range limitation (50 metres).
- Attempt to manually disarm a canister (optional, risky).
- Find the substation controls. Confirm they can be used — if the codes are
  available.
- Find the Central Hub hatch. Confirm @Dorn's key opens it. Plan the Sunday
  approach.

## Hostile And Rival Pressure

The motion sensors. The sarin residue in the air (a mask is recommended). The
heat near the substation — uncomfortable, disorienting. And the knowledge that
Voss may be in these tunnels too — somewhere ahead, positioning the final
canister, unaware that the hero is behind him. The hero MIGHT encounter Voss
here. Not a confrontation — a glimpse. A grey coat disappearing around a corner.
A sound of footsteps that stop when the hero stops. The sense of being watched
from the dark.

## Memory And Consequence Hooks

Record: whether the hero discovered the temperature instability (Temperature
ending condition), whether the hero tested the jammer (Force ending condition),
how many canisters were disarmed (fewer threats on Sunday), whether the hero
found the Central Hub hatch (navigation advantage on Sunday), and whether the
hero glimpsed Voss in the tunnels (adds tension and personal stakes).

## Materializes

- When the hero discovers the temperature instability on Canister 3:
  - Entity: `@Sarin Temperature Flaw`
  - Type: state / countermeasure confirmed
  - Scope: cross-hub
  - Effect: the Temperature ending path is fully unlocked. The hero knows:
    raise the metro above 28°C, and the sarin degrades in two hours. The
    access codes from Thursday can make this happen.

- When the hero successfully tests the jammer on Canister 1:
  - Entity: `@Tested Remote Jammer`
  - Type: item / countermeasure active
  - Scope: hero inventory
  - Effect: the jammer is confirmed functional, range 50 metres. The Force
    ending path is fully unlocked. The hero can neutralise Voss's dead man's
    switch on Sunday.

- - When the hero reads the half-erased chalk marks 7-19-3 and recognises @Lin's death date:
  - Entity: `@Substation Control Panel`
  - Type: state / password clue known
  - Scope: @Metro Service Tunnels
  - Effect: the hero knows the padlock combination: 7-19-3. The inspection scene will offer the code option.

When the hero finds the Central Hub hatch and confirms @Dorn's key works:
  - Entity: `@Metro Central Hub`
  - Type: access / direct route
  - Scope: `@Metro Service Tunnels`
  - Effect: on Sunday, the hero can take the direct route through the
    service tunnels to Voss's position — faster, quieter, and with tactical
    surprise.

## Do Not Do Here

- When the hero discovers the sarin temperature instability on Canister 3 OR successfully tests the jammer on Canister 1:
  - Entity: `@Greenhaven Police Department`
  - Type: state / saturday solved
  - Scope: @Greenhaven Police Department
  - Effect: Saturday's case is solved. The workday ends. The hero returns to @Greenhaven Police Department. The case board updates. Sunday is here. The morning brings no new district — only the final confrontation. @Metro Central Hub awaits.


Do not let the hero disarm all six canisters. One or two maximum — and even
those are risky. Sunday must still have stakes. The real rewards are the
temperature instability and the tested jammer — TOOLS for Sunday, not a
pre-solved victory. Do not let the hero confront Voss here. The glimpse is
optional — a shadow, a sound, a sense of presence. The confrontation belongs
to Sunday.
