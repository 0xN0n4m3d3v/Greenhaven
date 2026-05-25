/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { query, type TxClient, withTransaction } from '../../../db.js';
import {activeCartridgeEntityPredicate} from '../../../cartridgeScope.js';
import {qualitySqlPredicate} from '../../../contentQuality.js';
import { emitGuiEventForSession } from '../../../guiEventOutbox.js';
import type { PresentationHandle } from '../../../presentationScheduler.js';
import { POST_TURN_SLOT_WATCHDOG_MS } from '../../../postTurnTiming.js';
import type { ToolHistoryEntry } from '../../../sessionManager.js';
import type { PostTurnHook, SpecialistContext } from '../../../agents/base.js';
import { selectWeighted, stableSeed } from './adventureRng.js';
import {
  ADVENTURE_TABLE_ID,
  eligibleAdventureEntries,
  toAdventureMode,
  type AdventureCandidate,
  type AdventureDanger,
  type AdventureKind,
  type AdventureMode,
  type AdventureRejection,
  type AdventureTableContext,
} from './adventureTables.js';

export type AdventureQueueStatus =
  | 'queued'
  | 'materializing'
  | 'ready'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'failed';

export type AdventureQueueSource =
  | 'oracle'
  | 'quest_pacer'
  | 'narrative_gap'
  | 'manual_debug';

