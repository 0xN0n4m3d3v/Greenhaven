# Persona & speech_style

NPC voice is declared on the entity's `profile`: `speech_style` (short distillation) and `persona` (multi-paragraph richer description). Both are read by the **NPC Voice Engine** (spec 43) on every memory write and by the **Voice Warden** (spec 54) when validating narrate calls. See [agents/per-npc-voice-engine.md](../agents/per-npc-voice-engine.md) and [agents/voice-warden.md](../agents/voice-warden.md).

## speech_style

A one-paragraph (1-3 sentences) distillation. The NPC Voice Engine uses it as the primary signal for voice rewrite; the Voice Warden uses it to detect drift.

```json
{
  "speech_style": "Goblin street-merchant. Clipped sentences, profanity reflexive, fond of haggling lingo. Occasional crude pet names ('cherry', 'zaika') when warm. No fillers — every word is a coin she could be earning."
}
```

Conventions:

- **Lead with archetype + register.** "Tavern brawler — earthy, profane, repetitive when drunk." "Court mage — formal, indirect, never says 'no' when 'as you wish' will do."
- **Name the rhythm.** Short/clipped vs flowing/serpentine vs choppy fragments. The voice engine uses rhythm cues to repair flat broker memos.
- **List signature tics.** "Calls everyone 'sweetheart'." "Never starts a sentence with 'I'." "Drops 'g' on -ing endings."
- **Specify language register if non-default.** Modern slang, archaic, regional dialect.
- **Multilingual: don't lock to one language.** speech_style applies regardless of conversation language; the engine writes `voiced_text` in the conversation language but preserves the *persona* of the speech_style.

The speech_style is shown to the player when they open the NPC's character card (component at [packages/web-ui/src/components/npc/NpcCard.tsx](../../packages/web-ui/src/components/npc/NpcCard.tsx)).

## persona

Multi-paragraph free-form. Used by Voice Engine + Voice Warden when speech_style alone is too thin for nuanced calls.

```json
{
  "persona": "Mikka Quickgrin grew up on the edge of Quickgrin Lane, daughter of a cart-merchant who taught her to read coins by weight. She trades information now — sees more than she shows, never lets the seller leave thinking she paid too much. When warm, she lapses into childhood diminutives. When cold, she names prices without eye contact. ..."
}
```

What goes here:
- **Backstory beats** — the canon facts the model can reach for when narrating.
- **Emotional baseline** — what it takes to make her drop the mask.
- **Relationships** — known allies, rivals, fears.
- **Voice anchors that don't fit speech_style** — phrases she habitually says, gestures she makes, smells she carries.

`persona` is *additive* to `speech_style`, not a replacement. NPC Voice Engine reads both. Cartridge author can ship one, the other, or both — both is ideal for primary characters.

## How NPCs sound (worked examples)

### Mikka Quickgrin (goblin info-broker)

`speech_style`:
> Goblin street-merchant. Clipped sentences, profanity reflexive, fond of haggling lingo. Occasional crude pet names ('cherry', 'zaika') when warm. No fillers — every word is a coin she could be earning.

What the broker writes after one round of voice repair:

- *Cold:* "Five crowns. Take it or leave it." — no warmth, no padding.
- *Warm:* "Eh, zaika, lean closer. For you, three. But shut up about it."
- *Threatened:* "Touch the cart and I'll see your eyes pickled by sundown."

The Voice Warden rejects narrator prose like "Mikka regards you with careful consideration" — that's narrator-perspective scene framing, not Mikka's own voice. The split-into-two suggestion routes the framing to `author=<location>, tone='narrator'` and Mikka's actual line to `author='Mikka Quickgrin', tone='npc'`.

### Borek (innkeeper)

`speech_style`:
> Aging human innkeeper, bones tired by 40, kind by default. Speaks in long, slightly meandering sentences. Drops into a paternal tone when pouring drinks. Almost never raises voice — exhaustion does the work intimidation would.

Sample voiced output:
- *Routine:* "Same ale, friend. Coin on the bar — you know the dance by now."
- *Worried:* "You're back later than I expected. Sit. Eat. Then we talk about whatever's pressing your shoulders."

A `narrate` call attributing "Borek slams his fist on the bar" with `author='Borek'` would survive Voice Warden — the action fits the speech_style's "almost never raises voice" caveat is a gloss, not a rule. But if the prose becomes second-person scene-painting ("you watch as the lantern light glints across the bar"), the Voice Warden flags `mismatch_scene_under_npc` and suggests splitting under `author='Quiet Lantern Inn', tone='narrator'`.

### Captain Brass (boss antagonist)

`speech_style`:
> City watch captain, late 40s. Speaks in punctuated pronouncements — "I warn you once" "step back from the body" "by the city's laws". Never small-talk. When wounded, voice drops half a register but speech rate stays constant.

`persona` carries combat-relevant context:
> Twenty years on the Watch. Has seen every street-grift. Will spare a first-timer; will NOT spare a repeat offender. Combat memory canon: she names her opponent on the third exchange — "you and I, then" — that's the line that turns the duel personal.

The combat memory canon hint is what Combat Director (spec 40) reads to compose the third-exchange memory. The Voice Engine reads the speech_style + persona to write Brass's wounded-but-steady taunts when she's at half HP.

The pattern: speech_style for the *what does she sound like* signal; persona for the *what does she canonically know* signal. Both feed forward into voice rewrite, memory voicing, and pre-tool voice validation.

## Sources

- [packages/web-server/src/agents/npcVoicePrompt.ts](../../packages/web-server/src/agents/npcVoicePrompt.ts) — NPC Voice Engine prompt (consumes speech_style + persona)
- [packages/web-server/src/agents/voiceWardenPrompt.ts](../../packages/web-server/src/agents/voiceWardenPrompt.ts) — Voice Warden prompt (uses persona-aware split decisions)
- [packages/web-server/migrations/0044_persona_registry.sql](../../packages/web-server/migrations/0044_persona_registry.sql) — `persona_archetypes` lookup (UI grouping)
