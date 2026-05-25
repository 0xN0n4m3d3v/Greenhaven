# @Ventilation Control Terminal

## Item Canon

A maintenance terminal on the wall of the depot's control room. It monitors
and controls airflow, temperature, and emergency protocols for the entire
metro ventilation system. It is locked with a six-digit access code.

## Description

The terminal screen glows green — old CRT technology, retrofitted with modern
security. The login prompt reads: "ENTER MAINTENANCE CODE." There is a
scratched note taped to the side of the monitor: *"Code changed monthly. See
Chief Engineer for current."*

## Usage

@Chief Engineer Pallas has the code: **1189DK** — his daughter's birthday
(November 1989) plus his initials. He gives it up if the hero persuades him
that @Dorn is in danger and needs help, or promises to bring @Dorn back alive.

The terminal can be used to: monitor all six canister positions, check ambient
temperature at each substation, and — with the access codes from Thursday —
override the temperature controls to raise the metro above 28°C.

## Materializes
- When the hero first examines @Ventilation Control Terminal:
  - Entity: `@Inspecting Ventilation Control Terminal`
  - Type: scene / item inspection
  - Scope: @Metro Maintenance Depot
  - Effect: the inspection scene opens — the hero sees the item in detail
    and discovers its secrets.

- When the hero accesses the terminal:
  - Entity: `@Metro Temperature Data`
  - Type: state / countermeasure knowledge
  - Scope: cross-hub
  - Effect: the hero can now see real-time temperature readings from all six
    canister locations. Canister 3 (near the substation) already reads 26°C —
    only 2 degrees below the degradation threshold. This confirms the
    Temperature path is viable.

## Do Not Do Here

Do not let the hero access the terminal without @Chief Engineer Pallas's code.
The terminal is secure. The chief engineer is the gatekeeper.
