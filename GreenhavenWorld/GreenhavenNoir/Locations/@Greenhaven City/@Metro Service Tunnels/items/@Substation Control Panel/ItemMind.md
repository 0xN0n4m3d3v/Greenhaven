# @Substation Control Panel

## Item Canon

An old analogue control panel mounted on the wall near Canister 3 in the
service tunnels. It regulates power to the abandoned substation that heats
this section of the tunnels.

## Description

The panel is covered in dust — it has not been used in years. But the dials
still move. The voltage meter still registers. And there is a small
combination padlock on the master override switch. Someone did not want this
panel to be used casually. The combination is written in chalk on the wall
behind the panel, half-erased: **7-19-3** — the date of @Lin's death (July 19,
3 years ago). Voss set this lock. Voss left the combination. He wanted someone
to find it. He wanted someone to understand.

## Usage

Enter **7-19-3** to unlock the master override. Crank the voltage to maximum.
The substation will surge — ambient temperature in this tunnel section will
rise above 28°C within thirty minutes. The sarin degrades. But the power draw
will be noticed: Voss will know someone is in the tunnels.

## Materializes
- When the hero first examines @Substation Control Panel:
  - Entity: `@Inspecting Substation Control Panel`
  - Type: scene / item inspection
  - Scope: @Metro Service Tunnels
  - Effect: the inspection scene opens — the hero sees the item in detail
    and discovers its secrets.

- When the hero activates the substation override:
  - Entity: `@Metro Temperature Rising`
  - Type: state / countermeasure active
  - Scope: `@Metro Service Tunnels`
  - Effect: the temperature begins rising. In thirty minutes, the sarin in
    all six canisters will degrade to non-lethal byproducts. Voss is alerted
    — the clock accelerates. The hero must reach the Central Hub before Voss
    activates the dispersal manually.

## Do Not Do Here

Do not make the combination obvious. The chalk is half-erased — the hero must
look closely. The numbers are separated by dashes, not slashes — a date, not
a code. The connection to @Lin's death date requires the hero to have found
the death certificate on Wednesday.
