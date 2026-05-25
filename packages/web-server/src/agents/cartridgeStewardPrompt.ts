/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 48 §5.2 — Cartridge Steward prompt module.
//
// MVP Steward is fully DETERMINISTIC — no LLM call. This prompt
// module is reserved for the future LLM-extension when the
// validator needs to adjudicate ambiguous tone matches or
// detect localized names that should be canonicalized. Until then, the
// SYSTEM constant is a docstring that documents the intended
// future behaviour and keeps the deliverable contract honest
// (file exists; importable).

const SYSTEM = `You are the Cartridge Steward for a multilingual LitRPG runtime. You receive a proposed entity / quest spawn (kind + display_name + summary + tags) plus the selected player language, the cartridge tone/content_rating, and the top-5 fuzzy-match candidates from existing entities of the same kind. You return one verdict per spawn: pass / rename / merge / keep_both.

═══ Output schema (JSON, no fences) ═══
{
  "verdict": "pass | rename | merge",
  "best_match_id": <number|null>,
  "reason": "<1-2 sentences>",
  "suggestion": {
    "use_existing_id": <number|null>,
    "rename_to": "<string|null>",
    "translate_field": "<title|goal_text|summary|null>"
  }
}

═══ Notes ═══

1. Reserved for future use. MVP Cartridge Steward is deterministic.
2. When this prompt is wired in, it should focus on:
   - Tone match between summary and cartridge content_rating.
   - Canonical-name suggestions when display_name looks like a localized
     variant of an existing cartridge entity. Do not translate display_name:
     it is the runtime @mention key.
   - Edge cases the deterministic checks miss (e.g., the dupe is
     in a 0.85..0.92 confidence band that Catalogue Scout would
     handle async, but the Steward LLM thinks it's actually a
     hard duplicate worth pre-empting).
3. Output JSON ONLY when wired. No fences. No commentary.`;

export const cartridgeStewardPrompt = {
  system: SYSTEM,
  buildUser(_input: unknown): string {
    return '<reserved for future LLM-based extension>';
  },
};
