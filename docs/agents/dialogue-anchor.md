# Dialogue Anchor (spec 45)

Async post-turn observer of dialogue arcs. Reads recent exchanges with the
player's focused `dialogue_partner_id` and any
`players.metadata.dialogue_participants`, judges emotional beat + voice drift +
memory threshold, and writes hints into
`players.metadata.dialogue_anchor[<partner_id>]`. Next preamble surfaces the
hints as `## DIALOGUE ANCHOR`.

## Goal

Sustained dialogue arcs need a memory of _how the conversation feels_, not just
_what was said_. Without an anchor the broker drifts: an NPC who started cagey
opens up too fast, a confessor who admitted love takes another five turns to say
"you matter to me". The Anchor reads the last 5 exchanges and gives the next
preamble a calibrated emotional beat hint:

- `emotional_beat` — the arc phase (e.g. `defensive`, `opening_up`,
  `confessional`, `cooling`, `breaking`).
- `beat_reason` — short rationale.
- `voice_drift_score` — how far the NPC's recent speech has drifted from
  `profile.speech_style`.
- `voice_drift_examples` — exact lines that show drift, for the broker to
  course-correct.
- `memory_threshold_crossed` — boolean, did this scene warrant a high-importance
  memory? Plus reason.

The hints surface in the next turn's preamble; broker reads and adapts.

## Mode

`async` post-turn pipeline hook. Owned by
[packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts)
as `dialogueAnchorHook`.

Fires when:

- Player has `dialogue_partner_id` set, AND
- Turn included at least one `narrate` call (a dialogue beat actually happened).

Both gates at
[packages/web-server/src/agents/dialogueAnchor.ts:54-65](../../packages/web-server/src/agents/dialogueAnchor.ts#L54-L65).
Otherwise no-op — zero LLM call.

## Output schema

The Zod schema at
[packages/web-server/src/agents/dialogueAnchor.ts](../../packages/web-server/src/agents/dialogueAnchor.ts)
returns:

```ts
{
  emotional_beat: string,
  beat_reason: string,
  voice_drift_score: number,            // 0..1
  voice_drift_examples: string[],
  memory_threshold_crossed: boolean,
  memory_threshold_reason: string,
}
```

Persisted into `players.metadata` as JSONB:

```json
{
  "dialogue_anchor": {
    "<partner_id>": {
      "emotional_beat": "...",
      "beat_reason": "...",
      "voice_drift_score": 0.4,
      "voice_drift_examples": ["..."],
      "memory_threshold_crossed": false,
      "memory_threshold_reason": "...",
      "updated_at_turn": "<turn_id>"
    }
  }
}
```

## Where it's wired

- Hook export: `dialogueAnchorHook` at
  [packages/web-server/src/agents/dialogueAnchor.ts:40-52](../../packages/web-server/src/agents/dialogueAnchor.ts#L40-L52).
- Imported into the post-turn pipeline at
  [packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts).
- Loads partner row (`profile.speech_style`, `profile.persona`), last 5
  exchanges from `chat_messages` (player + partner pairs), and the previous
  anchor block from `players.metadata.dialogue_anchor[partner_id]`.
- In multi-NPC scenes, also iterates participant ids from
  `players.metadata.dialogue_participants.participant_ids` so secondary NPCs who
  spoke or were directly addressed can receive their own anchor hints without
  replacing the focused partner.
- Writes via
  `UPDATE players SET metadata = jsonb_set(metadata, '{dialogue_anchor,<partner_id>}', $1::jsonb)`.
- Next turn's `buildTurnContext` reads the anchor block and renders it under
  `## DIALOGUE ANCHOR` in the preamble. The broker adapts.
- Debug runner: `POST /api/debug/run-dialogue-anchor` at
  [packages/web-server/src/index.ts:682](../../packages/web-server/src/index.ts#L682).

## Failure & fail-open

- Wrapped in try/catch at the hook level
  ([packages/web-server/src/agents/dialogueAnchor.ts:42-50](../../packages/web-server/src/agents/dialogueAnchor.ts#L42-L50)).
  Any error → log warning, leave metadata unchanged.
- Player has no partner → no-op.
- Turn had no `narrate` (broker exited early, scripted action) → no-op.
- Partner has no `speech_style` → still proceeds; the schema accepts null and
  the prompt handles "no style declared".
- LLM fails / schema mismatches → previous anchor stays; preamble simply lacks
  the new ANCHOR hint next turn.

The fail-open path is "no anchor hints in the next preamble" — the broker still
works, just without the recently-calibrated drift signal.

## Prompt

Source:
[packages/web-server/src/agents/dialogueAnchorPrompt.ts](../../packages/web-server/src/agents/dialogueAnchorPrompt.ts).

System covers:

- Emotional beat taxonomy (defensive / opening_up / confessional / cooling /
  breaking / playful / hostile / etc.) — open-ended; the model picks the best
  label.
- Voice drift detection: compare recent NPC utterances to `speech_style`
  declared in cartridge.
- Memory threshold rule: a beat that warrants a memory has at least one of (a)
  revealed canon fact, (b) emotional pivot, (c) commitment made.
- Multilingual — `languageHint` from `scriptUtil`
  ([packages/web-server/src/agents/scriptUtil.ts](../../packages/web-server/src/agents/scriptUtil.ts))
  gates the prompt to write `beat_reason` in the conversation language.

User builder formats partner name + style + persona, the previous anchor (if
any), and the last 5 exchanges in chronological order.

## Sources

- [packages/web-server/src/agents/dialogueAnchor.ts](../../packages/web-server/src/agents/dialogueAnchor.ts)
  — hook, exchange loader, metadata persist
- [packages/web-server/src/agents/dialogueAnchorPrompt.ts](../../packages/web-server/src/agents/dialogueAnchorPrompt.ts)
  — system prompt + user builder
- [packages/web-server/plans/execution-roadmap/specs/45-dialogue-anchor.md](../../packages/web-server/plans/execution-roadmap/specs/45-dialogue-anchor.md)
  — original spec
