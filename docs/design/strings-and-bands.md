# Strings & bands

Strings are the currency of emotional connection between the player and an NPC. They live in the NPC's runtime field `strings` (keyed by player_id, per-player overlay). They survive across turns, scenes, quest boundaries.

The full ruleset is in [packages/web-server/prompts/greenhaven.md:420-454](../../packages/web-server/prompts/greenhaven.md#L420-L454). Schema migration: [packages/web-server/migrations/0027_strings_field.sql](../../packages/web-server/migrations/0027_strings_field.sql).

## Award rules

Call `string_award(npc, delta, reason)` ([packages/web-server/src/tools/strings.ts](../../packages/web-server/src/tools/strings.ts)).

- **+1** when an intimate scene reaches initiation (after `start_quest`).
- **+1** to each side at mutual climax (call twice — once player→NPC, once NPC→player).
- **+1** when one side makes themselves emotionally vulnerable (a confession, a tell, a moment of unguarded honesty).
- **-1** on betrayal that cuts the bond (lying about something the partner asked seriously, killing someone they cared about).

Don't farm strings — they're meaningful, not XP. One scene, two strings (initiation + climax) is typical. Three is a remarkable encounter.

The Reward Calibrator (spec 47) caps `strings_max_per_beat` at 1-2. Broker can override with `calibrator_override_reason` for genuine multi-string moments.

## Spend rules

Call `string_spend(npc, amount, reason)`.

- **1 string → +1d advantage** on the next dice_check vs that NPC (any kind: social, intimate, persuade-into-combat-help). Pass `advantage: true` on the follow-up dice_check.
- **1 string → forced emotional move** — "spend a string and she has to meet your eyes" / "she can't lie to you about this". Narrate the consequence.
- **2 strings → big ask** — "she takes a hit for you", "she gives up information she sold to someone else", "she breaks her own oath". The cost mirrors the favour size.

Player can request a spend via the affordance ("Spend a String") or imply it in prose ("I lean on what we shared last night"). Broker calls `string_spend` BEFORE the dice_check that benefits.

NPCs can also spend strings on the player — Mikka spends 1 string to manipulate the active character's reluctance, narrator describes the manipulation landing harder than usual.

`string:changed` SSE fires on every award/spend with `{npcId, npcName, prev, next, delta, threshold_band}`. Frontend pulses the NPC's avatar via `useMoodPulse`.

## Threshold bands

BG3-style approval. The preamble shows `strings: N (band: <name>)` per NPC. Bands gate dialogue, affordance options, and combat behaviour.

| Strings | Band | Mechanical effect |
|---:|---|---|
| ≤ -5 | hostile | NPC refuses dialogue; on sight may attack; combat tools available |
| -4 .. -2 | wary | NPC short-tempered; Persuasion DCs +3; refuses sensitive requests |
| -1 .. +1 | neutral | baseline; standard DCs |
| +2 .. +4 | friendly | NPC offers minor favours; trade discount 10%; intimacy options gated open |
| +5 .. +7 | trusted | Persuasion DCs -3; intimacy quest unlocks; NPC may volunteer help |
| ≥ +8 | bonded | romance-tier; sex-move (spec 20) accessible without bargain; NPC may take risks for the player |

Don't offer "intimacy beat" prompts at -3 wary. Don't refuse small favours at +5 trusted. Read the band, respect the band.

The threshold band is computed at write-time and surfaced on the SSE event payload + the next preamble. UI uses it for:
- Per-NPC bubble theming (colder for hostile, warmer for bonded).
- Affordance gating (intimacy CTA hidden below `friendly`).
- Mood pulse intensity on `useMoodPulse`.

The companion auto-depart engine (spec 53) can use a `string_threshold` predicate to fire — common: `{op: '<', value: -1}` for fragile mercenary alliances, `{op: '<', value: -3}` for steadier companions. See [cartridge/depart-conditions.md](../cartridge/depart-conditions.md).

## Sources

- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md) — Strings ruleset (lines 420-454)
- [packages/web-server/src/tools/strings.ts](../../packages/web-server/src/tools/strings.ts) — `string_award`, `string_spend`, `readStrings`
- [packages/web-server/migrations/0027_strings_field.sql](../../packages/web-server/migrations/0027_strings_field.sql) — schema
