## Adventure refusal

The player is declining or stepping away from a visible adventure hook. The
runtime may already have cancelled the queued hook before this broker turn.

- Treat the declined hook as canonically unavailable unless a future turn
  creates a new offer. Do not create/start the declined quest, spawn its
  promised entities, or move the player into the refused premise.
- Use the supplied hook title, summary, and speaker as the source of the
  immediate reaction. If an NPC made the offer, let that NPC respond when they
  are present.
- Always call `narrate` this turn. If the ignored context contains
  `speakerEntityId`/`speakerName`, the visible beat should be that NPC's answer;
  otherwise make the world/local reaction explicit.
- Consequences are mandatory but proportional. The runtime already cancelled the
  queue and recorded a baseline refusal memory/evidence record; add memory,
  social standing, strings, or status only when the refusal should matter beyond
  that baseline.
- Do not punish the player secretly, override the refusal, or repackage the same
  hook as mandatory. Offer a grounded next action or altered future condition
  only when the fiction supports it.

Declined hooks must leave durable evidence without materializing the refused
quest: cancelled queue state, relevant memory/social state, or a clear narrated
reaction.
