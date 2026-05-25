/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Eager turn-context builder.
//
// Before each inference, we precompute the slice of cartridge state
// the model is overwhelmingly likely to need — current location +
// people / items / exits there, active quests with their recipes,
// player snapshot, and (if in a focused dialogue) the NPC's profile +
// recent exchange. This block is prepended to the user message so the
// model doesn't have to spend 4-6 tool round-trips just to find out
// where the player is and who's standing next to them.
//
// Tools STAY available — the model is encouraged to call
// `query_memory`, `query_entity` (for deep dives or entities not in
// the local scope), `search_entities`, and the mutation tools
// (`apply_runtime_field_patch`, `inventory_transfer`, `award_xp`,
// `move_player`, …) as before. Eager priming is the predictable 80%;
// tools cover the long tail.
//
// Cache-aware split (spec 06):
//   - `static` : per-scene-stable cartridge metadata. Stays byte-identical
//     across consecutive turns in the same scene → DeepSeek prefix-cache
//     hits the leading bytes.
//   - `dynamic`: per-turn mutating state (player HP/XP/inventory, active
//     quest phase, dialogue runtime + recent exchange). Always uncached.
//
// ARCH-11 — this facade used to live at `src/turnContext.ts` and the
// section-renderers under `src/turnContext/`, which is a TypeScript
// file/directory name collision. The facade now lives at
// `src/turnContext/index.ts`; consumers import from
// `turnContext/index.js`.

import { query } from '../db.js';
import { telemetry } from '../telemetry/index.js';
import {
  buildActorCorePacket,
  renderActorCorePacket,
} from '../actors/actorCorePacket.js';
import {
  loadCompanionIdsForPlayer,
  loadDialogueParticipantState,
} from '../dialogueParticipants.js';
import {
  buildContinuityPacket,
  renderContinuityPacket,
  buildLocationMemoryPacket,
  renderLocationMemoryPacket,
} from '../domain/memory/index.js';
import {
  renderEntityRuntime,
  renderEntitySectionStatic,
  renderWorldSection,
} from './entitySections.js';
import {
  renderDialogueParticipants,
  renderDialoguePartnerProfile,
  renderDialogueState,
} from './dialogueContext.js';
import {
  renderPlayerSnapshot,
  type PlayerSnapshot,
} from './playerContext.js';
import {
  renderActiveQuestsState,
  renderAvailableQuests,
} from './questContext.js';
import {
  renderActiveSurfaces,
  renderAtmosphere,
  renderNeighbours,
  renderWorldCatalogue,
  worldEntityIdForPlayer,
} from './worldLocationContext.js';
import {renderSceneInstructions} from './sceneInstructions.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';

export { describeObjective } from './questContext.js';
export { renderDialogueState } from './dialogueContext.js';

export interface BuildContextOptions {
  /** Soft cap on how many recent dialogue exchanges to include. */
  dialogueHistoryLimit?: number;
  /**
   * Optional pre-computed scene summary (3-5 bullet points covering
   * everything older than the verbatim tail). Prepended to the dynamic
   * block so the model still sees scene continuity without paying for
   * the whole transcript every turn.
   */
  sceneSummary?: string | null;
  /**
   * ISO 639 short code for the player's chosen language ('en', 'ru',
   * 'ja', 'zh', …). Used to resolve localized variants of cartridge
   * prose (summary, narrator_brief, stage text) via i18n.ts. Entity
   * display_name stays canonical because it is the runtime @mention key.
   */
  lang?: string;
  /**
   * Narrow runtime slice requested by the current runner/agent path.
   * Omitted keeps the legacy full preamble shape used by smoke tests and
   * debug endpoints.
   */
  scope?: TurnContextScope;
  /**
   * Exclude the in-flight player message from dialogue history. The runner
   * passes the same text separately after <turn_context>, so repeating it in
   * "Recent exchange" burns context without adding state.
   */
  excludeTurnId?: string | null;
  /**
   * Current turn id. Used by location-memory rendering to show first-entry
   * bubbles only on the actual entry turn.
   */
  turnId?: string | null;
}

export interface TurnContextParts {
  static: string;
  dynamic: string;
  stats: {
    static: TurnContextSectionBudget[];
    dynamic: TurnContextSectionBudget[];
  };
}

export interface TurnContextSectionBudget {
  name: string;
  chars: number;
}

export type TurnContextScope =
  | 'full'
  | 'scripted'
  | 'narration'
  | 'focused_dialogue'
  | 'exploration'
  | 'travel'
  | 'dialogue'
  | 'combat'
  | 'intimacy'
  | 'rest';