export interface AdventureQueueRow {
  id: number;
  sessionId: string;
  playerId: number;
  turnId: string | null;
  status: AdventureQueueStatus;
  source: AdventureQueueSource;
  adventureKind: AdventureKind;
  priority: number;
  seed: string;
  sequence: number;
  tableId: string;
  rollResult: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
  blueprint: Record<string, unknown> | null;
  dedupeKey: string | null;
  availableAfterTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdventureOracleRollResult {
  tableId: string;
  seed: string;
  sequence: number;
  die: string;
  rawRoll: number;
  selectionRoll: number;
  totalWeight: number;
  selectedKind: AdventureKind;
  selected: AdventureCandidate;
  candidates: Array<
    AdventureCandidate & { rangeStart: number; rangeEnd: number }
  >;
  rejected: AdventureRejection[];
}

export interface AdventureEnqueueResult {
  queued: boolean;
  reused: boolean;
  reason?: string;
  row?: AdventureQueueRow;
  roll?: AdventureOracleRollResult;
}

export interface AdventureTurnSnapshot {
  text: string;
  actionId?: string | null;
  toolHistory: ToolHistoryEntry[];
  narrative: string;
  mode?: string;
  language?: string;
}

export interface MaybeEnqueueAdventureOptions {
  sessionId: string;
  playerId: number;
  turnId?: string | null;
  source?: AdventureQueueSource;
  mode?: AdventureMode | string | null;
  seed?: string;
  sequence?: number;
  priority?: number;
  visible?: boolean;
  language?: string | null;
  presentation?: PresentationHandle;
}

interface PlayerAdventureContext {
  playerLevel: number;
  currentLocationId: number | null;
  cartridgeId: string | null;
  activeQuestCount: number;
  cooldownKinds: Set<AdventureKind>;
  nearbyEntityIds: number[];
  nearbyEntitySignature: string;
}

const RECENT_COOLDOWN_LIMIT = 6;
const DEFAULT_READY_TTL_TURNS = 3;
const ORACLE_MIN_PLAYER_TURNS_BETWEEN_OPPORTUNITIES = 2;
const READ_ONLY_OPPORTUNITY_TOOLS = new Set([
  'get_recent_history',
  'narrate',
  'query_entity',
  'query_inventory',
  'query_memory',
  'query_world_state',
  'query_player_profile',
  'query_player_state',
]);

export function rollAdventureOracle(args: {
  seed: string;
  sequence: number;
  context: AdventureTableContext;
}): AdventureOracleRollResult {
  const { candidates, rejected } = eligibleAdventureEntries(args.context);
  const selection = selectWeighted({
    seed: args.seed,
    sequence: args.sequence,
    candidates,
  });
  return {
    tableId: ADVENTURE_TABLE_ID,
    seed: args.seed,
    sequence: args.sequence,
    die: selection.roll.die,
    rawRoll: selection.roll.raw,
    selectionRoll: selection.roll.roll,
    totalWeight: selection.totalWeight,
    selectedKind: selection.selected.kind,
    selected: selection.selected,
    candidates: selection.candidates,
    rejected,
  };
}

export async function maybeEnqueueAdventureOpportunity(
  opts: MaybeEnqueueAdventureOptions,
  turnSnapshot: AdventureTurnSnapshot,
): Promise<AdventureEnqueueResult> {
  const source = opts.source ?? 'oracle';
  // AQ-1 — the entire find-for-turn → throttle → context → sequence
  // → dedupe → INSERT chain runs inside a single transaction that
  // holds `SELECT id FROM sessions WHERE id=$1 FOR UPDATE` for the
  // duration. The JS mutex above serialises locally (and across
  // PGlite's single shared connection); the FOR UPDATE serialises
  // across managed Postgres backends. Together they guarantee that
  // 10 concurrent calls for the same (sessionId, playerId, turnId)
  // produce exactly one durable adventure_queue row and exactly one
  // adventure_oracle_rolls row, with one `reused:false` and the
  // rest `reused:true`. Visible emits happen inside the tx so the
  // deferred SSE never escapes if the INSERTs roll back; the
  // commit-hook path in `SseBridge.emit` preserves USER-6.
  return withAdventureEnqueueLock(opts.sessionId, opts.playerId, async () => {
    const decision = await withTransaction<AdventureEnqueueDecision>(
      async (tx) => {
        await lockSessionAdventureQueueTx(tx, opts.sessionId);
        if (opts.turnId) {
          const existingForTurn = await findAdventureForTurn(
            opts.sessionId,
            opts.playerId,
            opts.turnId,
            tx,
          );
          if (existingForTurn) {
            return { kind: 'reused_for_turn', row: existingForTurn };
          }
        }
        if (source === 'oracle') {
          const throttle = await shouldThrottleOracleOpportunity(
            opts.sessionId,
            opts.playerId,
            tx,
          );
          if (throttle.throttled) {
            return {
              kind: 'oracle_throttled',
              playerTurnsSinceLast: throttle.playerTurnsSinceLast,
            };
          }
        }
        const loaded = await loadPlayerAdventureContext(
          opts.sessionId,
          opts.playerId,
          tx,
        );
        const mode = toAdventureMode(
          String(opts.mode ?? turnSnapshot.mode ?? 'exploration'),
        );
        const context: AdventureTableContext = {
          playerLevel: loaded.playerLevel,
          currentLocationId: loaded.currentLocationId,
          mode,
          activeQuestCount: loaded.activeQuestCount,
          recentCombat: isRecentCombat(turnSnapshot.toolHistory),
          recentDanger: recentDangerFromTurn(turnSnapshot.toolHistory),
          cooldownKinds: loaded.cooldownKinds,
        };
        let sequence: number;
        if (opts.sequence != null) {
          sequence = opts.sequence;
          await advanceAdventureSequenceAtLeast(
            opts.sessionId,
            opts.playerId,
            sequence,
            tx,
          );
        } else {
          sequence = await nextAdventureSequence(
            opts.sessionId,
            opts.playerId,
            tx,
          );
        }
        const seed =
          opts.seed ??
          stableSeed([
            'greenhaven-adventure',
            ADVENTURE_TABLE_ID,
            opts.sessionId,
            opts.playerId,
            opts.turnId ?? 'manual',
            sequence,
            loaded.currentLocationId,
            mode,
          ]);
        const roll = rollAdventureOracle({ seed, sequence, context });
        const dedupeKey = buildDedupeKey({
          source,
          turnId: opts.turnId ?? null,
          seed,
          tableId: roll.tableId,
          kind: roll.selectedKind,
          currentLocationId: loaded.currentLocationId,
          mode,
        });
        const existing = await findAdventureByDedupe(
          opts.sessionId,
          opts.playerId,
          dedupeKey,
          tx,
        );
        if (existing) {
          return { kind: 'reused_dedupe', row: existing, roll };
        }

        const contextSnapshot = {
          playerLevel: context.playerLevel,
          currentLocationId: context.currentLocationId,
          cartridgeId: loaded.cartridgeId,
          mode: context.mode,
          activeQuestCount: context.activeQuestCount,
          recentCombat: context.recentCombat,
          recentDanger: context.recentDanger,
          cooldownKinds: [...context.cooldownKinds],
          language: opts.language ?? turnSnapshot.language ?? null,
          nearbyEntityIds: loaded.nearbyEntityIds,
          nearbyEntitySignature: loaded.nearbyEntitySignature,
          turnTextPreview: turnSnapshot.text.slice(0, 240),
          narrativePreview: turnSnapshot.narrative.slice(0, 500),
        };
        const rollPayload = {
          tableId: roll.tableId,
          seed: roll.seed,
          sequence: roll.sequence,
          die: roll.die,
          rawRoll: roll.rawRoll,
          selectionRoll: roll.selectionRoll,
          totalWeight: roll.totalWeight,
          selectedKind: roll.selectedKind,
          selected: roll.selected,
          candidates: roll.candidates,
          rejected: roll.rejected,
        };
        const inserted = await tx.query<AdventureQueueDbRow>(
          `INSERT INTO adventure_queue
             (session_id, player_id, turn_id, status, source, adventure_kind,
              priority, seed, sequence, table_id, roll_result, context_snapshot,
              dedupe_key, available_after_turn_id)
           VALUES ($1, $2, $3, 'queued', $4, $5,
                   $6, $7, $8, $9, $10::jsonb, $11::jsonb,
                   $12, $13)
           ON CONFLICT (session_id, player_id, dedupe_key) WHERE dedupe_key IS NOT NULL
           DO UPDATE SET updated_at = adventure_queue.updated_at
           RETURNING ${ADVENTURE_QUEUE_COLUMNS}`,
          [
            opts.sessionId,
            opts.playerId,
            opts.turnId ?? null,
            source,
            roll.selectedKind,
            opts.priority ?? 50,
            seed,
            sequence,
            roll.tableId,
            JSON.stringify(rollPayload),
            JSON.stringify(contextSnapshot),
            dedupeKey,
            opts.turnId ?? null,
          ],
        );
        const insertedRow = mapAdventureQueueRow(inserted.rows[0]!);

        await tx.query(
          `INSERT INTO adventure_oracle_rolls
             (adventure_queue_id, session_id, player_id, turn_id, seed,
              sequence, die, raw_roll, table_id, candidates, selected_kind)
           VALUES ($1, $2, $3, $4, $5,
                   $6, $7, $8, $9, $10::jsonb, $11)`,
          [
            insertedRow.id,
            opts.sessionId,
            opts.playerId,
            opts.turnId ?? null,
            seed,
            sequence,
            roll.die,
            roll.rawRoll,
            roll.tableId,
            JSON.stringify(roll.candidates),
            roll.selectedKind,
          ],
        );

        if (opts.visible) {
          await emitAdventureOracleRolled(insertedRow, roll, opts.presentation);
          return { kind: 'inserted_visible', row: insertedRow, roll };
        }
        return { kind: 'inserted_silent', row: insertedRow, roll };
      },
    );

    switch (decision.kind) {
      case 'reused_for_turn':
        await opts.presentation?.skip('already_queued_for_turn');
        return { queued: true, reused: true, row: decision.row };
      case 'oracle_throttled':
        await opts.presentation?.skip(
          `oracle_global_cooldown:${decision.playerTurnsSinceLast}`,
        );
        return {
          queued: false,
          reused: false,
          reason: 'oracle_global_cooldown',
        };
      case 'reused_dedupe':
        await opts.presentation?.skip('dedupe_reused');
        return {
          queued: true,
          reused: true,
          row: decision.row,
          roll: decision.roll,
        };
      case 'inserted_silent':
        await opts.presentation?.skip('queued_silently');
        return {
          queued: true,
          reused: false,
          row: decision.row,
          roll: decision.roll,
        };
      case 'inserted_visible':
        return {
          queued: true,
          reused: false,
          row: decision.row,
          roll: decision.roll,
        };
    }
  });
}

type AdventureEnqueueDecision =
  | { kind: 'reused_for_turn'; row: AdventureQueueRow }
  | { kind: 'oracle_throttled'; playerTurnsSinceLast: number }
  | {
      kind: 'reused_dedupe';
      row: AdventureQueueRow;
      roll: AdventureOracleRollResult;
    }
  | {
      kind: 'inserted_visible';
      row: AdventureQueueRow;
      roll: AdventureOracleRollResult;
    }
  | {
      kind: 'inserted_silent';
      row: AdventureQueueRow;
      roll: AdventureOracleRollResult;
    };

export const adventureOracleHook: PostTurnHook = {
  name: 'adventure_oracle',
  presentation: {
    slotKey: 'post.adventure_oracle',
    lane: 'post_response',
    ordinal: 35,
    visible: true,
    barrierMode: 'chat_visible',
    deadlineMs: POST_TURN_SLOT_WATCHDOG_MS,
  },
  async run(ctx: SpecialistContext, turnRecord: AdventureTurnSnapshot) {
    try {
      const intent = classifyAdventurePostTurnIntent(turnRecord);
      const openPressure = await loadOpenAdventurePressure(
        ctx.sessionId,
        ctx.playerId,
      );
      if (openPressure.busy) {
        await ctx.presentation?.skip(
          `player_already_busy:quests=${openPressure.activeQuestCount};adventures=${openPressure.openAdventureCount};scene=${openPressure.activeSceneId ?? 'none'}`,
        );
        return;
      }
      const playerSeekingPlay = intent !== 'ambient_oracle';
      await maybeEnqueueAdventureOpportunity(
        {
          sessionId: ctx.sessionId,
          playerId: ctx.playerId,
          turnId: ctx.turnId,
          source: playerSeekingPlay ? 'narrative_gap' : 'oracle',
          mode: turnRecord.mode,
          language: ctx.language ?? turnRecord.language ?? null,
          visible: true,
          priority: playerSeekingPlay ? 90 : 50,
          presentation: ctx.presentation,
        },
        turnRecord,
      );
    } catch (err) {
      await ctx.presentation?.fail(err, true);
      // CATCH-WARN-OK: paired telemetry recorded on the line above through `ctx.presentation.fail(err, true)`; `presentationScheduler.complete('failed', errorMessage(err), true)` writes both the slot-status row and a `telemetry.record({channel:'performance', name:post_turn.${slot.hookName}})` event, so the operator already sees the failure even though this warn is the only console hint.
      console.warn(
        '[agent:adventure_oracle] failed (continuing):',
        err instanceof Error ? err.message : err,
      );
    }
  },
};

export type AdventurePostTurnIntent = 'ambient_oracle' | 'player_seeking_play';

export function classifyAdventurePostTurnIntent(
  turnRecord: AdventureTurnSnapshot,
): AdventurePostTurnIntent {
  if (isExistingAdventureAction(turnRecord.actionId)) return 'ambient_oracle';
  const mode = String(turnRecord.mode ?? 'exploration');
  if (mode !== 'exploration') return 'ambient_oracle';
  const passive =
    turnRecord.toolHistory.length > 0 &&
    turnRecord.toolHistory.every((entry) =>
      READ_ONLY_OPPORTUNITY_TOOLS.has(entry.name),
    );
  return passive ? 'player_seeking_play' : 'ambient_oracle';
}

function isExistingAdventureAction(actionId?: string | null): boolean {
  // LANGUAGE-REGEX-OK: wire-format actionId matcher for the UI-emitted `adventure.accept` / `adventure.ignore` affordance family (with optional `:<queueId>` segment). Literal protocol token, never read player prose; same wire format as the per-action parsers in `adventureIntent.ts`.
  return /^adventure\.(?:accept|ignore)(?::\d+)?$/.test(actionId ?? '');
}

async function loadOpenAdventurePressure(
  sessionId: string,
  playerId: number,
): Promise<{
  activeQuestCount: number;
  openAdventureCount: number;
  activeSceneId: number | null;
  busy: boolean;
}> {
  const [questRows, adventureRows, playerRows] = await Promise.all([
    query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
         FROM player_quests
        WHERE player_id = $1
          AND status = 'active'`,
      [playerId],
    ),
    query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
         FROM adventure_queue
        WHERE session_id = $1
          AND player_id = $2
        AND status IN ('queued', 'materializing', 'ready')`,
      [sessionId, playerId],
    ),
    query<{ current_scene_id: number | string | null }>(
      `SELECT current_scene_id FROM players WHERE entity_id = $1`,
      [playerId],
    ),
  ]);
  const activeQuestCount = Number(questRows.rows[0]?.count ?? 0);
  const openAdventureCount = Number(adventureRows.rows[0]?.count ?? 0);
  const rawSceneId = playerRows.rows[0]?.current_scene_id;
  const activeSceneId =
    rawSceneId == null
      ? null
      : Number.isInteger(Number(rawSceneId)) && Number(rawSceneId) > 0
        ? Number(rawSceneId)
        : null;
  return {
    activeQuestCount,
    openAdventureCount,
    activeSceneId,
    busy:
      activeQuestCount > 0 ||
      openAdventureCount > 0 ||
      activeSceneId != null,
  };
}

