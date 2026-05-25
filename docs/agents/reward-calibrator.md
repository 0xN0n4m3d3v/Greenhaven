# Reward Calibrator (spec 47)

Blocking pre-broker advisory specialist. Computes XP / strings / inspiration
bands for THIS turn based on player level, recent XP history, scene scale,
cartridge tier, and the player's input. Emits a `<reward_briefing>` block into
the broker user message; broker uses bands as guidance but can override with an
audit reason.

## Goal

Stop XP inflation and string-currency drift. The broker is generous by default —
every adventurous turn earns 50 XP, every NPC interaction bumps a string by +1,
characters hit level 5 in one session. The Calibrator reads the recent XP log,
the cartridge's reward tier, and the scene scale, then proposes bands that match
the campaign's pacing.

Bands are advisory:

- `xp_band: {trivial, scene, arc_beat, arc_end}` — each `{min, max}`. Broker
  picks the bucket that matches the turn.
- `strings_max_per_beat: 1..2` — how many string deltas allowed this beat.
- `inspiration_per_scene: 0..2` — inspiration grants this scene.
- `recent_inflation_warning: bool` / `recent_omission_warning: bool` —
  recent-history signals.
- `scene_scale_final` — the calibrator's classification: trivial / scene_beat /
  arc_beat / arc_climax.

Broker can override any band, but **must pass
`calibrator_override_reason='<why>'`** on the tool call. The engine emits
`reward:calibrator_override` SSE so the override is auditable.

## Mode

`blocking` pre-broker briefing. Declared in
[packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts)
and executed by
[packages/web-server/src/turnBrokerStage.ts](../../packages/web-server/src/turnBrokerStage.ts)
as `rewardCalibratorHook`. Runs every turn (no mode-gating) because any turn can
carry reward implications.

## Output schema

Defined at
[packages/web-server/src/agents/rewardCalibrator.ts:39-52](../../packages/web-server/src/agents/rewardCalibrator.ts#L39-L52):

```ts
{
  xp_band: {
    trivial: {min, max},
    scene: {min, max},
    arc_beat: {min, max},
    arc_end: {min, max},
  },
  strings_max_per_beat: 1 | 2,
  inspiration_per_scene: 0 | 1 | 2,
  recent_inflation_warning: boolean,
  recent_omission_warning: boolean,
  scene_scale_final: 'trivial' | 'scene_beat' | 'arc_beat' | 'arc_climax',
  notes: string,
}
```

The hook formats this into a `<reward_briefing>` block appended to the broker
user message.

## Where it's wired

- Hook export: `rewardCalibratorHook` at
  [packages/web-server/src/agents/rewardCalibrator.ts](../../packages/web-server/src/agents/rewardCalibrator.ts).
- Imported into the pre-broker hook list in
  [packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts).
- Reads `player_xp_log` for last 10 turns to compute `recent_xp_last_10_turns`.
- Reads `cartridge_meta.reward_tier` (cartridge-author config: tight | standard
  | generous).
- Computes a deterministic `scene_scale_hint` from mode + briefings before the
  LLM call (combat=arc_beat, intimacy=arc_beat, exploration=trivial unless big
  NPC reveal, etc.).
- The LLM may upshift the hint based on prose (e.g. self-sacrifice →
  arc_climax).
- Tool wrappers (`award_xp`, `string_award`, `grant_inspiration`) accept an
  optional `calibrator_override_reason` arg; when present and non-empty, the
  engine emits `reward:calibrator_override` SSE.
- Debug runner: `POST /api/debug/run-reward-calibrator` at
  [packages/web-server/src/index.ts:1088](../../packages/web-server/src/index.ts#L1088).

## Failure & fail-open

- `runSpecialist` returns null → no briefing → broker uses the reward bands
  written in `prompts/greenhaven.md` (which stay intact). Calibrator is
  _advisory_ by design.
- Timeout 5000ms — reward calibration is latency-sensitive (it's in the
  pre-broker phase).
- Calibrator is **never** a gatekeeper. Even if it returned a
  `xp_band: {min: 0, max: 0}`, the broker can override with a reason. The
  contract is "audited override", not "blocked override".

The fail-open path is "broker awards XP per its own judgement, no audit row in
`reward:calibrator_override` SSE". Acceptable degradation.

## Prompt

Source:
[packages/web-server/src/agents/rewardCalibratorPrompt.ts](../../packages/web-server/src/agents/rewardCalibratorPrompt.ts).

System covers:

- The four scene scales (trivial / scene_beat / arc_beat / arc_climax) and the
  prose patterns that promote a turn between them.
- XP band recommendations per scale × player level.
- String budget rule: a single beat shouldn't bump multiple strings; reserved
  for heavy emotional pivots.
- Inspiration economy: 0/1/2 grants per scene, lean toward 0 unless a Devil's
  Bargain or genuine heroic moment.
- Inflation/omission detection: recent-XP-last-10 windows compared to the
  cartridge tier's expected rate.
- Multilingual: `notes` written in conversation language via `languageHint` from
  `scriptUtil`.

Temperature 0.2 — band assignment wants determinism. `maxOutputTokens: 600` —
enough for the band JSON + 1-2 sentence notes.

## Sources

- [packages/web-server/src/agents/rewardCalibrator.ts](../../packages/web-server/src/agents/rewardCalibrator.ts)
  — hook, schema, helper queries
- [packages/web-server/src/agents/rewardCalibratorPrompt.ts](../../packages/web-server/src/agents/rewardCalibratorPrompt.ts)
  — system prompt + user builder
- [packages/web-server/plans/execution-roadmap/specs/47-reward-calibrator.md](../../packages/web-server/plans/execution-roadmap/specs/47-reward-calibrator.md)
  — original spec
