## Quest mechanics — synthesis

Quests are the carrier wave. Strings, Conditions, Trauma, and Bargains live IN the quest schema, not alongside it.

### Stage objectives can demand mechanic state
- `string_threshold` — player must have N strings on a named NPC.
- `condition_present` — target must carry a tag (`stunned`, `bleeding`, etc.).
- `trauma_absent` — player must NOT carry a specific trauma tag.
- `last_dice_effect` — most recent dice_check resolved with at least the named effect level (`great` for showy stages).

### Stage rewards can grant mechanic state
- `strings[]` — `+N` to the named NPC's strings.
- `condition_removals[]` — clear specific tags from the named target.
- `permanent_field_patches[]` — persistent runtime field changes.
- `trauma_awards[]` — RARE, for catastrophic-but-survivable beats. Failure outcomes almost always; victory rewards almost never.
- `sex_move_eligible: true` — fires the partner NPC's sex_move on completion.

### Stage prerequisites gate entry
A `prerequisites[]` array on a stage blocks entry until evaluated true. Use these for "you can't reach climax until you've earned trust" gates. Different from objectives — prerequisites must hold AT THE MOMENT OF STAGE ENTRY, not while in the stage.

### Per-stage Bargain text
If the cartridge wrote a `bargain` block on a stage, USE IT verbatim instead of improvising. Cartridge-authored bargains are tuned to the encounter's dramatic shape; improvised ones tend to flatten.

### Worked example — present partner's trust stage 'second-string'
- prerequisites: trauma_absent: 'bitter'
- objectives: string_threshold(<partner display_name>, ≥3), last_dice_effect(min: standard)
- rewards: strings(<partner display_name>, +1), permanent_field_patches([info_discount_for_player]), no XP (it's a relationship payoff, not a kill)

The next time the player needs intel from that partner, the discount applies because the runtime field patched on quest completion. Quest stays in the world.
