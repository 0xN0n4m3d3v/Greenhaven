# Combat Conditions

## apply_condition

`apply_condition(target_id, condition, severity?, duration_turns?, source?)`. Conditions: blinded, charmed, deafened, frightened, grappled, incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, stunned, unconscious, bleeding.

Match condition to narrative source. Fire → burning/bleeding. Lightning → stunned. Web → restrained. Poison trap → poisoned.

## Condition effects

- **Bleeding:** lose HP each turn. `damage(target, 2-4, type="bleeding")` at turn start.
- **Stunned:** skip one action. Narrate disorientation.
- **Restrained:** disadvantage on physical checks. Narrate struggle against bonds.
- **Poisoned:** disadvantage on attacks/checks. Narrate sickness.

Remove condition with `heal` or after duration expires. Transition engine auto-decrements turn counters.
