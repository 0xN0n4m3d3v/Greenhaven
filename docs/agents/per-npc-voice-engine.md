# Per-NPC Voice Engine (spec 43)

Async post-turn hook. Scans the just-finished turn's `toolHistory` for
`add_memory` calls; for each NPC-owned memory, runs a focused LLM call that
enriches the memory with voice rewrite, optional internal reflection, and
optional cross-reference link.

## Goal

Make every NPC sound like _that NPC_, not a generic narrator. The broker writes
`add_memory(text=…)` in canonical English-or-prose-of-the-turn; the Voice Engine
rewrites in the NPC's `profile.speech_style` + `profile.persona` voice. See
[cartridge/persona-and-voice.md](../cartridge/persona-and-voice.md) for the
cartridge-side schema.

Three enrichment outputs:

1. **Voiced text rewrite.** First-person, NPC-specific idioms and register.
   Replaces the draft text in `npc_memories.text`.
2. **Internal reflection (optional).** Inner thought the NPC would think but not
   say. Surfaces in future preambles + as an addendum on the memory card.
3. **Cross-reference (optional).** `links_to_memory_id` + `link_reason`
   connecting this memory to a related prior one. Drives semantic continuity
   across long campaigns.

All NPC memories pass through Voice Engine — broker-direct, Director-emitted,
Coordinator-emitted, Quest-Watcher-emitted, scripted-action-emitted. Single
source of truth for voice consistency.

## Mode

`async` post-turn pipeline hook. Owned by
[packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts)
as `npcVoiceHook`.

Per-memory `Promise.allSettled`
([packages/web-server/src/agents/npcVoice.ts:56-58](../../packages/web-server/src/agents/npcVoice.ts#L56-L58))
— one bad enrichment can't stop the others.

**Idempotent.** Rows with `metadata.voiced_by` already set are skipped to
prevent re-voicing drift. Original draft text is preserved in
`metadata.draft_text` for forensics + rollback.

## Output schema

Defined at
[packages/web-server/src/agents/npcVoice.ts:64-69](../../packages/web-server/src/agents/npcVoice.ts#L64-L69):

```ts
{
  voiced_text: string,                        // 1..500 chars
  internal_reflection: string,                // 0..300 chars
  links_to_memory_id: number | null,
  link_reason: string,                        // 0..300 chars
}
```

The hook then UPDATEs `npc_memories.text = voiced_text`, sets
`metadata.voiced_by = 'npc_voice'`, `metadata.draft_text = <original>`, and
writes optional `internal_reflection` / `links_to_memory_id`.

## Where it's wired

- Hook export: `npcVoiceHook` at
  [packages/web-server/src/agents/npcVoice.ts:44-60](../../packages/web-server/src/agents/npcVoice.ts#L44-L60).
- Imported into the post-turn pipeline at
  [packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts).
- `enrichOneMemory(id, ctx)`
  ([packages/web-server/src/agents/npcVoice.ts](../../packages/web-server/src/agents/npcVoice.ts))
  loads the memory row, the owner's `profile.speech_style` and
  `profile.persona`, recent NPC utterances from `chat_messages` (last 10-15 of
  the same author), and a sample of past memories for cross-reference.
- Reads `metadata.voiced_by` to skip already-voiced rows.
- Persists via `UPDATE npc_memories SET text=$1, metadata=jsonb_set(...)`.
- Emits `memory:enriched` SSE so the EventCard can show the voiced version.
- Debug runner: `POST /api/debug/run-npc-voice` at
  [packages/web-server/src/index.ts:782](../../packages/web-server/src/index.ts#L782).

## Failure & fail-open

- `runSpecialist` returns null → memory keeps its draft text. The next preamble
  will show the broker's original phrasing — readable, just less in-character.
- DB UPDATE failure → log warning, memory unchanged.
- Per-memory failure → `Promise.allSettled` keeps the rest going.
- Memory with no NPC owner (e.g. system memo) → no-op.
- Memory whose owner has no `profile.speech_style` → still proceeds (the prompt
  handles "no style declared" gracefully).

The fail-open path is "memory text is whatever the broker wrote". Acceptable
degradation.

## Prompt

Source:
[packages/web-server/src/agents/npcVoicePrompt.ts](../../packages/web-server/src/agents/npcVoicePrompt.ts).

System covers:

- The voice contract: first-person, register matched to `speech_style`, idioms
  drawn from `persona`.
- "Don't reveal the analysis" rule — internal_reflection is a discrete output,
  not embedded in voiced_text.
- Cross-reference policy: only link when the new memory and a past one share an
  entity / relationship / event.
- Multilingual: voice transfer must respect the conversation language.
  `languageHint` from `scriptUtil`
  ([packages/web-server/src/agents/scriptUtil.ts](../../packages/web-server/src/agents/scriptUtil.ts))
  is passed in as input. See [ops/multilingual.md](../ops/multilingual.md).

User builder formats the NPC's speech_style + persona, the draft text, the
about-target, importance, tags, recent utterances (10-15 lines), and a sample of
past memories with ids for the cross-ref candidate pool.

## Sources

- [packages/web-server/src/agents/npcVoice.ts](../../packages/web-server/src/agents/npcVoice.ts)
  — hook, enrichment loop, DB persist
- [packages/web-server/src/agents/npcVoicePrompt.ts](../../packages/web-server/src/agents/npcVoicePrompt.ts)
  — system prompt + user builder
- [packages/web-server/plans/execution-roadmap/specs/43-npc-voice.md](../../packages/web-server/plans/execution-roadmap/specs/43-npc-voice.md)
  — original spec
