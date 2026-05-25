/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Post-turn agent: Narrative Claim Sweeper.
//
// Reads the just-emitted narrate prose and the turn's toolHistory and
// asks a focused LLM specialist whether any state-changing claim in
// the prose is missing its canonical tool call. For each unmatched
// claim, writes a PRIVATE memory to the speaking NPC: "next turn,
// canonize this with <suggested_tool>". On the next turn, that
// private note surfaces in the NPC's own preamble and gives the
// broker a self-correction nudge — without rejecting or rewriting
// the current turn.
//
// This is the autonomic counterpart to state-canonization.md: that
// prompt fragment tells the broker what to do at write-time; this
// agent catches what was missed at read-time of the very next turn.
//
// Fail-open. Any error path leaves no memory; the player sees nothing.

import {z} from 'zod';
import {query} from '../db.js';
import {insertArchivalNpcMemory} from '../domain/memory/index.js';
import {
  runSpecialist,
  type PostTurnHook,
  type SpecialistContext,
} from './base.js';
import {
  POST_TURN_SLOT_WATCHDOG_MS,
  POST_TURN_SPECIALIST_WATCHDOG_MS,
} from '../postTurnTiming.js';

interface ToolHistoryEntry {
  name: string;
  args: unknown;
  result?: unknown;
  ok?: boolean;
}