export async function listAdventureQueue(opts: {
  sessionId: string;
  playerId?: number;
  statuses?: AdventureQueueStatus[];
  limit?: number;
}): Promise<AdventureQueueRow[]> {
  const params: unknown[] = [opts.sessionId];
  let where = `WHERE session_id = $1`;
  if (opts.playerId != null) {
    params.push(opts.playerId);
    where += ` AND player_id = $${params.length}`;
  }
  if (opts.statuses && opts.statuses.length > 0) {
    params.push(opts.statuses);
    where += ` AND status = ANY($${params.length}::text[])`;
  }
  params.push(sanitizeAdventureQueueLimit(opts.limit));
  const rows = await query<AdventureQueueDbRow>(
    `SELECT ${ADVENTURE_QUEUE_COLUMNS}
       FROM adventure_queue
       ${where}
      ORDER BY priority DESC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapAdventureQueueRow);
}

function sanitizeAdventureQueueLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(Math.trunc(limit), 200));
}

export async function getAdventureQueueRow(
  queueId: number,
): Promise<AdventureQueueRow | null> {
  const rows = await query<AdventureQueueDbRow>(
    `SELECT ${ADVENTURE_QUEUE_COLUMNS}
       FROM adventure_queue
      WHERE id = $1
      LIMIT 1`,
    [queueId],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

// AQ-1 — per (session, player) in-process mutex for
// `maybeEnqueueAdventureOpportunity`. Two concurrent post-turn hooks
// (or two API calls) for the same player/session must not race the
// findForTurn → throttle → context → sequence → dedupe → INSERT chain.
// On managed Postgres the SELECT ... FOR UPDATE on sessions(id)
// serialises us; on PGlite (single shared connection across the
// process) a JS-level mutex is the only safe way to keep transaction
// isolation. Keeping the mutex on both backends makes the contract
// identical and reduces unique-index contention noise on pg.
const adventureEnqueueMutex = new Map<string, Promise<unknown>>();

function adventureEnqueueMutexKey(
  sessionId: string,
  playerId: number,
): string {
  return `${sessionId}:${playerId}`;
}

async function withAdventureEnqueueLock<T>(
  sessionId: string,
  playerId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = adventureEnqueueMutexKey(sessionId, playerId);
  const prev = adventureEnqueueMutex.get(key) ?? Promise.resolve();
  const next: Promise<T> = prev.catch(() => undefined).then(fn);
  adventureEnqueueMutex.set(key, next);
  try {
    return await next;
  } finally {
    if (adventureEnqueueMutex.get(key) === next) {
      adventureEnqueueMutex.delete(key);
    }
  }
}

async function lockSessionAdventureQueueTx(
  tx: TxClient,
  sessionId: string,
): Promise<void> {
  // FOR UPDATE on sessions(id) serialises concurrent enqueue
  // transactions for the same session on managed Postgres. The row
  // is never mutated; the lock is released by COMMIT/ROLLBACK.
  await tx.query(`SELECT id FROM sessions WHERE id = $1 FOR UPDATE`, [
    sessionId,
  ]);
}

type AdventureQueueClient = {query: typeof query};

async function shouldThrottleOracleOpportunity(
  sessionId: string,
  playerId: number,
  client: AdventureQueueClient = {query},
): Promise<{ throttled: boolean; playerTurnsSinceLast: number }> {
  const last = await client.query<{ id: number; created_at: string }>(
    `SELECT id, created_at
       FROM adventure_queue
      WHERE session_id = $1
        AND player_id = $2
        AND source = 'oracle'
        AND status NOT IN ('cancelled', 'expired')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [sessionId, playerId],
  );
  const lastRow = last.rows[0];
  if (!lastRow) return { throttled: false, playerTurnsSinceLast: 999 };

  const turns = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM chat_messages
      WHERE session_id = $1
        AND author_entity_id = $2
        AND created_at > $3::timestamptz`,
    [sessionId, playerId, lastRow.created_at],
  );
  const playerTurnsSinceLast = turns.rows[0]?.count ?? 0;
  return {
    throttled:
      playerTurnsSinceLast < ORACLE_MIN_PLAYER_TURNS_BETWEEN_OPPORTUNITIES,
    playerTurnsSinceLast,
  };
}

export async function claimNextQueuedAdventure(opts: {
  sessionId: string;
  playerId?: number;
  turnId?: string | null;
}): Promise<AdventureQueueRow | null> {
  const params: unknown[] = [opts.sessionId];
  let playerFilter = '';
  if (opts.playerId != null) {
    params.push(opts.playerId);
    playerFilter = `AND player_id = $${params.length}`;
  }
  let turnFilter = '';
  if (opts.turnId != null) {
    params.push(opts.turnId);
    turnFilter = `AND turn_id = $${params.length}`;
  }
  const rows = await query<AdventureQueueDbRow>(
    `UPDATE adventure_queue
        SET status = 'materializing',
            updated_at = now()
      WHERE id = (
        SELECT id
          FROM adventure_queue
         WHERE session_id = $1
           ${playerFilter}
           ${turnFilter}
           AND status = 'queued'
         ORDER BY priority DESC, id ASC
         LIMIT 1
      )
      RETURNING ${ADVENTURE_QUEUE_COLUMNS}`,
    params,
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

export async function markAdventureReady(
  queueId: number,
  blueprint: Record<string, unknown>,
): Promise<AdventureQueueRow | null> {
  const rows = await query<AdventureQueueDbRow>(
    `UPDATE adventure_queue
        SET status = 'ready',
            blueprint = $2::jsonb,
            updated_at = now()
      WHERE id = $1
        AND status IN ('queued', 'materializing')
      RETURNING ${ADVENTURE_QUEUE_COLUMNS}`,
    [queueId, JSON.stringify(blueprint)],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

export async function claimReadyAdventureForAcceptance(
  queueId: number,
): Promise<AdventureQueueRow | null> {
  const rows = await query<AdventureQueueDbRow>(
    `UPDATE adventure_queue
        SET status = 'materializing',
            updated_at = now()
      WHERE id = $1
        AND status = 'ready'
        AND blueprint IS NOT NULL
      RETURNING ${ADVENTURE_QUEUE_COLUMNS}`,
    [queueId],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

export async function markAdventureRejected(
  queueId: number,
  reason: string,
  details: Record<string, unknown> = {},
): Promise<AdventureQueueRow | null> {
  const rows = await query<AdventureQueueDbRow>(
    `UPDATE adventure_queue
        SET status = 'rejected',
            context_snapshot = COALESCE(context_snapshot, '{}'::jsonb)
              || jsonb_build_object('materializer_rejection', $2::jsonb),
            updated_at = now()
      WHERE id = $1
        AND status IN ('queued', 'materializing')
      RETURNING ${ADVENTURE_QUEUE_COLUMNS}`,
    [queueId, JSON.stringify({ reason, ...details })],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

export async function markAdventureFailed(
  queueId: number,
  reason: string,
  details: Record<string, unknown> = {},
): Promise<AdventureQueueRow | null> {
  const rows = await query<AdventureQueueDbRow>(
    `UPDATE adventure_queue
        SET status = 'failed',
            context_snapshot = COALESCE(context_snapshot, '{}'::jsonb)
              || jsonb_build_object('materializer_failure', $2::jsonb),
            updated_at = now()
      WHERE id = $1
        AND status IN ('queued', 'materializing')
      RETURNING ${ADVENTURE_QUEUE_COLUMNS}`,
    [queueId, JSON.stringify({ reason, ...details })],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

export async function recoverAbandonedMaterializingAdventures(
  opts: {
    sessionId?: string;
    playerId?: number;
    olderThanMs?: number;
    reason?: string;
  } = {},
): Promise<number> {
  const olderThanMs = Math.max(1, Math.floor(opts.olderThanMs ?? 120_000));
  const params: unknown[] = [olderThanMs];
  const where = [
    `status = 'materializing'`,
    `updated_at < now() - ($1::int || ' milliseconds')::interval`,
  ];
  if (opts.sessionId) {
    params.push(opts.sessionId);
    where.push(`session_id = $${params.length}`);
  }
  if (opts.playerId != null) {
    params.push(opts.playerId);
    where.push(`player_id = $${params.length}`);
  }
  params.push(
    JSON.stringify({
      reason: opts.reason ?? 'adventure materializer abandoned',
      recovered_at: new Date().toISOString(),
      older_than_ms: olderThanMs,
    }),
  );
  const recoveryParam = params.length;
  const rows = await query<{ id: number }>(
    `UPDATE adventure_queue
        SET status = CASE WHEN blueprint IS NULL THEN 'queued' ELSE 'ready' END,
            context_snapshot = COALESCE(context_snapshot, '{}'::jsonb)
              || jsonb_build_object('materializer_recovered', $${recoveryParam}::jsonb),
            updated_at = now()
      WHERE ${where.join(' AND ')}
      RETURNING id`,
    params,
  );
  return rows.rowCount;
}

export async function markAdventureAccepted(
  queueId: number,
): Promise<AdventureQueueRow | null> {
  const rows = await query<AdventureQueueDbRow>(
    `UPDATE adventure_queue
        SET status = 'accepted',
            updated_at = now()
      WHERE id = $1
        AND status IN ('ready', 'materializing')
        AND blueprint IS NOT NULL
      RETURNING ${ADVENTURE_QUEUE_COLUMNS}`,
    [queueId],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

export async function markAdventureCancelled(
  queueId: number,
  reason: string,
  details: Record<string, unknown> = {},
): Promise<AdventureQueueRow | null> {
  const rows = await query<AdventureQueueDbRow>(
    `UPDATE adventure_queue
        SET status = 'cancelled',
            context_snapshot = COALESCE(context_snapshot, '{}'::jsonb)
              || jsonb_build_object('cancelled', $2::jsonb),
            updated_at = now()
      WHERE id = $1
        AND status IN ('queued', 'materializing', 'ready')
      RETURNING ${ADVENTURE_QUEUE_COLUMNS}`,
    [queueId, JSON.stringify({ reason, ...details })],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

export async function markAdventureExpired(
  queueId: number,
  reason: string,
  details: Record<string, unknown> = {},
): Promise<AdventureQueueRow | null> {
  const rows = await query<AdventureQueueDbRow>(
    `UPDATE adventure_queue
        SET status = 'expired',
            context_snapshot = COALESCE(context_snapshot, '{}'::jsonb)
              || jsonb_build_object('expired', $2::jsonb),
            updated_at = now()
      WHERE id = $1
        AND status = 'ready'
      RETURNING ${ADVENTURE_QUEUE_COLUMNS}`,
    [queueId, JSON.stringify({ reason, ...details })],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

export async function expireStaleReadyAdventures(opts: {
  sessionId: string;
  playerId: number;
  turnId?: string | null;
  defaultTtlTurns?: number;
}): Promise<AdventureQueueRow[]> {
  const readyRows = await listAdventureQueue({
    sessionId: opts.sessionId,
    playerId: opts.playerId,
    statuses: ['ready'],
    limit: 25,
  });
  const expired: AdventureQueueRow[] = [];
  for (const row of readyRows) {
    const ttl = readAdventureTtlTurns(row, opts.defaultTtlTurns);
    if (ttl <= 0) continue;
    const elapsedTurns = await countPlayerTurnsSinceAdventure(row);
    if (elapsedTurns < ttl) continue;
    // The visibility check is a read, safe outside the tx. We
    // compute it first so the tx body is just `mark + (optional)
    // emit`.
    const hookWasVisible = await wasAdventureHookVisible(
      row.sessionId,
      row.id,
    );
    // USER-5/USER-6 — `markAdventureExpired` UPDATE and the visible
    // `adventure:expired` GUI event share one transaction per row.
    // If the emit fails the UPDATE rolls back and the deferred SSE
    // never escapes. SSE auto-defers via `SseBridge.emit`'s
    // `onTransactionCommit` path.
    let finalRow: AdventureQueueRow | null = null;
    try {
      finalRow = await withTransaction(async () => {
        const updated = await markAdventureExpired(row.id, 'ttl_elapsed', {
          ttlTurns: ttl,
          elapsedTurns,
          checkedTurnId: opts.turnId ?? null,
        });
        if (!updated) return null;
        if (hookWasVisible) {
          await emitAdventureExpired(updated, {
            reason: 'ttl_elapsed',
            ttlTurns: ttl,
            elapsedTurns,
          });
        }
        return updated;
      });
    } catch (err) {
      // CATCH-WARN-OK: per-row best-effort TTL cleanup inside `expireStaleReadyAdventures`. The outer loop tolerates per-row failures so a single broken queue row cannot block the rest of the sweep; the wrapping `markAdventureExpired` UPDATE is the canonical state-mutation owner and surfaces SQL errors through writer-side telemetry. The next call into this sweep will retry the row.
      console.warn(
        '[adventure] expire row failed (continuing):',
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (!finalRow) continue;
    expired.push(finalRow);
  }
  return expired;
}

export async function buildAdventureHookPayload(
  row: AdventureQueueRow,
): Promise<Record<string, unknown> | null> {
  const blueprint = row.blueprint;
  if (!blueprint) return null;
  const title = String(blueprint['title'] ?? row.adventureKind);
  const summary = String(blueprint['summary'] ?? '');
  const playerFacingHook = String(
    blueprint['playerFacingHook'] ?? summary ?? title,
  );
  const suggestedQuest =
    blueprint['suggestedQuest'] &&
    typeof blueprint['suggestedQuest'] === 'object' &&
    !Array.isArray(blueprint['suggestedQuest'])
      ? (blueprint['suggestedQuest'] as Record<string, unknown>)
      : null;
  const rewards =
    suggestedQuest && typeof suggestedQuest['rewards'] === 'object'
      ? suggestedQuest['rewards']
      : null;
  const speaker = await resolveAdventureSpeaker(blueprint);
  return {
    queueId: row.id,
    playerId: row.playerId,
    adventureKind: row.adventureKind,
    title,
    summary,
    playerFacingHook,
    danger: blueprint['danger'] ?? 'safe',
    rewardHint: rewards,
    speakerEntityId: speaker?.id ?? null,
    speakerName: speaker?.name ?? null,
    status: row.status,
    source: row.source,
    sequence: row.sequence,
    seed: row.seed,
    acceptUrl: `/api/player/${row.playerId}/adventures/${row.id}/accept`,
    ignoreUrl: `/api/player/${row.playerId}/adventures/${row.id}/ignore`,
  };
}

function readPositiveEntityId(input: unknown): number | null {
  return typeof input === 'number' && Number.isInteger(input) && input > 0
    ? input
    : null;
}

async function resolveAdventureSpeaker(
  blueprint: Record<string, unknown>,
): Promise<{ id: number; name: string } | null> {
  const suggestedQuest =
    blueprint['suggestedQuest'] &&
    typeof blueprint['suggestedQuest'] === 'object' &&
    !Array.isArray(blueprint['suggestedQuest'])
      ? (blueprint['suggestedQuest'] as Record<string, unknown>)
      : null;
  const entityId = readPositiveEntityId(
    suggestedQuest?.['giverEntityId'] ?? suggestedQuest?.['sourceEntityId'],
  );
  if (entityId == null) return null;
  const entity = await query<{
    id: number | string;
    kind: string;
    display_name: string;
  }>(
    `SELECT id, kind, display_name
       FROM entities
      WHERE id = $1`,
    [entityId],
  );
  const row = entity.rows[0];
  if (!row || row.kind !== 'person') return null;
  return { id: Number(row.id), name: row.display_name };
}

export async function emitAdventureHook(
  row: AdventureQueueRow,
  presentation: PresentationHandle | undefined,
): Promise<void> {
  const payload = await buildAdventureHookPayload(row);
  if (!payload) {
    await presentation?.skip('ready_adventure_missing_blueprint');
    return;
  }
  const opts = {
    playerId: row.playerId,
    turnId: row.turnId,
    lane: 'post_response' as const,
    phase: 'post_turn' as const,
    dedupeKey: `adventure-hook:${row.id}`,
  };
  if (presentation) {
    await presentation.emit('adventure:hook', payload, opts);
    return;
  }
  await emitGuiEventForSession(row.sessionId, 'adventure:hook', payload, opts);
}

async function emitAdventureOracleRolled(
  row: AdventureQueueRow,
  roll: AdventureOracleRollResult,
  presentation: PresentationHandle | undefined,
): Promise<void> {
  const payload = {
    queueId: row.id,
    adventureKind: row.adventureKind,
    tableId: row.tableId,
    seed: row.seed,
    sequence: row.sequence,
    roll: roll.selectionRoll,
    die: roll.die,
    totalWeight: roll.totalWeight,
    source: row.source,
    status: row.status,
  };
  const opts = {
    playerId: row.playerId,
    turnId: row.turnId,
    lane: 'post_response' as const,
    phase: 'post_turn' as const,
    dedupeKey: `adventure-oracle-rolled:${row.id}`,
  };
  if (presentation) {
    await presentation.emit('adventure:oracle_rolled', payload, opts);
    return;
  }
  await emitGuiEventForSession(
    row.sessionId,
    'adventure:oracle_rolled',
    payload,
    opts,
  );
}

async function emitAdventureExpired(
  row: AdventureQueueRow,
  details: Record<string, unknown>,
): Promise<void> {
  await emitGuiEventForSession(
    row.sessionId,
    'adventure:expired',
    {
      queueId: row.id,
      playerId: row.playerId,
      adventureKind: row.adventureKind,
      status: 'expired',
      title: String(row.blueprint?.['title'] ?? row.adventureKind),
      summary: String(row.blueprint?.['summary'] ?? ''),
      ...details,
    },
    {
      playerId: row.playerId,
      turnId: row.turnId,
      lane: 'post_response',
      phase: 'post_turn',
      dedupeKey: `adventure-expired:${row.id}`,
    },
  );
}

async function wasAdventureHookVisible(
  sessionId: string,
  queueId: number,
): Promise<boolean> {
  const rows = await query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM gui_events
      WHERE session_id = $1
        AND event_type = 'adventure:hook'
        AND payload->>'queueId' = $2`,
    [sessionId, String(queueId)],
  );
  return Number(rows.rows[0]?.count ?? 0) > 0;
}

function readAdventureTtlTurns(
  row: AdventureQueueRow,
  fallback: number | undefined,
): number {
  const fromBlueprint = Number(row.blueprint?.['expiresAfterTurns']);
  if (Number.isFinite(fromBlueprint) && fromBlueprint >= 0) {
    return Math.trunc(fromBlueprint);
  }
  const fromContext = Number(row.contextSnapshot['expiresAfterTurns']);
  if (Number.isFinite(fromContext) && fromContext >= 0) {
    return Math.trunc(fromContext);
  }
  return Math.max(1, Math.trunc(fallback ?? DEFAULT_READY_TTL_TURNS));
}

async function countPlayerTurnsSinceAdventure(
  row: AdventureQueueRow,
): Promise<number> {
  if (row.turnId) {
    const counted = await query<{ count: number | string }>(
      `WITH base AS (
         SELECT COALESCE(MAX(turn_index), 0) AS base_turn
           FROM chat_messages
          WHERE session_id = $1
            AND payload->>'turn_id' = $2
       )
       SELECT COUNT(*)::int AS count
         FROM chat_messages cm, base
        WHERE cm.session_id = $1
          AND cm.player_id = $3
          AND cm.tone = 'player'
          AND cm.turn_index > base.base_turn`,
      [row.sessionId, row.turnId, row.playerId],
    );
    return Number(counted.rows[0]?.count ?? 0);
  }
  const counted = await query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM chat_messages cm
      WHERE cm.session_id = $1
        AND cm.player_id = $2
        AND cm.tone = 'player'
        AND cm.created_at > $3::timestamptz`,
    [row.sessionId, row.playerId, row.createdAt],
  );
  return Number(counted.rows[0]?.count ?? 0);
}

