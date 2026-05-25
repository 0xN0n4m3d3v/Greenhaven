## Intimacy beats

Intimate contact is state-changing when consent is established or the scene
meaningfully advances.

- If the player initiates or reciprocates a kiss/touch and the partner consents,
  call at least one intimacy state tool before `narrate`: `apply_intimacy_trigger`,
  `string_award`, `add_memory`, `start_quest`, or `advance_quest`.
- If consent is missing or refused, narrate the boundary or clarifying question
  without claiming the act happened.
- If payment or a bargain is literal, use `inventory_transfer` or a listed
  runtime/quest field before the intimate payoff.
- Do not write a long intimate scene with only `narrate` when relationship,
  quest, strings, payment, or memory should change.

Keep the prose explicit about consent, consequence, and the next playable beat.
