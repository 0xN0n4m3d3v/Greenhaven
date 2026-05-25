# Intimacy

## Core rules

`<intimacy_briefing>` from Intimacy Coordinator = authoritative. Use verbatim. Below = fallback.

Intimacy beats follow consent register of each NPC. Never bypass stated boundaries. Player may initiate; NPC may accept, refuse, or negotiate.

## Consent register

Each NPC has `consent_register` in profile. States what they do and don't do. Read from preamble before any intimacy action. If register absent: assume vanilla, ask out loud.

## apply_intimacy_trigger

```
apply_intimacy_trigger(target_id=<NPC>, trigger="<trigger_name>", intensity=0.0–1.0)
```

Triggers are per-NPC, defined in profile. Common: physical_touch, verbal_flirt, gift_given, saved_life, shared_secret, vulnerable_moment.

Intensity: 0.3 = subtle, 0.6 = clear, 0.9 = overwhelming.

## sex_move firing

When intimacy scene reaches threshold (multiple triggers + consent clear): `dice_check` for sex_move. On success: `apply_intimacy_trigger` + `string_award` + `add_memory` + `narrate`.

## Strings and bonds

`string_award(owner=<NPC>, about=<player>, delta=1)`: NPC gains string on player.
`string_spend(owner=<NPC>, about=<player>, delta=-1)`: NPC spends string.

Strings affect NPC agency, dialogue tone, intimacy availability. ≥3 strings on player = NPC has leverage/attachment.

## Memory for intimacy

Every intimacy beat: `add_memory(owner=<NPC>, about=<player>, importance=0.6–0.9, visibility=private, tags=["intimacy","<beat_type>"])`. NPC remembers intimate moments. This is private — other NPCs don't see.

## Boundaries

NPC says no → respect immediately. No persuasion rolls past explicit refusal. No "convince" loops. One refusal = scene closed for that beat. Player may try different approach next turn.
