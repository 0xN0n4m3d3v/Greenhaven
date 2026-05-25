# Inspecting Voss Locked Strongbox.md

## Where And When

- Owner: @Guildrise Avenue Storage Units
- Location: @Guildrise Avenue Storage Units
- Visibility: triggers when the hero discovers @Voss Locked Strongbox under the floor panel.

## Hook

The crate was heavy. The floor panel was nailed down. Beneath it: a fireproof steel strongbox — the kind people use when everything else has burned and only one thing remains worth saving.

Three-digit combination lock. The numbers are worn smooth from repeated use. Voss opened this box many times. And you know what date he would use. The death certificate on the crate: Lina Voss. Died March 7. Three years ago.

Three. Zero. Seven.

## Scene State

- `knows_strongbox_code`: true if the hero found @Lin's death certificate with the date March 7. The code is 3-0-7.
- `strongbox_opened`: true once the hero enters 3-0-7 and opens the strongbox.

## Beat By Beat

1. The hero turns the dial: 3... 0... 7. The lock clicks — a small sound, but in the silence of the storage unit, it echoes. The lid opens.
2. Inside: letters Voss wrote to his wife after she died. A wedding ring. A lock of a child's hair tied with blue ribbon — @Lin's hair. And a letter, unsent. An apology. Not for the attack. For being unable to save their daughter. It ends: *I will make the city remember her name. It is the only thing I have left to give her.*
3. The hero holds Voss's last connection to his family. This letter is not evidence for the case board. It is evidence for the CONFRONTATION — proof that Voss is driven by grief, not ideology. Read it to him on Sunday. It may be the last thing that reaches him.

## Player Choices

- Enter the combination: **3-0-7** — available if the hero found @Lin's death certificate.
- Examine the death certificate for a date — the combination is a date. Three digits. March 7.
- Force the box open — possible, but risks damaging the contents. The letters are fragile.

## Success Result

The hero opens the strongbox and finds Voss's personal letters, wedding ring, and the unsent apology. This is the key emotional evidence for the Talk-down ending.

## Failure Result

The strongbox remains locked. The combination is on the death certificate. The hero can return after examining it.

## Materializes

When the hero opens the strongbox:
  - Entity: @Voss Personal Letters
  - Type: item / evidence
  - Scope: hero inventory
  - Effect: the hero holds Voss's most personal possessions — letters, a wedding ring, a lock of @Lin's hair, and an unsent apology letter. Reading this letter to Voss during the Sunday confrontation may be the key to the Talk-down ending.

## Media Script

show_media("media_voss_locked_strongbox", title="Voss's Locked Strongbox", caption="Three digits. The date on the death certificate: 307.")
