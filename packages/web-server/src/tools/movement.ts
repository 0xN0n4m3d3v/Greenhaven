/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 46 §5.1 — move_player tool.
//
// Mutates players.current_location_id. Required arg `intent_source`
// declares WHY the player is moving:
//
//   - 'user_command'      — player explicitly chose (UI button or
//                           typed "go to X" / "иду в X")
//   - 'follow_player'     — reserved internal sentinel for direct
//                           companion-follow moves; the common path uses
//                           roster presence plus npc:moved_with_player cards
//   - 'specialist_forced' — Combat Director / Quest Watcher /
//                           scripted action declared a forced move
//                           (combat spill, quest stage relocation,
//                           etc.)
//
// Movement Warden (postTurn hook) cross-checks: if narrate text
// describes the player at a location !== current_location_id AND
// no move_player call fired this turn, the Warden flags it as a
// possible narrator teleportation and emits a warning SSE.
//
// Notes:
//   - greenhaven.md §Tools (line ~57) already lists `move_player`
//     as a documented mutation tool. This file fills in the
//     previously-missing implementation. The prompt rules stay
//     unchanged.

import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import {
  clearDialogueParticipants,
  loadCompanionIdsForPlayer,
  loadDialogueParticipantState,
  setDialogueParticipants,
} from '../dialogueParticipants.js';
import { emitGuiEvent } from '../guiEventOutbox.js';
import { telemetry } from '../telemetry/index.js';
import { sessionManager } from '../sessionManager.js';
import { recordLocationVisit } from '../domain/memory/index.js';
import {
  entityBelongsToCartridge,
  pickActiveCartridgeLocationAnchor,
  resolveActivePlayerCartridgeContext,
} from '../services/CartridgePlaythroughService.js';
import { registerTool } from './base.js';
import {applyMaterializersForTrigger} from './materializer.js';
import {emitEntityMediaScript} from '../services/CartridgeMediaScriptService.js';

const MovePlayerArgs = z.object({
  /** Target place entity id. Must be kind='location' or kind='district'. */
  target_location_id: z.number().int().positive(),
  /**
   * Why this move is happening. Required so Warden can audit:
   *   - user_command: player explicitly chose
   *   - follow_player: reserved internal companion-follow sentinel
   *   - specialist_forced: specialist agent forced relocation
   */
  intent_source: z.enum(['user_command', 'follow_player', 'specialist_forced']),
  /** Optional human-readable why string (carried through SSE). */
  reason: z.string().max(240).optional(),
});

