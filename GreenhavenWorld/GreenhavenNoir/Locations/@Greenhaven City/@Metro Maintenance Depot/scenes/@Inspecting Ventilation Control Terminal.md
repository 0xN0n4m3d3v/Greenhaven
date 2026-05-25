# Inspecting Ventilation Control Terminal.md

## Where And When

- Owner: @Metro Maintenance Depot
- Location: @Metro Maintenance Depot
- Visibility: triggers when the hero approaches @Ventilation Control Terminal with the access code from @Chief Engineer Pallas.

## Hook

The terminal hums — old CRT technology, green monochrome screen, beige casing yellowed by decades of tunnel air. The login prompt glows: ENTER MAINTENANCE CODE.

@Chief Engineer Pallas gave you the code: **1189DK** — his daughter's birthday and his initials. You type it in. The screen refreshes. And you see them: six canister icons. Five green. One yellow.

Canister 3. Temperature: 26°C. Two degrees below the degradation threshold. It is REAL. The temperature path is not theoretical anymore.

## Scene State

- `has_terminal_code`: true if the hero obtained code 1189DK from @Chief Engineer Pallas.
- `terminal_accessed`: true once the hero logs in and views the canister status.
- `temperature_path_confirmed`: true — Canister 3 at 26°C confirms the Temperature ending is viable.

## Beat By Beat

1. The hero studies the screen. Six canisters. Five armed. Canister 3 near the substation: 26°C. The degradation threshold is 28°C. Two degrees. The substation control panel in the service tunnels can push it over.
2. The terminal also shows airflow data, emergency protocols, and temperature controls for the entire metro. With the access codes from Thursday's investigation, the hero can use this terminal on Sunday to raise the ambient temperature throughout the underground.
3. This is the confirmation. The Temperature ending is not a theory. It is a measurement. Two degrees. Thirty minutes. And the sarin becomes harmless.

## Player Choices

- Enter the access code: **1189DK** — available if @Chief Engineer Pallas gave the code.
- Ask @Chief Engineer Pallas for the code — explain that @Dorn's life depends on it.
- Study the terminal without logging in — the label mentions the Chief Engineer. Find him.

## Success Result

The hero accesses the terminal, confirms Canister 3 at 26°C, and validates the Temperature ending path.

## Failure Result

Without the code, the terminal remains locked. @Chief Engineer Pallas has it. Convince him.

## Materializes

When the hero accesses the terminal:
  - Entity: @Metro Temperature Data
  - Type: state / countermeasure confirmed
  - Scope: cross-hub
  - Effect: real-time temperature confirmed. Canister 3 reads 26°C — two degrees below threshold. The Temperature path is validated with hard data.

## Media Script

show_media("media_ventilation_control_terminal", title="Ventilation Control Terminal", caption="Chief Engineer's code: 1189DK. Canister 3: 26°C and rising.")