export const narrativeClaimSweeperHook: PostTurnHook = {
  name: 'narrative_claim_sweeper',
  presentation: {
    slotKey: 'post.narrative_claim_sweeper',
    lane: 'rail',
    ordinal: 58,
    visible: false,
    barrierMode: 'non_blocking',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx, turnRecord) {
    try {
      await runOnce(ctx, turnRecord.toolHistory ?? []);
    } catch (err) {
      // CATCH-WARN-OK: post-turn slot wrapper; the slot's own `presentationSlot.telemetry` (S-14) records the slot outcome with the failure status.
      console.warn(
        '[agent:narrative_claim_sweeper] failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    }
  },
};

async function runOnce(
  ctx: SpecialistContext,
  toolHistory: ToolHistoryEntry[],
): Promise<void> {
  // Pull the narrate for THIS turn that was actually emitted.
  const narrateCall = toolHistory.find(c => c.name === 'narrate' && c.ok !== false);
  const narrateArgs =
    narrateCall &&
    typeof narrateCall.args === 'object' &&
    narrateCall.args !== null
      ? (narrateCall.args as Record<string, unknown>)
      : null;
  const narrateText =
    typeof narrateArgs?.['text'] === 'string'
      ? (narrateArgs['text'] as string)
      : '';
  if (!narrateText.trim() || narrateText.length < 60) {
    // Trivially short narrate — unlikely to encode a state change worth
    // catching, and the LLM cost isn't worth it.
    return;
  }

  // Compact summary of what the broker DID this turn — just tool names
  // + first ~80 chars of args. The specialist uses this to decide
  // whether a prose claim got canonized.
  const toolCallsSummary = toolHistory
    .filter(c => c.ok !== false)
    .map(c => {
      let preview = '';
      try {
        preview =
          typeof c.args === 'string'
            ? c.args.slice(0, 80)
            : JSON.stringify(c.args).slice(0, 80);
      } catch {/* swallow */}
      return `- ${c.name}: ${preview}`;
    })
    .join('\n')
    .slice(0, 1200);

  // Identify the speaking NPC (if any) so we can route the private
  // memory to their bank. For location-authored narrate we still log
  // the sweep but do not write a private memory (locations don't have
  // a memory channel in this sense).
  const author = narrateArgs?.['author'];
  const authorId = await resolveAuthorIdForMemory(author, ctx);

  const ClaimSchema = z.object({
    description: z.string().min(8).max(240),
    suggested_tool: z.string().min(2).max(80),
    severity: z.enum(['minor', 'moderate', 'severe']),
  });
  const Output = z.object({
    unmatched_claims: z.array(ClaimSchema).max(6),
  });

  const result = await runSpecialist(
    {
      name: 'narrative_claim_sweeper',
      mode: 'async',
      outputSchema: Output,
      timeoutMs: POST_TURN_SPECIALIST_WATCHDOG_MS,
      temperature: 0.2,
      maxOutputTokens: 600,
      buildPrompt: () => ({
        system: SYSTEM_PROMPT,
        user: [
          'NARRATE TEXT (what the player saw):',
          narrateText.slice(0, 3000),
          '',
          'TOOLS CALLED THIS TURN (in order):',
          toolCallsSummary || '(none)',
        ].join('\n'),
      }),
    },
    {},
    {
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      signal: ctx.signal,
    },
  );
  if (!result || result.unmatched_claims.length === 0) return;

  console.warn(
    `[narrative_claim_sweeper] turn=${ctx.turnId} unmatched=${result.unmatched_claims.length} ` +
      `author=${authorId ?? 'unknown'}`,
  );

  if (authorId == null) {
    // No NPC author — drift is recorded only in the warn log. We do not
    // persist anything player-visible.
    return;
  }

  // Write ONE private memory per unmatched claim, owned by the speaking
  // NPC, about the active player. Keep importance modest — these are
  // self-correction nudges, not durable canon. Tag them so future
  // sweeps can recognise and dedupe.
  for (const claim of result.unmatched_claims) {
    const text =
      `[unfinished from previous turn] ${claim.description.trim()} — ` +
      `next turn, canonize with ${claim.suggested_tool}.`;
    try {
      await insertArchivalNpcMemory({
        ownerEntityId: authorId,
        aboutEntityId: ctx.playerId,
        text: text.slice(0, 2000),
        importance: severityImportance(claim.severity),
        tags: ['narrative_claim_sweep', claim.severity],
        sensitive: false,
        salience: severitySalience(claim.severity),
        sourceTurnId: ctx.turnId,
        sourceTool: 'narrative_claim_sweeper',
        metadata: {visibility: 'private'},
      });
    } catch (err) {
      // CATCH-WARN-OK: best-effort private-memory archival INSERT inside the per-claim loop; the outer `runOnce` aggregates the slot outcome through `presentationSlot.telemetry` (S-14), and a single archival miss does not affect the narrative-claim verdict.
      console.warn(
        '[narrative_claim_sweeper] private-memory insert failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

function severityImportance(s: 'minor' | 'moderate' | 'severe'): number {
  if (s === 'severe') return 0.7;
  if (s === 'moderate') return 0.55;
  return 0.4;
}

function severitySalience(s: 'minor' | 'moderate' | 'severe'): number {
  if (s === 'severe') return 0.8;
  if (s === 'moderate') return 0.6;
  return 0.4;
}

async function resolveAuthorIdForMemory(
  author: unknown,
  ctx: SpecialistContext,
): Promise<number | null> {
  if (typeof author === 'number' && Number.isInteger(author) && author > 0) {
    const r = await query<{kind: string}>(
      `SELECT kind FROM entities WHERE id = $1`,
      [author],
    );
    return r.rows[0]?.kind === 'person' ? author : null;
  }
  if (typeof author === 'string' && author.trim()) {
    const name = author.trim();
    const r = await query<{id: number; kind: string}>(
      `SELECT id, kind FROM entities WHERE display_name = $1 LIMIT 1`,
      [name],
    );
    if (r.rows[0]?.kind === 'person') return Number(r.rows[0].id);
    return null;
  }
  // No author — fall back to the active dialogue partner, if any.
  const dp = await query<{dialogue_partner_id: number | null}>(
    `SELECT dialogue_partner_id FROM players WHERE entity_id = $1`,
    [ctx.playerId],
  );
  const partnerId = dp.rows[0]?.dialogue_partner_id ?? null;
  if (partnerId == null) return null;
  const r = await query<{kind: string}>(
    `SELECT kind FROM entities WHERE id = $1`,
    [partnerId],
  );
  return r.rows[0]?.kind === 'person' ? partnerId : null;
}

const SYSTEM_PROMPT = `You audit a single in-game turn for narrative-state drift.

Input: the visible NARRATE TEXT the player just saw, plus a list of
TOOLS that the broker called this turn.

Your job: find state-changing CLAIMS in the prose that were NOT
canonized by a matching tool call. State changes include:
  - an NPC moving to a different location or leaving a venue
  - an NPC renting / booking / leasing space (a room, a stall, a cell)
  - an NPC promising or accepting a deal, contract, quest, fee, or service
  - an item changing hands between any two characters (player ↔ NPC, NPC ↔ NPC)
  - an item placed in a scene for later discovery
  - an NPC's emotional / health / loyalty status changing materially
  - a location's physical state changing (door broken, sign removed, curtain cut)
  - information shared with a THIRD NPC who must remember it
  - two characters agreeing to meet later at a venue
  - quest progression (a stage advanced, a quest accepted, a quest completed)
  - XP / inspiration / strings awarded

For each claim that has NO matching tool call in the TOOLS list,
emit one entry in unmatched_claims with:
  - description: one short sentence in the language of the narrate
  - suggested_tool: the exact tool name that should have fired
    (e.g. record_location_memory, inventory_transfer, set_companion,
    advance_quest, set_actor_status, apply_runtime_field_patch,
    add_memory, create_quest, create_entity, award_xp)
  - severity: severe (player will feel the contradiction next turn) /
    moderate (other NPCs won't know) / minor (just polish)

Skip pure description, atmosphere, character voice, internal thought,
and observation. They are not state changes.

Be strict but precise. Output empty unmatched_claims when the prose
matches the tool calls. Output JSON only: {"unmatched_claims": [...]}.
`;
