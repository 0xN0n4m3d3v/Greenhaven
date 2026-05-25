# Inspecting Emergency Exit Hatch.md

## Where And When

- Owner: @Metro Central Hub
- Location: @Metro Central Hub
- Visibility: triggers when the hero approaches @Emergency Exit Hatch on the upper catwalk of @Metro Central Hub.

## Hook

The hatch is heavy — safety yellow paint peeling to rust, industrial-grade hinges, designed to survive a metro fire. An electronic keypad blinks red: LOCKED. The label reads: *Emergency override — enter employee ID.*

Voss sealed this hatch. He does not want anyone escaping the hub during the attack. But he made a mistake: the system still recognises active transit authority IDs. And @Dorn's ID — **DORN-8824** — was never revoked. @Chief Engineer Pallas told you. Or @Dorn himself, if you asked him.

This is your alternative route. Entry from above. Within jammer range. Tactical surprise.

## Scene State

- `knows_dorn_id`: true if the hero learned @Dorn's employee ID from @Chief Engineer Pallas or @Dorn himself.
- `hatch_unlocked`: true once the hero enters DORN-8824 and unlocks the hatch.

## Beat By Beat

1. The hero types: D-O-R-N-8-8-2-4. The keypad blinks green. The lock disengages with a heavy mechanical clunk that echoes through the hub. Cold air rushes in from above — the first fresh air the hero has tasted in this underground cathedral.
2. Beyond the hatch: a ladder to the surface. Street level. The rain. The city. An escape route if everything goes wrong. An entry point if everything goes right.
3. On Sunday, the hero can enter through this hatch — descending from above, within fifty metres of Voss, inside jammer range before he knows anyone is there. Or the hero can use it to evacuate civilians if the temperature/evacuation path is chosen. Two approaches. One hatch.

## Player Choices

- Enter the ID: **DORN-8824** — available if the hero obtained @Dorn's employee ID.
- Ask @Chief Engineer Pallas for @Dorn's ID — it is still active in the transit system.
- Find another way in — the service tunnel entrance, @Dorn's key. The hatch is one option, not the only one.

## Success Result

The hero unlocks the emergency hatch, securing an alternative entry/escape route for Sunday's confrontation.

## Failure Result

Without @Dorn's ID, the hatch remains sealed. Pallas has the ID. @Dorn has the ID. Someone in the depot knows it.

## Materializes

When the hero unlocks the hatch:
  - Entity: @Surface Access Route
  - Type: access / tactical route
  - Scope: @Metro Central Hub
  - Effect: the hero now has an alternative entry to the Central Hub for Sunday — descending from above, within jammer range of Voss. Tactical surprise. Also serves as an emergency evacuation route.

## Media Script

show_media("media_emergency_exit_hatch", title="Emergency Exit Hatch", caption="Red keypad: LOCKED. Dorn's employee ID: DORN-8824.")