interface TurnContextSectionSet {
  world: boolean;
  scene: boolean;
  atmosphere: boolean;
  activeSurfaces: boolean;
  location: boolean;
  neighbours: boolean;
  worldCatalogue: boolean;
  availableQuests: boolean;
  dialogueProfile: boolean;
  sceneSummary: boolean;
  entityRuntime: boolean;
  activeQuests: boolean;
  player: boolean;
  dialogueState: boolean;
  dialogueParticipants: boolean;
}

const FULL_CONTEXT_SECTIONS: TurnContextSectionSet = {
  world: true,
  scene: true,
  atmosphere: true,
  activeSurfaces: true,
  location: true,
  neighbours: true,
  worldCatalogue: true,
  availableQuests: true,
  dialogueProfile: true,
  sceneSummary: true,
  entityRuntime: true,
  activeQuests: true,
  player: true,
  dialogueState: true,
  dialogueParticipants: true,
};

function contextSectionsFor(
  scope: TurnContextScope | undefined,
): TurnContextSectionSet {
  if (!scope || scope === 'full') return FULL_CONTEXT_SECTIONS;
  const localFrame = {
    world: true,
    scene: true,
    atmosphere: true,
    activeSurfaces: true,
    location: true,
    neighbours: true,
    worldCatalogue: false,
    availableQuests: false,
    dialogueProfile: false,
    sceneSummary: true,
    entityRuntime: true,
    activeQuests: true,
    player: true,
    dialogueState: false,
    dialogueParticipants: false,
  } satisfies TurnContextSectionSet;

  if (scope === 'scripted') {
    return {
      ...localFrame,
      sceneSummary: false,
      dialogueProfile: true,
      dialogueState: true,
      dialogueParticipants: true,
    };
  }

  if (scope === 'narration') {
    return {
      ...localFrame,
      dialogueProfile: true,
      dialogueState: true,
      dialogueParticipants: true,
    };
  }

  if (scope === 'focused_dialogue') {
    return {
      ...localFrame,
      world: false,
      atmosphere: false,
      dialogueProfile: true,
      dialogueState: true,
      dialogueParticipants: true,
    };
  }

  if (scope === 'dialogue') {
    return {
      ...localFrame,
      worldCatalogue: true,
      availableQuests: true,
      dialogueProfile: true,
      dialogueState: true,
      dialogueParticipants: true,
    };
  }

  if (scope === 'exploration') {
    return {
      ...localFrame,
      availableQuests: true,
    };
  }

  if (scope === 'combat') {
    return {
      ...localFrame,
      dialogueProfile: true,
      dialogueState: true,
      dialogueParticipants: true,
    };
  }

  if (scope === 'intimacy') {
    return {
      ...localFrame,
      dialogueProfile: true,
      dialogueState: true,
      dialogueParticipants: true,
    };
  }

  return localFrame;
}

const DEFAULT_DIALOGUE_HISTORY_LIMIT = 5;

