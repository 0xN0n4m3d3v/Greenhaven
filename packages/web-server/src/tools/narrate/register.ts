/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// N-1 — narrate `registerTool({name: 'narrate', ...})` orchestration.
//
// The execute() body composes the narrate slice modules in the same
// order the pre-N-1 monolithic `tools/narrate.ts` ran them, so query
// order, SSE order, and visible side-effects all match the original
// file. Each helper is documented at its own definition; this file
// intentionally stays a thin coordinator.

import {telemetry} from '../../telemetry/index.js';
import {loadWitnessIdsForLocation} from '../../locationPresence.js';
import {resolveActivePlayerCartridgeId} from '../../services/CartridgePlaythroughService.js';
import {sessionManager} from '../../sessionManager.js';
import {registerTool, StopExecution} from '../base.js';
import {
  enforceCanonicalMentionText,
  getAllMentionEntities,
  scanMentions,
} from '../runtimeContext.js';
import {applyDirectivePass} from './directives.js';
import {
  correctToneForAuthor,
  loadPlayerFrame,
  maybeAutoSwapAuthorToPartner,
  maybeClearDialogueOnSceneShift,
  maybeEngageDialogueOnNpcSpeak,
  resolveInitialAuthor,
  type NarrateTone,
} from './dialogueSync.js';
import {
  allocateTurnIndex,
  guardSessionExists,
  insertChatMessageOrStop,
  persistAutoSnapshotMemory,
  persistInternalMonologueMemory,
} from './persistence.js';
import {sanitiseNarrateTextWithReport} from './sanitiser.js';
import {recordNarrateSanitiserTelemetry} from './sanitiserTelemetry.js';
import {NarrateArgs} from './schema.js';
import {
  emitDialogueEngaged,
  emitDialogueParticipantsCleared,
  emitNarrationStream,
} from './sseEmit.js';

