# Specialist prompts survey

One-paragraph digest per `*Prompt.ts` file under [packages/web-server/src/agents/](../../packages/web-server/src/agents/). Each specialist prompt is self-contained and narrow — copies whatever broker rules it needs to reason, but never replaces them in `prompts/greenhaven.md`. See [agents/00-overview.md](../agents/00-overview.md) for the design rationale.

## combatDirectorPrompt.ts

[packages/web-server/src/agents/combatDirectorPrompt.ts](../../packages/web-server/src/agents/combatDirectorPrompt.ts). Multilingual prompt that tells the model to read the player's prose + target HP/AC/conditions + recent damage and emit a `<combat_briefing>` JSON. Covers player intent detection without treating prose as confirmed impact, damage scaling table by wound severity, position/effect calibration vs target conditions, memory canon (first-person NPC voice, importance bands). Temperature 0.2 — combat math wants determinism. Output: `roll_plan`, `damage_plan`, `position`, `effect`, optional `conditions`, `memory_canon`, optional `language` tag. Used by [combat-director.md](../agents/combat-director.md).

## intimacyCoordinatorPrompt.ts

[packages/web-server/src/agents/intimacyCoordinatorPrompt.ts](../../packages/web-server/src/agents/intimacyCoordinatorPrompt.ts). Beat FSM proposal prompt — `approach → consent → foreplay → climax → aftermath` (or `skip`). Reads partner state (mood, strings, profile.sex_move, active intimacy quest), recent intimate beats, and player prose. Emits weak model output only: `phase`, optional `dynamic_quest_copy`, `resource_intents`, `memory_canon[]`, and `handoff_recommend`. It does not ask the model to output `tool_plan`; [intimacyCoordinatorPolicy.ts](../../packages/web-server/src/agents/intimacyCoordinatorPolicy.ts) compiles cartridge advance/complete, dynamic quest creation, rewards, strings, sex_move effects, and all final broker tool calls. Multilingual; output language tracks selected player language. Used by [intimacy-coordinator.md](../agents/intimacy-coordinator.md).

## questWatcherPrompt.ts

[packages/web-server/src/agents/questWatcherPrompt.ts](../../packages/web-server/src/agents/questWatcherPrompt.ts). Post-turn quest progression detector. Conservative — only "advance" or "complete" when evidence is unambiguous in tool_calls or narrative; otherwise "no_change". Skip if broker already advanced/completed THIS quest in tool_calls. Multilingual few-shot covers RU + EN. Output: `decisions[{quest_id, action, to_stage?, outcome?, reason}]`. Used by [quest-watcher.md](../agents/quest-watcher.md).

## catalogueScoutPrompt.ts

[packages/web-server/src/agents/catalogueScoutPrompt.ts](../../packages/web-server/src/agents/catalogueScoutPrompt.ts). Duplicate-by-similarity nuance check, fired only on the ambiguous band (0.7..0.92). Decides among `merge | rename | keep_both | unique`. Kind-specific guidance (locations tighter than NPCs). Temperature 0.2; `maxOutputTokens: 400`. Output: `{verdict, best_match_id, reasoning, recommended_action}`. Used by [catalogue-scout.md](../agents/catalogue-scout.md).

## npcVoicePrompt.ts

[packages/web-server/src/agents/npcVoicePrompt.ts](../../packages/web-server/src/agents/npcVoicePrompt.ts). Memory voice rewrite — reads `npc_memories.text` + the NPC's `profile.speech_style`/`profile.persona` + recent utterances + sample of past memories, emits `voiced_text` (rewritten in NPC's voice), optional `internal_reflection` (inner thought, not surfaced as memory body), and optional `links_to_memory_id` cross-reference. Multilingual via `languageHint`; preserves persona regardless of conversation language. Used by [per-npc-voice-engine.md](../agents/per-npc-voice-engine.md).

## scenePainterPrompt.ts

