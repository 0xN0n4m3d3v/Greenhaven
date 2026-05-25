# Inspecting Security Office Safe.md

## Where And When

- Owner: @Industrial Complex
- Location: @Industrial Complex
- Visibility: triggers when the hero approaches @Security Office Safe in the security office.

## Hook

The safe is bolted to the floor — gunmetal grey, scratched, heavy. A thin film of dust on the combination dial, except for one smudge on the number 7. Someone touched it recently.

You remember the sticker. Inside @Holst's desk drawer — the bottom one, the one he tried to keep closed with his knee while you questioned him. A maintenance sticker: *Default combination — 7429. Change upon installation.* Dated three years ago. The combination was never changed.

Four digits. 7-4-2-9.

## Scene State

- `knows_safe_code`: true if the hero found the maintenance sticker in @Holst's desk drawer with the default combination 7429.
- `safe_opened`: true once the hero enters 7-4-2-9 and opens the safe.

## Beat By Beat

1. If the hero found the sticker: the combination is known. 7-4-2-9. The dial turns smoothly — it has been well-maintained, even if the combination was not. The last number clicks. The handle turns. The safe opens.
2. If the hero did NOT search @Holst's desk: the dial offers no clues. Four digits. Ten thousand combinations. The hero can search the office — the sticker is still in @Holst's bottom desk drawer, exactly where he tried to hide it.
3. Inside: the CCTV backup hard drive. Unaltered footage. Voss on camera. The precursors being loaded. @Keller at the loading dock. Everything @Holst claimed was 'looped' and overwritten. He lied. Here is the proof.

## Player Choices

- Enter the combination: **7-4-2-9** — available if the hero found the sticker in @Holst's desk.
- Search @Holst's desk for the combination — check every drawer, every sticker, every note.
- Pressure @Holst to open the safe himself. He knows the code. He is just afraid.

## Success Result

The hero enters the combination and recovers the CCTV backup hard drive — definitive proof of Voss's involvement and @Keller's role.

## Failure Result

The safe remains locked. The evidence inside is inaccessible — for now. The hero can return after searching @Holst's desk.

## Materializes

When the hero opens the safe:
  - Entity: @CCTV Backup Footage
  - Type: item / evidence
  - Scope: hero inventory
  - Effect: the hard drive contains unaltered security footage of Voss and @Keller during the theft. This can be used to pressure @Holst into a full confession.

## Media Script

show_media("media_security_office_safe", title="Security Office Safe", caption="Four digits. The sticker in Holst's desk: 7429.")
