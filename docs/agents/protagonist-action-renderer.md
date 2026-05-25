# Protagonist Action Renderer

Spec 77 adds a player-only renderer that can turn command-style input into a polished hero bubble while keeping the raw player command as the canonical intent.

## Contract

The renderer is not a narrator, moderator, or adjudicator. It can only do one of two things:

- Return a faithful, more literary player-bubble version.
- Fail open and keep the raw input unchanged.

The raw input remains authoritative for classification, mechanics, dice, movement, inventory, tool execution, quest routing, and consent/consequence handling. The rendered text is only the visible `tone='player'` bubble and the prose version replayed to NPC dialogue context as the player's own authored line.

## Availability

The renderer is currently disabled in the live turn pipeline.

Manual desktop testing showed that the player-bubble rewrite added latency and
did not materially improve the core game loop. The server now keeps the raw
player input as both canonical intent and visible player bubble, storing
`protagonist_renderer.enabled=false` and
`skipped_reason='disabled_by_design'`.

The validation helpers, fixtures, and prompt remain in the repo as a dormant
future feature, but `startTurnV2()` does not call the specialist during play.

## Turn Pipeline

`startTurnV2()` no longer calls `renderProtagonistAction()` during normal play.
It writes the player `chat_messages` row with `text = original_text =
visible_text = rawPlayerText`.

Persistence stays in the existing player-message row:

```json
{
  "source": "user",
  "turn_id": "turn-...",
  "actionId": null,
  "original_text": "I take @Mikka by the hand.",
  "visible_text": "I take @Mikka by the hand.",
  "protagonist_renderer": {
    "enabled": false,
    "changed": false,
    "skipped_reason": "disabled_by_design",
    "confidence": null,
    "model_id": "disabled"
  }
}
```

The broker, classifier, and mode classifier all receive the raw text only.

## Validation

The renderer output is rejected before persistence if it:

- Contains JSON fences, top-level JSON, `narrate(`, or handoff/control text.
- Drops `@mentions`, bracketed commands, inline dice, or quoted speech.
- Changes `meaning_delta` away from `none`.
- Adds NPC/scene framing such as an NPC accepting, refusing, answering, or reacting.
- Drops named targets, negation/refusal terms, profanity, violence/intimacy markers, or too much lexical content from the raw command.

Rejected output stores the raw player input and records `skipped_reason`.

## Frontend

The server still emits `player:message_rendered`, but `changed=false` while the
feature is disabled. The frontend therefore leaves the optimistic player bubble
unchanged.

No visible UI label is added; persisted state remains the source of truth after the turn finishes.

## Verification

- Support smoke check: `protagonist_renderer_validation`.
- Fixture IDs: `protagonist_render_preserves_intent`, `protagonist_render_rejects_drift`.
- Harness command: `npm exec -- tsx packages/web-server/scripts/simulate-specialist.ts --specialist protagonist_action_renderer`.
- Debug aggregate: `/api/debug/session-diag` returns `protagonist_renderer_today` and `protagonist_renderer_skipped_today`.

## Sources

- [packages/web-server/src/agents/protagonistActionRenderer.ts](../../packages/web-server/src/agents/protagonistActionRenderer.ts)
- [packages/web-server/src/agents/protagonistActionRendererPrompt.ts](../../packages/web-server/src/agents/protagonistActionRendererPrompt.ts)
- [packages/web-server/src/turnRunnerV2.ts](../../packages/web-server/src/turnRunnerV2.ts)
- [packages/web-ui/src/hooks/useSseSubscriptions.ts](../../packages/web-ui/src/hooks/useSseSubscriptions.ts)
