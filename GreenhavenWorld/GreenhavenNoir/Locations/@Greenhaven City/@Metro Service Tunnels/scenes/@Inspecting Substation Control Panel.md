# Inspecting Substation Control Panel.md

## Where And When

- Owner: @Metro Service Tunnels
- Location: @Metro Service Tunnels
- Visibility: triggers when the hero approaches @Substation Control Panel near Canister 3.

## Hook

The control panel is ancient — bakelite dials, a trembling voltage meter, a master override switch locked with a small brass padlock. The air here is warmer than the rest of the tunnel — the substation hums behind the wall, a dormant giant.

On the concrete behind the lock, half-erased chalk marks: **7 - 19 - 3.** You have seen this date before. On a death certificate. In a storage unit. Lina Voss. Died July 19. Three years ago.

Voss set this lock. Voss left the combination. He WANTED someone to find it. The question is: why?

## Scene State

- `knows_panel_code`: true if the hero knows @Lin's death date — July 19 — and recognises 7-19-3 as the combination.
- `panel_unlocked`: true once the hero enters 7-19-3 and unlocks the master override.
- `override_activated`: true if the hero cranks the voltage to raise the temperature.

## Beat By Beat

1. The hero enters the combination: 7-19-3. The padlock opens. The master override switch is free. Beyond it: the substation's power grid. One crank of the voltage dial and the temperature in this tunnel section will begin to rise.
2. Why did Voss leave the combination? The answer settles slowly: he is not sure he wants to succeed. Part of him — the part that was a father, not a chemist — wants to be stopped. The chalk marks are a confession written in a language only someone who understood his loss could read.
3. The hero faces a choice: activate the override NOW — starting the thirty-minute countdown, alerting Voss, accelerating the confrontation — or wait until Sunday, when every second counts.

## Player Choices

- Enter the combination: **7-19-3** — available if the hero knows @Lin's death date from the death certificate.
- Activate the override NOW — raise the temperature immediately. Voss will know. The clock starts.
- Wait until Sunday — keep the combination, return before the confrontation, activate at the last moment.
- Study the chalk marks — if the hero does not yet know the date, the marks are a puzzle. July 19. Whose date is this?

## Success Result

The hero unlocks the control panel and can activate the temperature override — either now or on Sunday. The Temperature ending path is fully armed.

## Failure Result

Without knowing the significance of 7-19-3, the combination makes no sense. The hero must discover @Lin's death date — it is on the death certificate in the storage unit.

## Materializes

When the hero unlocks the panel:
  - Entity: @Metro Temperature Rising
  - Type: state / countermeasure armed
  - Scope: @Metro Service Tunnels
  - Effect: the temperature override is available. The hero can activate it now or on Sunday. If activated, the temperature rises above 28°C within thirty minutes — the sarin degrades. Voss is alerted.

## Media Script

show_media("media_substation_control_panel", title="Substation Control Panel", caption="Brass padlock. Half-erased chalk: 7 - 19 - 3. The day Lin died.")
