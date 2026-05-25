# Voice Warden (spec 54)

Pre-tool validator on `narrate`. It has deterministic structural checks for obvious author/tone mismatches and an LLM-backed multilingual semantic check for broader voice/author mismatch. Same prompt is re-used by the synth-fallback voice repair path.

## Goal

Enforce **Voice = author**. The contract from [packages/web-server/prompts/greenhaven.md:18](../../packages/web-server/prompts/greenhaven.md#L18):

- NPC voice = first person + `narrate(author=<NPC>, tone="npc")`
- Place/scene voice = second person + `narrate(author=<location>, tone="narrator")`

Mismatches confuse the player about who said what. Voice Warden catches two patterns:

| Pattern | Mismatch | Fix |
|---|---|---|
| `dialogue_under_location` | `author=<location>` + NPC dialogue (em-dash speech, paired quotes) in text | Split into two: framing under location, then NPC speech under `author=<NPC>, tone='npc'` |
| `scene_under_npc` | `author=<NPC>` + heavy second-person scene framing, no dialogue | Split: framing under location, NPC's first-person under NPC |

The semantic check is **multilingual** by construction — no hardcoded language word lists. The LLM distinguishes scene-framing prose from NPC-dialogue prose in any script. Spec 92 also adds provider-less checks before the LLM call: a location/scene author cannot carry `tone="npc"`, and an NPC-authored bubble that explicitly `@`-mentions that same NPC is rejected as scene framing under the wrong bubble. See [ops/multilingual.md](../ops/multilingual.md).

## Goal — full intent

Stop "place is talking like a person" bubbles. Player addresses Mikka with `@Mikka, how are you?`; broker emits `narrate(author='Quickgrin Lane', tone='narrator', text='— Hey there, fresh meat!')`. The bubble lands attributed to the lane. Player has no idea Mikka actually said that — and the dialogue partner UI doesn't update.

## Mode

Pre-tool validator on `narrate`, registered at module load by [packages/web-server/src/tools/index.ts:48](../../packages/web-server/src/tools/index.ts#L48). Runs **after** Movement Warden — game-state correctness > UX clarity.

Same validator runs as the **synth-fallback voice repair** ([packages/web-server/src/turnRunnerV2.ts:917-957](../../packages/web-server/src/turnRunnerV2.ts#L917-L957)) — when the narrator JSON-dumped its prose without calling narrate, the synth path runs the same `voiceWardenPrompt` to swap the auto-resolved author if it mismatches.

## Output schema

Defined at [packages/web-server/src/agents/voiceWardenPreTool.ts:42-55](../../packages/web-server/src/agents/voiceWardenPreTool.ts#L42-L55):

```ts
{
  verdict: 'ok' | 'mismatch_dialogue_under_location' | 'mismatch_scene_under_npc',
  reason: string,
  suggested_author_kind?: 'person' | 'location' | 'scene' | null,
  suggested_speaker_name?: string | null,
  split_action?: string | null,
}
```

When `verdict !== 'ok'` the validator returns:
```ts
{
  ok: false,
  reason: "voice/author mismatch: …",
  suggestion: {
    action: "Split into TWO narrate calls back-to-back: framing under the location, then NPC speech under author=<NPC display_name>, tone='npc'.",
    flagged_author: <name>,
    flagged_kind: 'location' | 'person',
    dialogue_excerpt: <short snippet>,
    suggested_speaker_name?: string,
  }
}
```

The broker reads the suggestion and emits the two narrate calls back-to-back. Validator is idempotent — same args produce same verdict.

## Where it's wired

- Validator: [packages/web-server/src/agents/voiceWardenPreTool.ts:57-68](../../packages/web-server/src/agents/voiceWardenPreTool.ts#L57-L68).
- Registered at module load via [packages/web-server/src/tools/index.ts:48](../../packages/web-server/src/tools/index.ts#L48).
- Cheap structural skips before LLM call: empty text, missing author, etc. Avoids `runSpecialist` for the no-op cases.
- Loads candidate NPCs at the player's `current_location_id` so the prompt has a list of plausible speakers when suggesting a swap target.
- Reuses the prompt at [packages/web-server/src/agents/voiceWardenPrompt.ts](../../packages/web-server/src/agents/voiceWardenPrompt.ts) — single source of truth shared with synth-fallback voice repair (`runVoiceRepair` in [packages/web-server/src/turnRunnerV2.ts:1161+](../../packages/web-server/src/turnRunnerV2.ts#L1161)).
- `narrate` tool itself ([packages/web-server/src/tools/narrate.ts](../../packages/web-server/src/tools/narrate.ts)) is what the validator gates.

## Failure & fail-open

- Any throw inside `detect()` → `{ok: true}` (the call passes). Logged warning. The synth-fallback voice repair is still around as defense-in-depth.
- LLM timeout: 4500ms hard cap (matching Movement Warden's). Hung specialist never deadlocks a player turn.
- Cheap structural skips first → LLM only fires when there's a plausible mismatch.
- Author entity not found in DB → pass (validator can't reason about phantom authors).

The fail-open contract is the broker's full Voice = author rules in `prompts/greenhaven.md` plus the synth-fallback voice repair.

## Prompt

Source: [packages/web-server/src/agents/voiceWardenPrompt.ts](../../packages/web-server/src/agents/voiceWardenPrompt.ts).

System covers:
- Multilingual semantic distinction between scene framing (camera-perspective, second-person, environmental) vs. NPC dialogue (first-person speech, direct address).
- Recognition of dialogue markers in any script: em-dash (`— …`), paired quotes (`«…»` / `"…"` / `„…"` / `「…」` / `『…』`), Latin quotes.
- The three verdicts (ok / dialogue_under_location / scene_under_npc).
- Suggested swap target: when the prose contains an NPC's name or `@`-mention, the validator can suggest `suggested_speaker_name`; otherwise fall back to "split with framing first".

Temperature 0.2 — voice classification wants determinism. Output is JSON only, validated by the Zod schema above.

User builder formats the candidate NPCs at this location, the author + tone + text, and the prose excerpt.

## Sources

- [packages/web-server/src/agents/voiceWardenPreTool.ts](../../packages/web-server/src/agents/voiceWardenPreTool.ts) — pre-tool validator
- [packages/web-server/src/agents/voiceWardenPrompt.ts](../../packages/web-server/src/agents/voiceWardenPrompt.ts) — shared system prompt + user builder
- [packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts) — synth-fallback voice repair (same prompt)
- [packages/web-server/plans/execution-roadmap/specs/54-voice-consistency-validator.md](../../packages/web-server/plans/execution-roadmap/specs/54-voice-consistency-validator.md) — original spec