registerTool({
  name: 'move_player',
  description:
    'Move the player to a new location or district. ' +
    'Updates players.current_location_id and emits player:moved SSE. ' +
    "Required arg intent_source: 'user_command' (player explicitly chose, e.g. clicked an exit or typed 'go to X'), 'follow_player' (reserved internal companion-follow sentinel), or 'specialist_forced' (Combat Director / Quest Watcher declaring a forced relocation). " +
    'Movement Warden audits per-turn: if narrate prose describes the player at a different location without this tool firing, a warning is emitted.',
  paramsSchema: MovePlayerArgs,
  async execute(args, ctx) {
    // Validate target exists and is a playable place entity.
    const targetRow = await query<{
      id: number;
      display_name: string;
      kind: string;
      profile: unknown;
    }>(`SELECT id, display_name, kind, profile FROM entities WHERE id = $1`, [
      args.target_location_id,
    ]);
    const target = targetRow.rows[0];
    if (!target) {
      throw new Error(`unknown target_location_id: ${args.target_location_id}`);
    }
    if (target.kind !== 'location' && target.kind !== 'district') {
      throw new Error(
        `target is not a location or district (kind=${target.kind}, id=${args.target_location_id})`,
      );
    }

    // FEAT-CART-LIB-8 (2026-05-17) — refuse cross-cartridge travel
    // before any state-mutating write happens. We use the
    // player-scoped resolver so the gate keys off
    // `hero_cartridge_states.active` first; the global
    // `cartridge_meta` mirror is only a fallback. The predicate
    // matches `activeCartridgeEntityPredicate` exactly
    // (cartridge_id match, dynamic_origin runtime spawn, or
    // kind='player'), so the gate never blocks the legitimate
    // dynamic-spawn / player-entity allowances.
    const cartridgeCtx = await resolveActivePlayerCartridgeContext(
      ctx.playerId,
    );
    const targetInCartridge = await entityBelongsToCartridge(
      args.target_location_id,
      cartridgeCtx.cartridgeId,
    );
    if (!targetInCartridge) {
      throw new Error(
        `move_player rejected: target location ${args.target_location_id} does not belong to the active cartridge (${cartridgeCtx.cartridgeId})`,
      );
    }

    // Wrap the player position read + UPDATE in a transaction
    // with FOR UPDATE to prevent TOCTOU race under concurrent
    // move_player calls for the same player (GH-BUG-086).
    const { fromId, fromName } = await withTransaction(async client => {
      const beforeRow = await client.query<{ current_location_id: number | null }>(
        `SELECT current_location_id FROM players WHERE entity_id = $1 FOR UPDATE`,
        [ctx.playerId],
      );
      const fid = beforeRow.rows[0]?.current_location_id ?? null;

      // FEAT-CART-LIB-9 (2026-05-17) — when the player row carries a
      // foreign id, recover the same-cartridge anchor through the
      // same priority chain `loadLocationsView` uses
      // (`pickActiveCartridgeLocationAnchor`). Previous behavior
      // (FEAT-CART-LIB-8) zeroed `safeFromId` to `null`, but
      // `validateMovementReachability(null, ...)` returns ok
      // unconditionally, which let a stale row teleport the hero
      // to any same-cartridge target. The recovered anchor is
      // also the value surfaced as `fromId/fromName` to the
      // player-facing SSE/GUI events so the foreign location's
      // name never leaks.
      const picked = await pickActiveCartridgeLocationAnchor({
        cartridgeId: cartridgeCtx.cartridgeId,
        playerCurrentLocationId: fid,
        playthroughCurrentLocationId: cartridgeCtx.playthroughLocationId,
      });
      // When there is an active playthrough we MUST have a
      // same-cartridge anchor to validate from — otherwise the
      // null-anchor reachability bypass kicks back in. Reject
      // deterministically so a stale row cannot turn into a
      // null-anchor teleport.
      if (
        cartridgeCtx.hasActivePlaythrough &&
        picked.locationId == null
      ) {
        throw new Error(
          `move_player rejected: no valid same-cartridge anchor for player ${ctx.playerId} in cartridge ${cartridgeCtx.cartridgeId} (player_current_location_id=${fid ?? 'null'} is foreign and the active playthrough / scoped starting location did not yield a recoverable anchor)`,
        );
      }
      // No active playthrough → preserve legacy no-anchor
      // behavior (first-spawn / specialist seed paths). The
      // FEAT-CART-LIB-8 target gate above already blocked
      // cross-cartridge targets, so this only relaxes the
      // `fromId` side.
      const recoveredFromId = picked.locationId ?? fid;
      const safeFromId = picked.locationId;

      let fname: string | null = null;
      if (recoveredFromId != null) {
        const fr = await query<{ display_name: string }>(
          `SELECT display_name FROM entities WHERE id = $1`,
          [recoveredFromId],
        );
        fname = fr.rows[0]?.display_name ?? null;
      }

      // No-op: hero is already at the target after recovery. This
      // intentionally compares against the recovered anchor (not
      // the raw player row) so a stale foreign row pointing at the
      // target id does not trip the no-op shortcut.
      if (recoveredFromId === args.target_location_id) {
        return {
          fromId: recoveredFromId,
          fromName: fname,
          isNoop: true as const,
        };
      }

      const reachability = await validateMovementReachability(
        safeFromId,
        args.target_location_id,
        target.profile,
      );
      if (!reachability.ok) {
        throw new Error(reachability.reason);
      }

      await client.query(
        `UPDATE players SET current_location_id = $1 WHERE entity_id = $2`,
        [args.target_location_id, ctx.playerId],
      );
      // FEAT-CART-LIB-8 — sync the active playthrough row in the
      // same transaction so `hero_cartridge_states` stays the
      // canonical record of "where this hero is in this
      // cartridge". `current_scene_id` is reset because movement
      // ends any prior scene anchor; a fresh scene anchor will be
      // set on the next narrate that explicitly opens one.
      if (cartridgeCtx.hasActivePlaythrough) {
        await client.query(
          `UPDATE hero_cartridge_states
              SET current_location_id = $1,
                  current_scene_id = NULL,
                  updated_at = now()
            WHERE player_id = $2
              AND cartridge_id = $3
              AND status = 'active'`,
          [args.target_location_id, ctx.playerId, cartridgeCtx.cartridgeId],
        );
      }
      return {
        fromId: recoveredFromId,
        fromName: fname,
        isNoop: false as const,
      };
    });

    // Noop path handled outside transaction (no DB writes needed)
    if (fromId === args.target_location_id) {
      // SSE-OK: emit outside tx (reason: noop move banner; the
      // location-equality short-circuit means no DB row was
      // written by this tool call).
      sessionManager.get(ctx.sessionId)?.sse.emit('player:moved', {
        fromId,
        fromName,
        toId: args.target_location_id,
        toName: target.display_name,
        intent_source: args.intent_source,
        reason: args.reason ?? null,
        noop: true,
      });
      telemetry.record({
        channel: 'gameplay',
        name: 'player.move.noop',
        sessionId: ctx.sessionId,
        playerId: ctx.playerId,
        turnId: ctx.turnId ?? null,
        data: {
          from_id: fromId,
          from_name: fromName,
          to_id: args.target_location_id,
          to_name: target.display_name,
          intent_source: args.intent_source,
          reason: args.reason ?? null,
        },
      });
      return {
        moved: false,
        fromId,
        toId: args.target_location_id,
        toName: target.display_name,
        noop: true,
      };
    }

    const visit = await recordLocationVisit({
      playerId: ctx.playerId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      locationId: args.target_location_id,
      previousLocationId: fromId,
    }).catch((err) => {
      // CATCH-WARN-OK: visit recording is best-effort observability; the move_player tool has already committed and `recordLocationVisit` surfaces its own SQL failures through writer-side telemetry.
      console.warn(
        '[move_player] location visit record failed (continuing):',
        err instanceof Error ? err.message : err,
      );
      return null;
    });

    const [dialogueBeforeMove, companionIds] = await Promise.all([
      loadDialogueParticipantState(ctx.playerId),
      loadCompanionIdsForPlayer(ctx.playerId),
    ]);
    const focusedPartnerId = dialogueBeforeMove.focused_partner_id;
    const focusedPartnerIsCompanion =
      focusedPartnerId != null && companionIds.includes(focusedPartnerId);
    const dialogueUpdate = focusedPartnerIsCompanion
      ? await setDialogueParticipants(ctx.playerId, {
          focusedId: focusedPartnerId,
          participantIds: companionIds,
          explicitParticipantIds: companionIds,
          preserveExisting: false,
          sessionId: ctx.sessionId,
          source: 'tool',
          turnId: ctx.turnId,
        })
      : await clearDialogueParticipants(ctx.playerId, {
          source: 'tool',
          turnId: ctx.turnId,
        });
    if (dialogueUpdate.changed) {
      if (dialogueUpdate.state.focused_partner_id == null) {
        await emitGuiEvent(ctx, 'dialogue:partner_switched', {
          partner_id: null,
          reason: 'player_moved',
          fromId,
          fromName,
          toId: args.target_location_id,
          toName: target.display_name,
        });
      }
      // SSE-OK: emit outside tx (reason: setDialogueParticipants/
      // clearDialogueParticipants above are the canonical writes;
      // SseBridge.emit auto-defers via onTransactionCommit when
      // nested in withTransaction).
      sessionManager
        .get(ctx.sessionId)
        ?.sse.emit('dialogue:participants_updated', {
          focused_partner_id: dialogueUpdate.state.focused_partner_id,
          participant_ids: dialogueUpdate.state.participant_ids,
          participants: dialogueUpdate.participants,
          source: dialogueUpdate.state.source,
        });
    }

    const sessionForMove = sessionManager.get(ctx.sessionId);
    if (sessionForMove) {
      // SSE-OK: emit outside tx (reason: the players.current_
      // location_id UPDATE inside withTransaction above already
      // committed; SseBridge.emit auto-defers via
      // onTransactionCommit when nested in withTransaction).
      sessionForMove.sse.emit('player:moved', {
        fromId,
        fromName,
        toId: args.target_location_id,
        toName: visit?.locationName ?? target.display_name,
        intent_source: args.intent_source,
        reason: args.reason ?? null,
        noop: false,
        firstVisit: visit?.firstVisit ?? false,
        introBubble: visit?.introBubble ?? null,
      });
      console.log(
        `[move_player] SSE player:moved emitted from=${fromId}/${fromName ?? '?'} ` +
          `→ to=${args.target_location_id}/${visit?.locationName ?? target.display_name} ` +
          `firstVisit=${visit?.firstVisit ?? false}`,
      );
    } else {
      console.warn(
        `[move_player] no SSE session for sessionId=${ctx.sessionId}; ` +
          `player:moved not delivered (DB updated to ${args.target_location_id})`,
      );
    }
    telemetry.record({
      channel: 'gameplay',
      name: 'player.move',
      sessionId: ctx.sessionId,
      playerId: ctx.playerId,
      turnId: ctx.turnId ?? null,
      data: {
        from_id: fromId,
        from_name: fromName,
        to_id: args.target_location_id,
        to_name: visit?.locationName ?? target.display_name,
        intent_source: args.intent_source,
        reason: args.reason ?? null,
        first_visit: visit?.firstVisit ?? false,
        visit_count: visit?.visitCount ?? null,
        intro_bubble: visit?.introBubble ?? null,
      },
    });
    if (visit?.firstVisit && visit.introBubble) {
      await emitGuiEvent(ctx, 'location:first_entry', {
        locationId: args.target_location_id,
        locationName: visit.locationName,
        firstVisit: visit.firstVisit,
        visitCount: visit.visitCount,
        introBubble: visit.introBubble,
        locationImageUrl: readLocationVisualAssetUrl(asRecord(target.profile)),
      });
    }
    await emitEntityMediaScript(ctx, args.target_location_id, 'location').catch(
      (err) => {
        console.warn(
          '[move_player] location media script failed (continuing):',
          err instanceof Error ? err.message : err,
        );
      },
    );

    const targetSourceSlug = readText(asRecord(target.profile)['source_slug']);
    if (targetSourceSlug) {
      await applyMaterializersForTrigger(ctx, 'location_explore', {
        sourceSlug: targetSourceSlug,
      });
    }

    // Spec 52 — auto-follow companion NPCs. We only auto-follow on
    // user_command and specialist_forced moves (NOT follow_player —
    // that would cause infinite recursion if the engine ever issues
    // such moves directly). The companion roster is read from
    // players.metadata.companions; each follower gets one
    // npc:moved_with_player SSE so the frontend renders an
    // [Спутник идёт с тобой] event card.
    if (args.intent_source !== 'follow_player') {
      if (companionIds.length > 0) {
        const names = await query<{ id: number; display_name: string }>(
          `SELECT id, display_name FROM entities WHERE id = ANY($1::bigint[])`,
          [companionIds],
        );
        for (const npc of names.rows) {
          await emitGuiEvent(ctx, 'npc:moved_with_player', {
            npcId: npc.id,
            npcName: npc.display_name,
            fromId,
            fromName,
            toId: args.target_location_id,
            toName: target.display_name,
          });
        }
      }
    }

    return {
      moved: true,
      fromId,
      fromName,
      toId: args.target_location_id,
      toName: target.display_name,
      firstVisit: visit?.firstVisit ?? false,
      introBubble: visit?.introBubble ?? null,
    };
  },
});

