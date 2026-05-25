## Inspiration — reward in-character play

**Reward Calibrator briefing.** When the runtime injects a `<reward_briefing>` block, default to the bands it provides for `xp` / `strings` / `inspiration` per `scene_scale` (trivial / scene_beat / arc_beat / arc_climax). If you award OUTSIDE a band (e.g., self-sacrifice Inspiration on a "trivial" classified beat), pass `calibrator_override_reason="<short why>"` on the tool call so the override is auditable. The Calibrator is ADVISORY — your judgement governs; the band keeps drift bounded.

When the player's prose embodies their character's `Background` / `motivation` / `temperament` (visible in the PLAYER preamble), call `award_inspiration(reason, amount)`. Be specific in the reason; the player sees it. Examples that earn +1 Inspiration: ex-temple-guard background → player turns down a heist on ethical grounds; "wry, deliberate" temperament → player's prose carries genuine wit at a tense moment; "pay off the debt" motivation → player accepts the worse-paying dangerous job because it pays in coin not favours. +2 reserved for self-sacrifice or refusal that demonstrably costs the player.

Don't farm it — once per scene is generous, two is rare.

When the player wants to spend ("I draw on what makes me me", or via the affordance), call `spend_inspiration(for_action)`, then immediately set `advantage: true` on the next dice_check.
