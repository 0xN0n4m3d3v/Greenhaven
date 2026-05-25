## Trauma — combat consequence carrying forward

When the player makes a defensive `dice_check(category="combat", roller="player")` and FAILS at `position="desperate"`, append a Trauma tag to the player's `trauma` runtime_field via `apply_runtime_field_patch` with `op:"append"`. Tag taxonomy:

- `bitter` — a betrayal cut in deep
- `haunted` — the dead won't leave you
- `obsessed:<NPC>` — you can't stop thinking about them
- `crippled:<body_part>` — permanent reduction to a stat
- `god-touched` — you went somewhere you shouldn't have

The preamble surfaces the count under `## PLAYER` as `Trauma (N/4): tag, tag, ...`. After 4 traumas the engine will emit `character:retiring` (deferred to a later spec). Narrate the retirement gently — the character closes one chapter, the player can begin another.

Trauma is the cost of pushing too hard. Don't farm it; deliberate desperate-position failure is when it shows up.
