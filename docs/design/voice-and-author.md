# Voice = author rule

The contract from [packages/web-server/prompts/greenhaven.md:18](../../packages/web-server/prompts/greenhaven.md#L18): NPC voice = first person + `narrate(author=<NPC>, tone='npc')`; place voice = second person + `narrate(author=<location>, tone='narrator')`. Mismatches confuse the player about who said what.

## The contract

Two voices, two authors:

- **NPC voice.** First-person speech and first-person body action ("I lean forward, I smirk"). `narrate(author='Mikka Quickgrin', tone='npc', text='Hey there, fresh meat!')`. The chat bubble lands attributed to Mikka with NPC styling.
- **Place/scene voice.** Second-person prose; environmental observation ("The lane is buzzing, light through the awnings"). `narrate(author='Quickgrin Lane', tone='narrator', text='...')`. The bubble lands as scene framing.
- **Player/protagonist voice.** Player-authored action lives only in the existing `tone='player'` row. Spec 77 may polish that row's visible text through the Protagonist Action Renderer, but raw input remains canonical in `payload.original_text`; NPC and scene bubbles must never claim the player's action as their own.

Three rules:

1. **`author` is REQUIRED on every narrate.** Never rely on auto-resolve. If you omit it, the engine falls back to `dialogue_partner_id`, which sticks the wrong NPC on scene-painting prose for the rest of the conversation.
2. **`@`-mention rule.** If the player addresses an NPC via `@<NPC>` and your response includes that NPC's first-person speech, set `author=<that NPC>` and `tone='npc'`. Default fallback to location does NOT apply when an NPC is explicitly being spoken to.
3. **Don't mix voices in one bubble.** Framing action ("Mikka winks, leans back") + first-person speech ("Hey there, fresh meat!") = TWO narrate calls back-to-back: location-framing first, then NPC-speech.

Multi-NPC dialogue keeps the same rule. `players.dialogue_partner_id` is only the focused partner; `players.metadata.dialogue_participants.participant_ids` can contain every present NPC addressed in the scene. If several participants speak or act, split bubbles by author or use scene/location narration for action-only framing.

## Voice Warden enforcement

Spec 54 plus Spec 73. Pre-tool validator on `narrate` ([packages/web-server/src/agents/voiceWardenPreTool.ts](../../packages/web-server/src/agents/voiceWardenPreTool.ts)) detects three mismatch patterns:

- `mismatch_dialogue_under_location` — `author=<location>` + dialogue markers in text (em-dash speech, paired quotes `«…»` `"…"` `„…"` `「…」` `『…』`).
- `mismatch_scene_under_npc` — `author=<NPC>` + heavy second-person scene framing without dialogue.

- `mismatch_player_pov_under_npc` - `author=<NPC>` + text that is clearly the player's hero acting/speaking in first person while the NPC is the target. This is quarantined or rejected; player action belongs only in the player bubble.

On match, the validator returns:
```ts
{
  ok: false,
  reason: "voice/author mismatch: …",
  suggestion: {
    action: "Split into TWO narrate calls back-to-back: framing under the location, then NPC speech under author=<NPC display_name>, tone='npc'.",
    flagged_author, flagged_kind, dialogue_excerpt, suggested_speaker_name?
  }
}
```

Broker reads `rejected: true`, applies the split, retries. Validator is idempotent.

The check is **multilingual** by construction — no hardcoded language word lists. The LLM semantically distinguishes scene framing vs NPC dialogue in any script. See [agents/voice-warden.md](../agents/voice-warden.md), [ops/multilingual.md](../ops/multilingual.md).

## Synth-fallback voice repair

When the narrator JSON-dumps prose without calling narrate, `synthesiseNarrate` ([packages/web-server/src/turnRunnerV2.ts:917-957](../../packages/web-server/src/turnRunnerV2.ts#L917-L957)) auto-resolves an author from `dialogue_partner_id` → `current_scene_id` → `current_location_id`. Same Voice Warden prompt then runs ([packages/web-server/src/turnRunnerV2.ts:1161+](../../packages/web-server/src/turnRunnerV2.ts#L1161)) to swap the auto-resolved author when it mismatches the prose. Single source of truth — same prompt for pre-tool rejection AND repair.

Synth-fallback is only triggered when:
- Text length ≥ 50 chars (skip trivial bubbles).
- An author was auto-resolvable.
- The validator returns `mismatch_*` AND can resolve a swap target.

On swap: the chat_messages row is inserted with the corrected author. The `dialogue:engaged` SSE fires if the new author is an NPC and differs from the prior partner.

If the validator returns `mismatch_player_pov_under_npc`, synth-fallback does not persist that text as narration. It emits `narrate:quarantined` and leaves the already-persisted player bubble as the only owner of the player's action.

## Worked examples

### Player addresses an NPC

Input: `@Mikka, как дела?`

**Wrong:** `narrate(author='Quickgrin Lane', tone='narrator', text='— А, ты, опять. Что нужно?')` — place author with NPC speech.
- Voice Warden flags `mismatch_dialogue_under_location`.
- Suggestion: split into two; framing under location, speech under Mikka.

**Right:** broker reads suggestion, retries with two calls:
```ts
narrate(author='Quickgrin Lane', tone='narrator', text='Микка отрывает взгляд от свёрнутой бумаги, упирает руку в бок.')
narrate(author='Mikka Quickgrin', tone='npc', text='— А, ты, опять. Что нужно?', done=true)
```

### Place is observed

Input: `I look around the lane.`

**Right (single narrate, no NPC speech):**
```ts
narrate(author='Quickgrin Lane', tone='narrator',
  text='The lane is loud — fishmonger barking prices, lamp-girl swinging her wares...', done=true)
```

No mismatch — pure scene framing, location author.

### NPC walks the player through their workshop

Input: `Borek, show me your workshop.`

NPC narrates their workspace in first person ("My bench is where the planing happens"):
```ts
narrate(author='Borek', tone='npc',
  text='Stand here. My bench is where the planing happens — see the curls, that is the morning quota...', done=true)
```

The Warden lets this through. First-person language + NPC author = consistent. The "second person" in *the player's* head doesn't make this scene framing — it's still Borek talking.

But if the same prose were under `author='Quiet Lantern Inn workshop'`, Voice Warden would flag `mismatch_dialogue_under_location` because of the first-person markers and suggest the split.

### Mixed bubble forces split

Input: `I sit down at Mikka's table.`

**Wrong:** `narrate(author='Mikka Quickgrin', tone='npc', text='You sit. Mikka regards you, then leans in. — Speak, then.')` — NPC author with second-person framing AND dialogue.
- Voice Warden flags `mismatch_scene_under_npc`.

**Right:** two narrate calls:
```ts
narrate(author='Quickgrin Lane', tone='narrator', text='You sit at the cart. Mikka regards you, then leans in.')
narrate(author='Mikka Quickgrin', tone='npc', text='Speak, then.', done=true)
```

The Warden's bias: split is always safer than blending. Even minor mixing is rejected so the dialogue UI stays accurate (per-NPC context menu, partner switch, mood pulse).

## Sources

- [packages/web-server/prompts/greenhaven.md](../../packages/web-server/prompts/greenhaven.md) — the contract (lines 18-22)
- [packages/web-server/src/agents/voiceWardenPreTool.ts](../../packages/web-server/src/agents/voiceWardenPreTool.ts) — pre-tool validator
- [packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts) — synth-fallback voice repair