async function loadPlayerAdventureContext(
  sessionId: string,
  playerId: number,
  client: AdventureQueueClient = {query},
): Promise<PlayerAdventureContext> {
  const player = await client.query<{
    current_level: number | string | null;
    current_location_id: number | string | null;
  }>(
    `SELECT current_level, current_location_id
       FROM players
      WHERE entity_id = $1`,
    [playerId],
  );
  const currentLocationId =
    player.rows[0]?.current_location_id == null
      ? null
      : Number(player.rows[0]?.current_location_id);
  const cartridgeId = await resolveAdventureCartridgeId(playerId, client);
  const nearby =
    currentLocationId == null
      ? { rows: [] as Array<{ id: number | string }> }
      : await client.query<{ id: number | string }>(
          `SELECT id
           FROM entities
          WHERE (
               id = $1
            OR profile->>'home_id' = $1::text
            OR profile->>'current_location_id' = $1::text
            OR profile->>'location_id' = $1::text
          )
            ${
              cartridgeId != null
                ? `AND ${activeCartridgeEntityPredicate('entities', '$3')}`
                : ''
            }
            AND ${qualitySqlPredicate('entities')}
            AND NOT (
              kind = 'person'
              AND EXISTS (
                SELECT 1 FROM actor_statuses s
                 WHERE s.player_id = $2
                   AND s.actor_entity_id = entities.id
                   AND s.intensity > 0
                   AND s.status_kind IN ('dead', 'missing')
              )
            )
          ORDER BY id
          LIMIT 32`,
          cartridgeId != null
            ? [currentLocationId, playerId, cartridgeId]
            : [currentLocationId, playerId],
        );
  const nearbyEntityIds = nearby.rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const nearbyEntitySignature = nearbyEntityIds.join(',');
  const activeQuests = await client.query<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM player_quests
      WHERE player_id = $1
        AND status = 'active'`,
    [playerId],
  );
  const recent = await client.query<{ adventure_kind: AdventureKind }>(
    `SELECT adventure_kind
       FROM adventure_queue
      WHERE session_id = $1
        AND player_id = $2
        AND status IN ('queued', 'materializing', 'ready', 'accepted')
      ORDER BY id DESC
      LIMIT $3`,
    [sessionId, playerId, RECENT_COOLDOWN_LIMIT],
  );
  const recentNearby = nearbyEntitySignature
    ? await client.query<{ adventure_kind: AdventureKind }>(
        `SELECT adventure_kind
           FROM adventure_queue
          WHERE session_id = $1
            AND player_id = $2
            AND status IN ('queued', 'materializing', 'ready', 'accepted')
            AND context_snapshot->>'nearbyEntitySignature' = $3
          ORDER BY id DESC
          LIMIT $4`,
        [sessionId, playerId, nearbyEntitySignature, RECENT_COOLDOWN_LIMIT * 2],
      )
    : { rows: [] as Array<{ adventure_kind: AdventureKind }> };
  const cooldownKinds = new Set<AdventureKind>();
  for (const row of recent.rows) cooldownKinds.add(row.adventure_kind);
  for (const row of recentNearby.rows) cooldownKinds.add(row.adventure_kind);
  return {
    playerLevel: Number(player.rows[0]?.current_level ?? 1),
    currentLocationId,
    cartridgeId,
    activeQuestCount: Number(activeQuests.rows[0]?.count ?? 0),
    cooldownKinds,
    nearbyEntityIds,
    nearbyEntitySignature,
  };
}

async function resolveAdventureCartridgeId(
  playerId: number,
  client: AdventureQueueClient,
): Promise<string | null> {
  const active = await client.query<{cartridge_id: string | null}>(
    `SELECT cartridge_id
       FROM hero_cartridge_states
      WHERE player_id = $1
        AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [playerId],
  );
  const activeId = active.rows[0]?.cartridge_id;
  if (typeof activeId === 'string' && activeId.length > 0) return activeId;

  const legacy = await client.query<{cartridge_id: string | null}>(
    `SELECT CASE
              WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}'
              ELSE NULL
            END AS cartridge_id
       FROM cartridge_meta
      WHERE key = 'cartridge_id'
      LIMIT 1`,
    [],
  );
  const legacyId = legacy.rows[0]?.cartridge_id;
  return typeof legacyId === 'string' && legacyId.length > 0
    ? legacyId
    : null;
}