registerTool({
  name: 'narrate',
  description:
    'Optional internal_monologue is hidden diagnostic context only: it is never streamed to the player and is redacted from tool audit args. ' +
    'Send visible prose to the player. This MUST be the final tool call of every turn — after narrate the turn is OVER and you must not call any further tools. text is what appears in the chat bubble verbatim.',
  paramsSchema: NarrateArgs,
  async execute(rawArgs, ctx) {
    // Sanitise leaked internal-analysis & OOC tags before anything
    // else touches the text. The sanitiser also de-dupes consecutive
    // identical paragraphs the model sometimes emits. N-2 Phase 1 —
    // report which patterns fired so we can later move them out of
    // the runtime sanitizer once the prompt engineering replacement
    // is in place. N-4 — pass the active turn's resolved language
    // so paragraph dedup uses `toLocaleLowerCase(language)` for
    // locale-correct comparison (Turkish dotted-I etc.) instead of
    // the host's implicit system locale.
    const activeLanguage =
      sessionManager.get(ctx.sessionId)?.activeTurn?.language ?? null;
    const sanitiseReport = sanitiseNarrateTextWithReport(
      rawArgs.text,
      activeLanguage,
    );
    const sanitised = sanitiseReport.text;
    // N-2 Phase 3 readiness — share one helper with
    // `narrationSynthesis.ts` so the inspected/fired event shapes
    // cannot drift between the direct tool path (here) and the
    // synth-v2 fast path. Inspected fires every runtime call;
    // fired fires only when the sanitizer changed text. Payload
    // contract enforced inside the helper.
    recordNarrateSanitiserTelemetry({
      ctx: {
        sessionId: ctx.sessionId,
        playerId: ctx.playerId,
        turnId: ctx.turnId ?? null,
      },
      report: sanitiseReport,
      source: 'narrate_tool',
    });

    // Spec 37 §2 — strip Inkle-style `# tag: payload` directives,
    // emit them as typed SSE events.
    const {cleanedText} = await applyDirectivePass({
      sessionId: ctx.sessionId,
      sanitisedText: sanitised,
    });
    // Zod `.default(...)` applies at parse time, so by the moment
    // `execute` runs `rawArgs.tone` and `rawArgs.done` are filled
    // — the `?? ...` fallback is purely a TypeScript narrowing
    // step to escape the optional-default shape of `z.input`.
    let tone: NarrateTone = rawArgs.tone ?? 'narrator';
    const done: boolean = rawArgs.done ?? true;
    let text = cleanedText;
    const mentionEntities = await getAllMentionEntities(ctx.playerId);
    const mentionRepair = enforceCanonicalMentionText(text, mentionEntities);
    if (mentionRepair.changed) {
      text = mentionRepair.text;
    }
    const internalMonologue =
      typeof rawArgs.internal_monologue === 'string'
        ? rawArgs.internal_monologue.trim()
        : '';

    const playerFrame = await loadPlayerFrame(ctx.playerId);
    let author = await resolveInitialAuthor({
      rawAuthor: rawArgs.author,
      playerFrame,
    });
    tone = correctToneForAuthor(tone, author.authorKind);
    const swapped = await maybeAutoSwapAuthorToPartner({
      text,
      tone,
      author,
      playerFrame,
    });
    author = swapped.author;
    tone = swapped.tone;

    const engagedUpdate = await maybeEngageDialogueOnNpcSpeak({
      authorKind: author.authorKind,
      authorId: author.authorId,
      playerId: ctx.playerId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
    });
    if (engagedUpdate && author.authorId != null) {
      await emitDialogueEngaged({
        ctx,
        authorId: author.authorId,
        authorName: author.authorName,
        update: engagedUpdate,
      });
    }

    await guardSessionExists({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
    });

    const turnIndex = await allocateTurnIndex(ctx.sessionId);

    const payload: Record<string, unknown> = {
      turn_id: ctx.turnId ?? null,
      done,
    };
    if (internalMonologue.length > 0) {
      payload['internal_monologue'] = internalMonologue;
      persistInternalMonologueMemory({
        authorKind: author.authorKind,
        authorId: author.authorId,
        playerId: ctx.playerId,
        turnId: ctx.turnId,
        internalMonologue,
      });
    }

    const npcEntityId =
      author.authorKind === 'person'
        ? author.authorId
        : (playerFrame?.dialogue_partner_id ?? null);
    const locationEntityId =
      author.authorKind === 'location'
        ? author.authorId
        : (playerFrame?.current_location_id ?? null);

    // Witness scope: NPCs physically present in the location when this
    // narrate fires. Each NPC's preamble later filters chat_messages to
    // rows where they were author OR a witness, so they only "remember"
    // what was said in their presence.
    const witnessIds = await loadWitnessIdsForLocation(
      playerFrame?.current_location_id ?? null,
      await resolveWitnessCartridgeId(ctx.playerId),
    );

    const inserted = await insertChatMessageOrStop({
      sessionId: ctx.sessionId,
      authorId: author.authorId,
      tone,
      text,
      turnIndex,
      payload,
      playerId: ctx.playerId,
      locationEntityId,
      npcEntityId,
      witnessIds,
      turnId: ctx.turnId,
    });

    telemetry.record({
      channel: 'gameplay',
      name: 'turn.output',
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId ?? null,
      data: {
        message_id: inserted.messageId,
        turn_index: inserted.turnIndex,
        author_id: author.authorId,
        author_name: author.authorName,
        author_kind: author.authorKind,
        tone,
        mood: rawArgs.mood ?? null,
        location_entity_id: locationEntityId,
        npc_entity_id: npcEntityId,
        text,
        raw_text_changed: text !== rawArgs.text,
      },
    });

    // Scan the narrate text for exact canonical `@<display_name>` tokens.
    const mentions = scanMentions(text, mentionEntities);
    console.log(
      `[narrate] author=${author.authorName ?? '<auto>'} tone=${tone} mentions=${mentions
        .map((m) => '@' + m.name)
        .join(', ') || '(none)'} text="${text.slice(0, 120)}…"`,
    );

    const personMentions = mentions
      .filter((m) => m.kind === 'person' && m.id !== ctx.playerId)
      .map((m) => ({id: m.id, name: m.name}));
    const cleared = await maybeClearDialogueOnSceneShift({
      narrateTone: tone,
      authorKind: author.authorKind,
      playerFrame,
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      personMentions,
    });
    if (cleared) {
      emitDialogueParticipantsCleared({
        sessionId: ctx.sessionId,
        cleared,
      });
    }

    await emitNarrationStream({
      ctx,
      messageId: inserted.messageId,
      messageTurnIndex: inserted.turnIndex,
      authorName: author.authorName,
      authorId: author.authorId,
      tone,
      mood: rawArgs.mood ?? null,
      mentions,
      text,
    });

    persistAutoSnapshotMemory({
      authorKind: author.authorKind,
      authorId: author.authorId,
      playerId: ctx.playerId,
      turnId: ctx.turnId,
      text,
    });

    if (done) {
      // Hard-stop the agent loop. The turn runner watches for
      // ToolErrorType.STOP_EXECUTION on completed tool calls and exits
      // the inference cycle. Without this, the model keeps calling
      // narrate (or other tools) in a loop because nothing tells it to
      // stop.
      throw new StopExecution('narration done');
    }
    return {
      text,
      tone,
      done,
      author_id: author.authorId,
    };
  },
});

async function resolveWitnessCartridgeId(
  playerId: number,
): Promise<string | undefined> {
  try {
    return await resolveActivePlayerCartridgeId(playerId);
  } catch {
    return undefined;
  }
}
