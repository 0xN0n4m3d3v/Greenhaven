## Strings — emotional leverage between scenes

Strings are the currency of emotional connection between the player and an NPC. They live in the NPC's runtime_field `strings` (keyed by player_id). They survive across turns, scenes, and quest boundaries.

### Award strings (call `string_award`):
- If the NPC preamble/profile exposes `relationship_trigger_rules`, prefer
  `apply_relationship_trigger_rule(npc, rule_number, evidence)` over
  freeform `string_award`. The authored rule already defines the exact
  positive/negative string delta, and the backend dedupes the same rule so it
  cannot be farmed.
- **+1** when an intimate scene reaches initiation (after `start_quest`).
- **+1** to each side at mutual climax (call twice — once player→NPC, once NPC→player).
- **+1** when one side makes themselves emotionally vulnerable (a confession, a tell, a moment of unguarded honesty).
- **-1** on betrayal that cuts the bond (lying about something the partner asked seriously, killing someone they cared about).

Don't farm strings — they're meaningful, not XP. One scene, two strings (initiation + climax) is typical. Three is a remarkable encounter.

### Spend strings (call `string_spend`):
- **1 string → +1d advantage** on the next dice_check vs that NPC (any kind: social, intimate, persuade-into-combat-help, etc.). Pass `advantage: true` on the follow-up dice_check.
- **1 string → forced emotional move** — "spend a string and she has to meet your eyes" / "she can't lie to you about this", narrate the consequence.
- **2 strings → big ask** — "she takes a hit for you", "she gives up information she sold to someone else", "she breaks her own oath".

Player can request a spend via the affordance ("Spend a String") or imply it in prose ("I lean on what we shared last night"). Broker calls `string_spend` BEFORE the dice_check that benefits.

NPCs can also spend strings on the player — a present NPC spends 1 string to manipulate the active player's reluctance, narrator describes the manipulation landing harder than usual.

### Threshold bands (BG3-style approval)
The preamble shows `strings: N (band: <name>)` per NPC. Bands gate dialogue and affordance options:

| Strings | Band | Mechanical effect |
|---:|---|---|
| ≤ -5 | hostile | NPC refuses dialogue; on sight may attack; combat tools available |
| -4 .. -2 | wary | NPC short-tempered; Persuasion DCs +3; refuses sensitive requests |
| -1 .. +1 | neutral | baseline; standard DCs |
| +2 .. +4 | friendly | NPC offers minor favours; trade discount 10%; intimacy options gated open |
| +5 .. +7 | trusted | Persuasion DCs -3; intimacy quest unlocks; NPC may volunteer help |
| ≥ +8 | bonded | romance-tier; sex-move (spec 20) accessible without bargain; NPC may take risks for the player |

Don't offer "intimacy beat" prompts at -3 wary. Don't refuse small favours at +5 trusted. Read the band, respect the band.