// AQ-2 — per-(session_id, player_id) atomic sequence allocator.
// The migration `0114_adventure_queue_counters.sql` owns the
// counter table and backfills `last_sequence` from any pre-AQ-2
// adventure_queue rows. The upsert below is the only writer that
// advances the counter for automatic allocations; explicit-sequence
// fixtures use `advanceAdventureSequenceAtLeast` to lift the
// counter past the fixture value so the next automatic call still
// returns a strictly higher number.
export async function nextAdventureSequence(
  sessionId: string,
  playerId: number,
  client: AdventureQueueClient = {query},
): Promise<number> {
  const rows = await client.query<{ last_sequence: number | string }>(
    `INSERT INTO adventure_queue_counters (session_id, player_id, last_sequence)
     VALUES ($1, $2, 1)
     ON CONFLICT (session_id, player_id)
     DO UPDATE SET last_sequence = adventure_queue_counters.last_sequence + 1
     RETURNING last_sequence`,
    [sessionId, playerId],
  );
  return Number(rows.rows[0]!.last_sequence);
}

export async function advanceAdventureSequenceAtLeast(
  sessionId: string,
  playerId: number,
  sequence: number,
  client: AdventureQueueClient = {query},
): Promise<void> {
  await client.query(
    `INSERT INTO adventure_queue_counters (session_id, player_id, last_sequence)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id, player_id)
     DO UPDATE SET last_sequence = GREATEST(
       adventure_queue_counters.last_sequence,
       EXCLUDED.last_sequence
     )`,
    [sessionId, playerId, sequence],
  );
}

