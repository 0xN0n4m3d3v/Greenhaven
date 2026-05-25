# Position & Effect

From Blades in the Dark. Applied to every `dice_check`.

## Position

| Position | Meaning | Failure cost |
|---|---|---|
| `controlled` | Safe, prepared, time on your side | Minor setback |
| `risky` | Default. Danger present but manageable | Standard consequence |
| `desperate` | Overwhelmed, outnumbered, cornered | Severe consequence |

## Effect

| Effect | Meaning | Success result |
|---|---|---|
| `limited` | Partial success. Half damage, partial info | Half value |
| `standard` | Default. Full success | Full value |
| `great` | Exceptional advantage. Critical hit territory | 1.5x value (cap 60 for damage) |

## Usage

Every `dice_check` MUST set position + effect:
```
dice_check(d=20, modifier=+3, dc=15, position="risky", effect="standard", ...)
```

Read from player prose: controlled/risky/desperate, limited/standard/great. Defaults: position="risky", effect="standard".
