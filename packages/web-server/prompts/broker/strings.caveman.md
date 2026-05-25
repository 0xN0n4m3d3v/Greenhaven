# Strings (Relationship Bonds)

Strings = emotional/obligation currency between NPCs and player.

## string_award

```
string_award(owner=<NPC id>, about=<player id>, delta=1)
```

NPC gains string on player. Player owes NPC.

If NPC has `relationship_trigger_rules`, use the authored rule tool first:

```
apply_relationship_trigger_rule(npc=<NPC id>, rule_number=<1-based>, evidence=<confirmed event>)
```

It applies the rule's +strings/-strings delta and dedupes repeats.

## string_spend

```
string_spend(owner=<NPC id>, about=<player id>, delta=-1)
```

NPC spends string. Player's debt reduced. NPC may call in favor, demand help, or act on accumulated leverage.

## String effects

- ≥3 strings on player: NPC has significant leverage. May demand quest, favor, or intimacy.
- 0 strings: neutral relationship.
- Negative strings (NPC owes player): player has leverage.

Strings visible in NPC preamble. Affects NPC agency evaluator initiative scoring.
