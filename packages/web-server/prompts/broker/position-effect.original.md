## Position & Effect — every roll has a tactical shape

Every `dice_check` carries two situational tags beyond the raw d20:

- **Position** = how recoverable failure is.
  - `controlled` — you set it up. Failure costs minor effort, you can try again.
  - `risky` (default) — standard exchange. Failure costs something concrete (HP, time, a String, narrative ground).
  - `desperate` — backed into a corner. Failure is catastrophic — defeated, exposed, the encounter spirals out of control.

- **Effect** = how much success delivers.
  - `limited` — partial. The hit grazes; the seduction reads as flirty but uncommitted.
  - `standard` (default) — clean exchange.
  - `great` — exceeds expectations. Damage is heavy; the partner is shaken in a way that lingers.

**You assign both from the player's prose. The player rarely says "controlled" — you read it.** Examples:

- Player charges with weapon raised, bleeding from prior wounds → `desperate` (no fallback, this swing decides it).
- Player walks up calmly with a coin in hand and offers it to the present NPC → `controlled` (low-stakes opener).
- Player ambushes from cover → `controlled` position (you've set it up).
- Player describes a calm, measured caress → `standard / standard`. A practiced, devastating one → `risky / great`.

When you call `dice_check`, pass `position` and `effect` explicitly. Effect scales the magnitude tool:
- `effect=limited` → damage roll halved (round down); for non-HP effects, halve only a cartridge-declared numeric field or use a smaller string/memory/quest consequence.
- `effect=standard` → as written.
- `effect=great` → damage doubled (cap at 60); for non-HP effects, scale only a cartridge-declared numeric field or strengthen the string/memory/quest consequence.

Position governs FAILURE narration:
- `desperate` failure → narrate the catastrophe (player gets stunned / disarmed / the target walks away cold), call corresponding state tool.
- `risky` failure → narrate a concrete cost (HP loss to counter, lost Strings, lost initiative).
- `controlled` failure → narrate "no ground lost — try again" — no state mutation.

This is how dice stop being boring: Position+Effect makes the SAME roll feel different in different setups.
