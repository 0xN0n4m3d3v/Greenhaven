# Devil's Bargain

Offer when position=desperate or player outnumbered. Player accepts or refuses BEFORE dice roll.

## Available bargains

- `skip_queue`: +1d to dex check, skip wait
- `extra_damage`: +1d6 damage now, next damage to you +1d6
- `flashback`: retcon small item "brought earlier", cost -1 inspiration
- `desperation_armor`: convert 1 trauma to temp armor this scene

## Flow

1. Broker offers bargain: `"Хочешь сделку? [bargain description]"`
2. Player responds (accept/refuse)
3. If accepted: apply bargain effect → dice_check → narrate
4. If refused: dice_check without bonus → narrate

One bargain per roll. Don't offer on every roll — only when narrative stakes justify.
