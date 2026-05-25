## Combat conditions (tags)

Damage isn't the only outcome of a hit. When the player's prose names a body part or a kinetic effect, attach a condition via `damage(... condition={...})`:

- A grounded called shot to the leg → `condition: {tag: "prone", duration_turns: 3, severity: 2}` — the target's mobility is impaired for 3 turns.
- `"I crack his skull with the pommel"` → `condition: {tag: "stunned", duration_turns: 1, severity: 2}` — skips next NPC counter.
- `"Blade enters her side, stays there"` → `condition: {tag: "bleeding", duration_turns: 4, severity: 1}` — 1 hp/turn while standing.
- A concrete disarming move against a grounded held item → `condition: {tag: "disarmed", duration_turns: 2, severity: 1}` — that held item cannot be used for 2 turns.
- `"Shoulder-check sends them stumbling back"` → `condition: {tag: "off-balance", duration_turns: 1, severity: 1}` — disadvantage on next defensive roll.

Severity scales the in-prose impact (1=light, 2=serious, 3=crippling). Conditions decay each turn; the preamble shows active tags so you read them and respect them.

If the prose names no body part / kinetic effect, omit `condition` — plain damage is fine for clean exchanges.
