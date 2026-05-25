# Inspecting Voss Lab Computer.md

## Where And When

- Owner: @Iron Row District
- Location: @Iron Row District
- Visibility: triggers when the hero approaches @Voss Lab Computer and attempts to log in.

## Hook

The old computer hums — a tired sound. The screen saver fades to a login prompt. Behind it, dimly visible: a photograph of a laughing girl on a swing. The password field blinks. The hint reads: *Her name.*

You have seen this girl before. Her photograph is in your evidence file — found behind the cabinet in this very laboratory. And on the back of that photograph, in Voss's handwriting: *Lin, age 7. Last day.*

Her name is Lin.

## Scene State

- `knows_lin_name`: true if the hero found the photograph behind the cabinet in this laboratory. The name 'Lin' is known.
- `password_entered`: true once the hero types 'Lin' and presses Enter.
- `computer_unlocked`: true after successful login.

## Beat By Beat

1. The hero stares at the password hint: *Her name.* If the hero found the photograph, the answer is immediate. The fingers type: L-I-N. Enter. The screen flickers. The desktop opens.
2. If the hero does NOT yet know the name: the cursor blinks. The hint offers nothing else. The hero can search the laboratory for the photograph — it is still behind the cabinet where it fell. The computer will wait.
3. The desktop reveals: research files, sarin synthesis notes, stability data, and security footage from the night before the decoy died. Everything Voss researched. Everything he planned. It is all here.

## Player Choices

- Enter the password: **Lin** — available if the hero knows @Lin's name.
- Search the laboratory for clues about the password — the photograph behind the cabinet holds the answer.
- Force quit. The computer is not going anywhere. Return when you know the name.

## Success Result

The hero enters 'Lin' and unlocks the computer. Voss's research files, sarin stability data, and the lab security footage are downloaded.

## Failure Result

The hero cannot log in without the password. The hint 'Her name' is meaningless without the photograph. The computer waits.

## Materializes

When the hero successfully logs in:
  - Entity: @Voss Research Files
  - Type: item / evidence
  - Scope: hero inventory
  - Effect: the hero downloads Voss's complete research — synthesis notes, sarin stability data, the lab security footage. This evidence strengthens every future case.

## Media Script

show_media("media_voss_lab_computer", title="Voss Laboratory Computer", caption="A dated machine. The screen asks: Her name.")