async function validateMovementReachability(
  fromId: number | null,
  targetId: number,
  targetProfile: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (fromId == null) return { ok: true };
  const target = asRecord(targetProfile);
  if (readText(target['hidden_until_stage'])) {
    return {
      ok: false,
      reason: `move_player rejected: target location ${targetId} is still hidden and has not been revealed by quest/stage state`,
    };
  }

  const currentRow = await query<{ profile: unknown; display_name: string }>(
    `SELECT profile, display_name FROM entities WHERE id = $1`,
    [fromId],
  );
  const current = asRecord(currentRow.rows[0]?.profile);
  const currentExits = readIdArray(current['exits']);
  if (currentExits.has(targetId)) return { ok: true };
  if (readPositiveId(target['topology_parent_id']) === fromId)
    return { ok: true };
  if (readPositiveId(current['topology_parent_id']) === targetId)
    return { ok: true };
  if (readPositiveId(target['home_id']) === fromId) return { ok: true };
  if (readPositiveId(current['home_id']) === targetId) return { ok: true };

  return {
    ok: false,
    reason: `move_player rejected: target location ${targetId} is not an exit, child, parent, or nested place of current location ${fromId}`,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readPositiveId(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readLocationVisualAssetUrl(
  profile: Record<string, unknown> | null | undefined,
): string | null {
  const raw = profile?.['visual_asset_urls'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)['location_view'];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readIdArray(value: unknown): Set<number> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .map(readExitId)
      .filter((item) => Number.isInteger(item) && item > 0),
  );
}

function readExitId(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Number((value as Record<string, unknown>)['id']);
  }
  return Number(value);
}
