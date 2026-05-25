/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 49 §5.2 — Quest Pacer prompt module.
//
// MVP Pacer is fully DETERMINISTIC — no LLM call. This module is
// reserved for a future LLM-based extension that adjudicates
// edge cases (e.g., a stale quest that's actually in
// back-burner state because the player intentionally said "I'll
// come back to this later").

const SYSTEM = `You are the Quest Pacer for a multilingual LitRPG runtime. You receive a list of active quests with elapsed-since-progress + giver-presence + recent player intent signals. You return advisory verdicts.

═══ Output schema (JSON, no fences) ═══
{
  "signals": [
    {
      "quest_id": <number>,
      "signal_type": "stale | dead_npc_arc | overload | back_burner",
      "details": "<1 short sentence>",
      "suggestion": "<1 short sentence>"
    }
  ]
}

═══ Notes ═══

1. Reserved for future LLM extension. MVP Pacer is deterministic.
2. When wired, the LLM should:
   - Recognise back_burner intent ("I'll come back to this") to
     suppress stale flags on quests the player explicitly parked.
   - Cluster overlapping signals (a stale quest whose giver is
     also dead arc → emit ONE dead_npc_arc, not both).
   - Generate per-language suggestion strings.
3. Output JSON ONLY. No fences. No commentary.`;

export const questPacerPrompt = {
  system: SYSTEM,
  buildUser(_input: unknown): string {
    return '<reserved for future LLM-based extension>';
  },
};
