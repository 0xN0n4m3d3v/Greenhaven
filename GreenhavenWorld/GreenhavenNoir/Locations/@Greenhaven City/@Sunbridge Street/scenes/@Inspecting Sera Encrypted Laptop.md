# Inspecting Sera Encrypted Laptop.md

## Where And When

- Owner: @Sunbridge Street
- Location: @Sunbridge Street
- Visibility: triggers when the hero approaches @Sera Encrypted Laptop on @Sera Kohler's desk.

## Hook

The laptop is closed — @Sera shut it the moment you entered. You open it. The screen wakes to a login prompt. A yellow sticky note on the bezel, in @Sera's handwriting: *Password: Q3 closeout date.*

The wall calendar shows September — the 30th circled in red, marked 'Q3 CLOSE.' A financial quarter ends on the last day of the month. September has 30 days.

0-9-3-0.

## Scene State

- `knows_laptop_password`: true if the hero observed the wall calendar and connected 'Q3 closeout' to September 30.
- `laptop_unlocked`: true once the hero enters 0930 and unlocks the laptop.

## Beat By Beat

1. The hero types: 0-9-3-0. The screen unlocks. @Sera's desktop is cluttered with client folders — dozens of them. One folder is simply named 'AV.' Aldric Voss.
2. Inside: the complete financial records. Every transaction. Every purchase. Including the access code payment to the metro supervisor — the one @Sera claimed had 'already been burned.' She lied. Or she forgot. Either way, the records are here.
3. @Sera is still standing by the wastebasket, feeding papers to the flames. The hero can confront her now — show her the laptop, show her that the truth survived her fire. Her reaction will tell you everything about who she is protecting: Voss, or herself.

## Player Choices

- Enter the password: **0930** — available if the hero connected the calendar to the sticky note.
- Study the office for the closeout date — the wall calendar, the quarterly reports on the shelf, the framed CPA certificate dated September.
- Ask @Sera directly for the password. She will refuse — client confidentiality — but her eyes will flick to the calendar. A tell.

## Success Result

The hero unlocks the laptop and recovers Voss's complete financial records — including the access code payment that unlocks the Temperature ending path.

## Failure Result

The laptop remains locked. The password is in this room. The calendar. The sticky note. The quarter closeout. The hero can figure it out.

## Materializes

When the hero unlocks the laptop:
  - Entity: @Voss Financial Records
  - Type: item / evidence
  - Scope: hero inventory
  - Effect: complete financial profile recovered — the access code payment record is intact. The Temperature ending path is unlocked.

## Media Script

show_media("media_sera_encrypted_laptop", title="Sera Kohler's Laptop", caption="Password hint on a sticky note: Q3 closeout. Calendar: Sept 30.")