[packages/web-server/src/agents/scenePainterPrompt.ts](../../packages/web-server/src/agents/scenePainterPrompt.ts). Exports `SCENE_PAINTER_ADDENDUM` — a short prompt block appended to `prompts/greenhaven.md` for T2 ambient turns. Tightens emphasis: render scene texture (light, sound, smell), don't drive plot, voice = author still applies. Painter inherits the full broker prompt; the addendum just shapes ambient narration. Used by [scene-painter.md](../agents/scene-painter.md).

## dialogueAnchorPrompt.ts

[packages/web-server/src/agents/dialogueAnchorPrompt.ts](../../packages/web-server/src/agents/dialogueAnchorPrompt.ts). Reads recent exchanges with the player's `dialogue_partner_id` + speech_style + persona + previous anchor block; emits emotional beat label (`defensive`/`opening_up`/`confessional`/`cooling`/`breaking`/...), drift score 0..1 with example utterances, memory threshold reached + reason. Multilingual via `languageHint`. Used by [dialogue-anchor.md](../agents/dialogue-anchor.md).

## movementWardenPrompt.ts

[packages/web-server/src/agents/movementWardenPrompt.ts](../../packages/web-server/src/agents/movementWardenPrompt.ts). Shared by both pre-tool validator (spec 51) and post-turn observer (spec 46). Reads `@`-mentioned location names (already extracted, Unicode-aware) + the player's `current_location_id` + recent tool calls, decides which mentions are *placement* (player IS at) vs *reference* (player KNOWS about). Output: `flagged: [{location_id, reason}]`. Multilingual semantic distinction — no language word lists. Used by [movement-warden.md](../agents/movement-warden.md).

## rewardCalibratorPrompt.ts

[packages/web-server/src/agents/rewardCalibratorPrompt.ts](../../packages/web-server/src/agents/rewardCalibratorPrompt.ts). XP / strings / inspiration band assignment per scene scale × player level × recent XP history × cartridge tier. Detects inflation (recent_xp_last_10 too high) and omission (broker forgetting to award). Multilingual `notes` via `languageHint`. Output: `xp_band{trivial,scene,arc_beat,arc_end}`, `strings_max_per_beat`, `inspiration_per_scene`, warnings, `scene_scale_final`, `notes`. Used by [reward-calibrator.md](../agents/reward-calibrator.md).

## cartridgeStewardPrompt.ts

[packages/web-server/src/agents/cartridgeStewardPrompt.ts](../../packages/web-server/src/agents/cartridgeStewardPrompt.ts). Placeholder — current MVP uses no LLM (deterministic checks via `scriptUtil` + `similarityScore` shared with Catalogue Scout). File reserved for future LLM upgrade if script-mismatch detection ever needs nuance (e.g. Pinyin Latin names in a Mandarin conversation). Used by [cartridge-steward.md](../agents/cartridge-steward.md).

## questPacerPrompt.ts

[packages/web-server/src/agents/questPacerPrompt.ts](../../packages/web-server/src/agents/questPacerPrompt.ts). Placeholder — MVP uses no LLM (deterministic threshold checks: 7 active quests for overload, 24h for stale, 5d giver-NPC absence + stale for dead_npc_arc). File reserved for future LLM upgrade if signal phrasing wants more nuance ("abandoned" vs "deferred" vs "lost the thread"). Used by [quest-pacer.md](../agents/quest-pacer.md).

## voiceWardenPrompt.ts

[packages/web-server/src/agents/voiceWardenPrompt.ts](../../packages/web-server/src/agents/voiceWardenPrompt.ts). Shared by spec 54 pre-tool validator + synth-fallback voice repair in `turnRunnerV2`. Reads narrate args (`author`, `tone`, `text`) + candidate NPCs at the player's location, decides one of three verdicts: `ok`, `mismatch_dialogue_under_location` (place-author with NPC speech), `mismatch_scene_under_npc` (NPC author with scene framing). Suggests swap target name when prose contains an NPC mention. Multilingual semantic distinction; recognises dialogue markers in any script (em-dash, paired quotes `«»` `""` `„"` `「」` `『』`). Temperature 0.2. Used by [voice-warden.md](../agents/voice-warden.md).

## Sources

- [packages/web-server/src/agents/](../../packages/web-server/src/agents/) — all `*Prompt.ts` files
