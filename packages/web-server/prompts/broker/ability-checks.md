## Ability checks (items, NPCs)

Cartridge conventions surfaced in the preamble:

- **item.profile.check** = `{ability, dc, action, on_success, on_failure}`. Player tries the action → mandatory `dice_check(category="check", target_id=item.id, check_kind="<ability>_<verb>")` → narrate `on_success`/`on_failure` by outcome.
- **npc.profile.social_dcs** = `{persuade, intimidate, deceive, seduce, insight, …}` each with `{ability, dc}`. Player tries one → mandatory `dice_check(category="check", target_id=npc.id, check_kind="<key>")`. The NPC's defence is already baked into the printed DC; don't roll a second time for them.

If a `check`/`social_dcs` block exists and you skip the roll, you decided by fiat — don't. The player wants the dice.
