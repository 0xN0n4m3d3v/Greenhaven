# Scene Painter (spec 44)

Cheap alternative to the default narrator for T2 ambient turns. Wraps `runNarrator` with `deepseek-chat` as the model + a Scene Painter system-prompt addendum. Drop-in replacement so the runner can swap it in transparently.

## Goal

Cut narrator cost on the cheap, ambient half of the turn distribution. T2 turns ("I look around", "miro alrededor", "@<NPC>, ¿qué tal?") don't need a 24B-param adult-tuned narrator — they need a competent multilingual model that can paint a scene. `deepseek-chat` does this for ~10× less cost than Magnum/Cydonia.

The runner ([packages/web-server/src/turnRunnerV2.ts:534-577](../../packages/web-server/src/turnRunnerV2.ts#L534-L577)) decides on Scene Painter for `tier === 'T2'`.

## Mode

Not a `runSpecialist`-style hook — Scene Painter IS the narrator for T2 turns. Sits at the same layer as `runNarrator` and exports the same `NarratorOutcome` shape so the dispatcher in `turnRunnerV2` can swap it in/out without restructuring.

Telemetry row uses `role='narrator-scene-painter'` ([packages/web-server/src/turnRunnerV2.ts:550](../../packages/web-server/src/turnRunnerV2.ts#L550)). On failure the runner retries with full Magnum and writes `role='narrator-painter-fallback'` instead.

## Output schema

`NarratorOutcome` from [packages/web-server/src/ai/handoff.ts](../../packages/web-server/src/ai/handoff.ts) — same as the default narrator path:

```ts
{
  contentBuffer: string,        // streamed prose
  toolCallsSeen: number,        // 0 = synth-fallback territory
  jsonDumpDetected: boolean,    // model JSON-dumped narrate args
  inputTokens, outputTokens, cacheHitTokens, cacheMissTokens,
}
```

`narrate` is the only tool offered — Scene Painter doesn't drive state, just renders prose. State changes for T2 turns are zero by design (the classifier picked T2 specifically because no mutation is expected).

## Where it's wired

- Implementation: `runScenePainter` at [packages/web-server/src/agents/scenePainter.ts:42-78](../../packages/web-server/src/agents/scenePainter.ts#L42-L78).
- Dynamic-imported by `turnRunnerV2` at [packages/web-server/src/turnRunnerV2.ts:539](../../packages/web-server/src/turnRunnerV2.ts#L539) so it doesn't load when not needed.
- Reuses the same `runNarrator` core, swapping `narrator` model and appending `SCENE_PAINTER_ADDENDUM` to the system prompt.
- No DeepSeek key → throws `scene_painter_no_deepseek_key`; runner catches and falls back to Magnum.
- Debug runner: `POST /api/debug/run-scene-painter` at [packages/web-server/src/index.ts:718](../../packages/web-server/src/index.ts#L718).

## Failure & fail-open

- Init throws (no key, model creation fails) → propagates to `turnRunnerV2`, which catches at [packages/web-server/src/turnRunnerV2.ts:553-567](../../packages/web-server/src/turnRunnerV2.ts#L553-L567) and retries with full Magnum (`role='narrator-painter-fallback'`).
- Mid-stream failure → same fallback path. The player sees a momentary delay but the turn completes with full-quality narrator.
- Synth-fallback: if Painter doesn't call `narrate` but did stream content, the same `synthesiseNarrate` path that handles default narrator JSON-dumps also handles Painter output ([packages/web-server/src/turnRunnerV2.ts:597-602](../../packages/web-server/src/turnRunnerV2.ts#L597-L602)).

The fail-open contract: a Scene Painter outage gracefully degrades to default narrator. Cost goes up, quality is the same.

## Prompt

Source: [packages/web-server/src/agents/scenePainterPrompt.ts](../../packages/web-server/src/agents/scenePainterPrompt.ts). Exports `SCENE_PAINTER_ADDENDUM` — appended to the loaded `prompts/greenhaven.md` system prompt at [packages/web-server/src/agents/scenePainter.ts:68](../../packages/web-server/src/agents/scenePainter.ts#L68).

The addendum tightens the brief for T2:
- Render scene texture: light, sound, smell, body language at the periphery.
- Don't drive plot — T2 turns are *ambience*. No revelations, no NPC commitments unless the prose called for them.
- Voice = author rule still applies; if the prose surfaces an NPC speaking, split into two narrate calls (the same Voice Warden rule that pre-tool validators enforce — see [voice-warden.md](voice-warden.md)).
- Scope: when the player asks an NPC a casual question, render the NPC's reply first-person under `author=<NPC>, tone='npc'`; for ambient observation, render second-person under `author=<location>, tone='narrator'`.

The full broker prompt rules apply too — Painter inherits them. The addendum just adjusts emphasis for the cheap-narrator path.

## Sources

- [packages/web-server/src/agents/scenePainter.ts](../../packages/web-server/src/agents/scenePainter.ts) — `runScenePainter`, fallback contract
- [packages/web-server/src/agents/scenePainterPrompt.ts](../../packages/web-server/src/agents/scenePainterPrompt.ts) — `SCENE_PAINTER_ADDENDUM`
- [packages/web-server/plans/execution-roadmap/specs/44-scene-painter.md](../../packages/web-server/plans/execution-roadmap/specs/44-scene-painter.md) — original spec