export async function buildTurnContext(
  sessionId: string,
  playerId: number,
  opts: BuildContextOptions = {},
): Promise<TurnContextParts> {
  const limit = opts.dialogueHistoryLimit ?? DEFAULT_DIALOGUE_HISTORY_LIMIT;
  const lang = opts.lang ?? 'en';
  const sections = contextSectionsFor(opts.scope);

  const playerRows = await query<PlayerSnapshot & { display_name: string }>(
    `SELECT p.entity_id, e.display_name,
            p.current_xp, p.current_level, p.current_hp, p.max_hp,
            p.current_location_id, p.current_scene_id,
            p.dialogue_partner_id
       FROM players p JOIN entities e ON e.id = p.entity_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  if (playerRows.rows.length === 0) {
    return { static: '', dynamic: '', stats: { static: [], dynamic: [] } };
  }
  const player = playerRows.rows[0]!;
  const [dialogueParticipants, companionIds] = await Promise.all([
    loadDialogueParticipantState(playerId),
    loadCompanionIdsForPlayer(playerId),
  ]);
  const dialogueFocusId =
    player.dialogue_partner_id ?? dialogueParticipants.focused_partner_id;
  const dialogueParticipantIds = uniquePositiveIds([
    ...dialogueParticipants.participant_ids,
    ...companionIds,
  ]);

  // Override: if the player has an active dialogue partner, force the
  // dialogue sections on regardless of the scope the route classifier
  // picked. Without this an in-scene exchange (Mikka mid-offer) can be
  // misclassified as `exploration` and the broker preamble drops all
  // recent NPC narration / partner profile / dialogue state — the NPC
  // then appears to forget the conversation from one turn to the next.
  if (dialogueFocusId != null) {
    sections.dialogueProfile = true;
    sections.dialogueState = true;
    sections.dialogueParticipants = true;
  }
  if (dialogueParticipantIds.length > 0) {
    sections.dialogueParticipants = true;
  }

  // ---- STATIC: cartridge facts that don't change every turn. ------------
  const staticSections: string[] = [];
  // World entity comes FIRST so the model anchors every turn in the
  // cartridge's overall setting before zooming into local scene/NPC
  // detail. Pulled from cartridge_meta.world_entity_id; if a cartridge
  // doesn't define a world entity the section is silently skipped.
  const worldId = sections.world
    ? await worldEntityIdForPlayer(playerId)
    : null;
  if (worldId != null) {
    const block = await renderWorldSection(worldId, lang);
    if (block) staticSections.push(block);
  }
  if (sections.scene && player.current_scene_id != null) {
    staticSections.push(
      await renderEntitySectionStatic('SCENE', player.current_scene_id, lang),
    );
  }

  // Spec 32 — surface world atmospherics (time-of-day, weather) before
  // SCENE/LOCATION entity descriptions, so the narrator naturally
  // weaves "smoggy dusk light" into prose. The world clock ticks each
  // turn (transitionEngine.tickWorldClock).
  if (sections.atmosphere) {
    const block = await renderAtmosphere(playerId);
    if (block) staticSections.push(block);
  }
  // Spec 33 — surface broker-readable list of active environmental
  // surfaces in the player's current location. Driven by the
  // apply_surface tool; decay handled by decrementSurfaces. Empty
  // arrays are skipped so cache-friendly when nothing's burning.
  if (sections.activeSurfaces && player.current_location_id != null) {
    const block = await renderActiveSurfaces(player.current_location_id);
    if (block) staticSections.push(block);
  }
  if (sections.location && player.current_location_id != null) {
    staticSections.push(
      await renderEntitySectionStatic(
        'LOCATION',
        player.current_location_id,
        lang,
      ),
    );
  }
  if (sections.neighbours && player.current_location_id != null) {
    staticSections.push(
      await renderNeighbours(
        player.current_location_id,
        player.entity_id,
        lang,
      ),
    );
  }

  // Spec 38 follow-up — WORLD CATALOGUE. Compact list of every
  // cartridge-existing entity (locations, scenes, persons, items)
  // EXCEPT the ones already detailed in PEOPLE/ITEMS/EXITS for the
  // current location, plus any hidden_until_stage gated entities.
  // Lets the model reference existing entities by name when creating
  // a new quest (instead of spawning duplicates). Filters keep prompt
  // budget bounded.
  if (sections.worldCatalogue) {
    staticSections.push(
      await renderWorldCatalogue(
        player.current_location_id ?? null,
        lang,
        playerId,
      ),
    );
  }
  if (sections.availableQuests) {
    const availableBlock = await renderAvailableQuests(
      playerId,
      player.current_location_id,
      player.current_scene_id,
      lang,
    );
    if (availableBlock) staticSections.push(availableBlock);
  }
  if (sections.dialogueProfile && dialogueFocusId != null) {
    staticSections.push(
      await renderDialoguePartnerProfile(dialogueFocusId, lang),
    );
  }

  // OWV-17 scene-instruction bridge. Surfaces authored scene rows
  // for the current location plus any NPC-attached rows owned by
  // the focused dialogue partner or active participants. Missing
  // bridge meta is a no-op. Best-effort: any thrown error is logged
  // and swallowed so the rest of the preamble still renders.
  try {
    const cartridgeId = await resolveActivePlayerCartridgeId(playerId);
    const sceneBlock = await renderSceneInstructions({
      locationId: player.current_location_id ?? null,
      focusedNpcId: dialogueFocusId ?? null,
      participantIds: dialogueParticipantIds,
      cartridgeId,
    });
    if (sceneBlock) staticSections.push(sceneBlock);
  } catch (err) {
    telemetry.record({
      channel: 'gameplay',
      name: 'turn_context.scene_instructions.render_failed',
      sessionId,
      playerId,
      turnId: opts.turnId ?? null,
      error: err,
      data: {
        section: 'scene_instructions',
        locationId: player.current_location_id ?? null,
        focusedNpcId: dialogueFocusId ?? null,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }

  // ---- DYNAMIC: per-turn mutating state. -------------------------------
  const dynamicSections: string[] = [];
  if (sections.activeQuests || sections.dialogueState || sections.dialogueProfile) {
    try {
      const packet = await buildContinuityPacket({
        playerId,
        sessionId,
      });
      const rendered = renderContinuityPacket(packet);
      if (rendered) dynamicSections.push(rendered);
    } catch (err) {
      recordTurnContextPacketFailure({
        section: 'continuity',
        sessionId,
        playerId,
        turnId: opts.turnId ?? null,
        err,
      });
    }
  }
  if (sections.location && player.current_location_id != null) {
    try {
      const packet = await buildLocationMemoryPacket({
        playerId,
        locationId: player.current_location_id,
        lang,
        turnId: opts.turnId ?? null,
      });
      const rendered = renderLocationMemoryPacket(packet);
      if (rendered) dynamicSections.push(rendered);
    } catch (err) {
      recordTurnContextPacketFailure({
        section: 'location_memory',
        sessionId,
        playerId,
        turnId: opts.turnId ?? null,
        locationId: player.current_location_id,
        err,
      });
    }
  }
  if (
    sections.sceneSummary &&
    opts.sceneSummary &&
    opts.sceneSummary.trim().length > 0
  ) {
    dynamicSections.push(opts.sceneSummary.trim());
  }
  if (sections.entityRuntime && player.current_scene_id != null) {
    const r = await renderEntityRuntime(
      'SCENE',
      player.current_scene_id,
      playerId,
    );
    if (r) dynamicSections.push(r);
  }
  if (sections.entityRuntime && player.current_location_id != null) {
    const r = await renderEntityRuntime(
      'LOCATION',
      player.current_location_id,
      playerId,
    );
    if (r) dynamicSections.push(r);
  }
  if (sections.activeQuests) {
    const activeBlock = await renderActiveQuestsState(playerId, lang);
    if (activeBlock) dynamicSections.push(activeBlock);
  }
  if (sections.player) dynamicSections.push(await renderPlayerSnapshot(player));
  if (sections.dialogueState && dialogueFocusId != null) {
    try {
      const packet = await buildActorCorePacket({
        actorId: dialogueFocusId,
        playerId,
        roleInScene: 'focused_npc',
        focused: true,
      });
      if (packet) dynamicSections.push(renderActorCorePacket(packet));
    } catch (err) {
      recordTurnContextPacketFailure({
        section: 'actor_core',
        sessionId,
        playerId,
        turnId: opts.turnId ?? null,
        actorId: dialogueFocusId,
        err,
      });
    }
    dynamicSections.push(
      await renderDialogueState(
        dialogueFocusId,
        playerId,
        sessionId,
        limit,
        lang,
        opts.excludeTurnId ?? null,
      ),
    );
  }
  if (
    sections.dialogueParticipants &&
    dialogueParticipantIds.length > 0
  ) {
    const block = await renderDialogueParticipants(
      dialogueParticipantIds,
      dialogueFocusId,
      playerId,
      sessionId,
      limit,
      opts.excludeTurnId ?? null,
    );
    if (block) dynamicSections.push(block);
  }

  const staticText = staticSections
    .filter((s) => s.trim().length > 0)
    .join('\n\n');
  const dynamicText = dynamicSections
    .filter((s) => s.trim().length > 0)
    .join('\n\n');
  return {
    static: staticText,
    dynamic: dynamicText,
    stats: {
      static: sectionBudgetsFromText(staticText),
      dynamic: sectionBudgetsFromText(dynamicText),
    },
  };
}

function uniquePositiveIds(ids: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * X-3/X-4 follow-up — emit structured `gameplay` telemetry when a
 * dynamic-context packet build throws. Each section call is best-effort
 * and continues building the preamble without that section's text, but
 * operators need to see the failure with `sessionId` / `playerId` /
 * `turnId` / section name + any relevant entity id rather than just a
 * stderr warn line. The thrown error is forwarded verbatim through the
 * facade's `error` field.
 */
function recordTurnContextPacketFailure(args: {
  section: 'continuity' | 'location_memory' | 'actor_core';
  sessionId: string;
  playerId: number;
  turnId?: string | null;
  locationId?: number | null;
  actorId?: number | null;
  err: unknown;
}): void {
  telemetry.record({
    channel: 'gameplay',
    name: `turn_context.${args.section}.packet_failed`,
    sessionId: args.sessionId,
    playerId: args.playerId,
    turnId: args.turnId ?? null,
    error: args.err,
    data: {
      section: args.section,
      locationId: args.locationId ?? null,
      actorId: args.actorId ?? null,
      message: args.err instanceof Error ? args.err.message : String(args.err),
    },
  });
}

function sectionBudgetsFromText(text: string): TurnContextSectionBudget[] {
  if (!text.trim()) return [];
  return text
    .split(/\n(?=## )/g)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const header = chunk.split('\n', 1)[0] ?? 'section';
      return {
        name:
          header
            .replace(/^#+\s*/, '')
            .trim()
            .slice(0, 80) || 'section',
        chars: chunk.length,
      };
    });
}