async function findAdventureForTurn(
  sessionId: string,
  playerId: number,
  turnId: string,
  client: AdventureQueueClient = {query},
): Promise<AdventureQueueRow | null> {
  const rows = await client.query<AdventureQueueDbRow>(
    `SELECT ${ADVENTURE_QUEUE_COLUMNS}
       FROM adventure_queue
      WHERE session_id = $1
        AND player_id = $2
        AND turn_id = $3
      ORDER BY id ASC
      LIMIT 1`,
    [sessionId, playerId, turnId],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

async function findAdventureByDedupe(
  sessionId: string,
  playerId: number,
  dedupeKey: string,
  client: AdventureQueueClient = {query},
): Promise<AdventureQueueRow | null> {
  const rows = await client.query<AdventureQueueDbRow>(
    `SELECT ${ADVENTURE_QUEUE_COLUMNS}
       FROM adventure_queue
      WHERE session_id = $1
        AND player_id = $2
        AND dedupe_key = $3
      LIMIT 1`,
    [sessionId, playerId, dedupeKey],
  );
  return rows.rows[0] ? mapAdventureQueueRow(rows.rows[0]) : null;
}

function buildDedupeKey(opts: {
  source: AdventureQueueSource;
  turnId: string | null;
  seed: string;
  tableId: string;
  kind: AdventureKind;
  currentLocationId: number | null;
  mode: AdventureMode;
}): string {
  return [
    opts.source,
    opts.tableId,
    opts.turnId ?? opts.seed,
    opts.kind,
    opts.currentLocationId ?? 'none',
    opts.mode,
  ].join(':');
}

function isRecentCombat(toolHistory: ToolHistoryEntry[]): boolean {
  return toolHistory.some((entry) => {
    if (entry.name === 'damage' || entry.name === 'mark_downed') return true;
    if (entry.name !== 'dice_check') return false;
    const category = entry.args['category'];
    return category === 'combat';
  });
}

function recentDangerFromTurn(
  toolHistory: ToolHistoryEntry[],
): AdventureDanger | null {
  if (
    toolHistory.some(
      (entry) => entry.name === 'damage' || entry.name === 'mark_downed',
    )
  ) {
    return 'deadly';
  }
  if (
    toolHistory.some(
      (entry) => entry.name === 'apply_surface' || entry.name === 'death_save',
    )
  ) {
    return 'risky';
  }
  return null;
}

const ADVENTURE_QUEUE_COLUMNS = `
  id, session_id, player_id, turn_id, status, source, adventure_kind,
  priority, seed, sequence, table_id, roll_result, context_snapshot,
  blueprint, dedupe_key, available_after_turn_id,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

interface AdventureQueueDbRow {
  id: number | string;
  session_id: string;
  player_id: number | string;
  turn_id: string | null;
  status: AdventureQueueStatus;
  source: AdventureQueueSource;
  adventure_kind: AdventureKind;
  priority: number | string;
  seed: string;
  sequence: number | string;
  table_id: string;
  roll_result: Record<string, unknown> | null;
  context_snapshot: Record<string, unknown> | null;
  blueprint: Record<string, unknown> | null;
  dedupe_key: string | null;
  available_after_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapAdventureQueueRow(row: AdventureQueueDbRow): AdventureQueueRow {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    playerId: Number(row.player_id),
    turnId: row.turn_id,
    status: row.status,
    source: row.source,
    adventureKind: row.adventure_kind,
    priority: Number(row.priority),
    seed: row.seed,
    sequence: Number(row.sequence),
    tableId: row.table_id,
    rollResult: row.roll_result ?? {},
    contextSnapshot: row.context_snapshot ?? {},
    blueprint: row.blueprint ?? null,
    dedupeKey: row.dedupe_key,
    availableAfterTurnId: row.available_after_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
