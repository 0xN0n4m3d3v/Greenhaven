/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Spec 92 deterministic finalization guards. These deliberately use
// structured tool history, not natural-language matching.

import { config } from '../config.js';
import { sessionManager, type ToolHistoryEntry } from '../sessionManager.js';
import { query } from '../db.js';
import type {PreToolValidator, ToolContext} from '../tools/base.js';
import {registerPreToolValidatorSpecialist} from '../specialists/registry.js';

const DEFAULT_MUTATION_BUDGET = 5;

const CANON_AFTER_PAYMENT_TOOLS = new Set([
  'add_memory',
  'bump_memory_salience',
  'start_quest',
  'advance_quest',
  'complete_quest',
  'set_runtime_field',
  'apply_runtime_field_patch',
  'award_xp',
  'change_stat',
  'unlock_skill',
  'award_progression_xp',
  'award_title',
  'equip_title',
  'spend_stat_point',
  'spend_skill_point',
  'award_inspiration',
  'spend_inspiration',
  'string_award',
  'string_spend',
]);

const MUTATION_TOOLS = new Set([
  ...CANON_AFTER_PAYMENT_TOOLS,
  'batch_mutate_world',
  'inventory_transfer',
  'use_item',
  'equip_item',
  'give_to_npc',
  'create_entity',
  'update_entity',
  'create_quest',
  'move_player',
  'damage',
  'heal',
  'mark_downed',
  'death_save',
  'stabilize',
  'apply_surface',
  'apply_intimacy_trigger',
  'set_companion',
  'switch_dialogue_partner',
]);

const WORLD_FACT_PREREQ_TOOLS = new Set([
  'inventory_transfer',
  'use_item',
  'equip_item',
  'give_to_npc',
  'create_entity',
  'update_entity',
  'create_quest',
  'move_player',
  'damage',
  'heal',
  'mark_downed',
  'death_save',
  'stabilize',
  'apply_surface',
  'apply_intimacy_trigger',
  'set_companion',
  'switch_dialogue_partner',
]);

const validator: PreToolValidator = async (toolName, args, ctx) => {
  if (ctx.operationId) return { ok: true };
  if (!MUTATION_TOOLS.has(toolName)) return { ok: true };

  const sceneTradePaymentVerdict = await sceneTradeSalePaymentDirectionVerdict(
    toolName,
    args,
    ctx,
  );
  if (!sceneTradePaymentVerdict.ok) return sceneTradePaymentVerdict;

  const paymentVerdict = paymentCanonVerdict(toolName, args, ctx);
  if (!paymentVerdict.ok) return paymentVerdict;

  const worldFactVerdict = worldFactCanonVerdict(toolName, args, ctx);
  if (!worldFactVerdict.ok) return worldFactVerdict;

  const budgetVerdict = mutationBudgetVerdict(toolName, args, ctx);
  if (!budgetVerdict.ok) return budgetVerdict;

  return { ok: true };
};

interface TransferIntent {
  item: string;
  currency: boolean;
  fromNull: boolean;
  fromPlayer: boolean;
  fromName: string | null;
  toPlayer: boolean;
  toName: string | null;
}

async function sceneTradeSalePaymentDirectionVerdict(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
): Promise<
  | { ok: true }
  | { ok: false; reason: string; suggestion: Record<string, unknown> }
> {
  if (toolName !== 'inventory_transfer' && toolName !== 'batch_mutate_world') {
    return Promise.resolve({ ok: true });
  }
  const active = activeTurn(ctx);
  if (active?.brokerToolProfile !== 'scene_trade') {
    return Promise.resolve({ ok: true });
  }

  const currentTransfers =
    toolName === 'batch_mutate_world'
      ? await readBatchTransferIntents(args)
      : [await readTransferIntent(args)].filter(
          (transfer): transfer is TransferIntent => transfer != null,
        );
  if (currentTransfers.length === 0) return { ok: true };

  const history = activeHistory(ctx) ?? [];
  const priorTransfers = (
    await Promise.all(
      history
        .filter((entry) => entry.ok && entry.name === 'inventory_transfer')
        .map((entry) => readTransferIntent(entry.args)),
    )
  ).filter((transfer): transfer is TransferIntent => transfer != null);

  const allTransfers = [...priorTransfers, ...currentTransfers];
  const unprovenBuyerFunds = allTransfers.find(
    (transfer) =>
      transfer.fromNull &&
      !transfer.toPlayer &&
      transfer.toName != null &&
      transfer.currency,
  );
  if (unprovenBuyerFunds) {
    return {
      ok: false,
      reason:
        `scene_trade_buyer_funds_guard: ${unprovenBuyerFunds.item} is minted ` +
        `to ${unprovenBuyerFunds.toName} inside a sale before paying the player; ` +
        'buyer funds must be proven before a completed sale',
      suggestion: {
        guard: 'scene_trade_buyer_funds_guard',
        blocked_tool: toolName,
        buyer: unprovenBuyerFunds.toName,
        unproven_funding: unprovenBuyerFunds,
        retry:
          'Do not grant currency to the buyer during scene_trade. If buyer funds are not proven by context or query_inventory, keep the item with the player and narrate a counteroffer, service debt, or refusal.',
      },
    };
  }

  const playerItemRecipients = new Set(
    allTransfers
      .filter(
        (transfer) =>
          transfer.fromPlayer &&
          !transfer.toPlayer &&
          transfer.toName != null &&
          !transfer.currency,
      )
      .map((transfer) => transfer.toName!),
  );
  const wrongPayment = allTransfers.find(
    (transfer) =>
      transfer.fromPlayer &&
      !transfer.toPlayer &&
      transfer.toName != null &&
      transfer.currency &&
      playerItemRecipients.has(transfer.toName),
  );
  if (!wrongPayment) return { ok: true };

  return {
    ok: false,
    reason:
      `scene_trade_payment_direction_guard: player is selling an item, but ` +
      `${wrongPayment.item} moves from the player to ${wrongPayment.toName}; ` +
      'buyer payment must move from buyer to player',
    suggestion: {
      guard: 'scene_trade_payment_direction_guard',
      blocked_tool: toolName,
      buyer: wrongPayment.toName,
      wrong_payment: wrongPayment,
      retry:
        'For scene_trade sales, use inventory_transfer(from=<buyer>, to_player_id=<active player>, item="Gold Coin", count=N). If the player is paying the NPC instead, do not also hand the sale item to that NPC as a completed sale.',
    },
  };
}

function paymentCanonVerdict(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
):
  | { ok: true }
  | { ok: false; reason: string; suggestion: Record<string, unknown> } {
  const unresolved = unresolvedFailedTransfer(ctx);
  if (!unresolved) return { ok: true };

  if (toolName === 'batch_mutate_world') {
    const operations = readBatchOperations(args);
    const firstCanon = operations.findIndex((op) =>
      CANON_AFTER_PAYMENT_TOOLS.has(op.tool),
    );
    if (firstCanon < 0) return { ok: true };
    const firstTransfer = operations.findIndex(
      (op) => op.tool === 'inventory_transfer',
    );
    if (firstTransfer >= 0 && firstTransfer < firstCanon) return { ok: true };
    return paymentReject(
      toolName,
      unresolved,
      'batch must retry inventory_transfer before canon-writing operations',
    );
  }

  if (CANON_AFTER_PAYMENT_TOOLS.has(toolName)) {
    return paymentReject(
      toolName,
      unresolved,
      'same-turn failed inventory_transfer is unresolved',
    );
  }

  return { ok: true };
}

function paymentReject(
  toolName: string,
  failed: ToolHistoryEntry,
  reason: string,
): { ok: false; reason: string; suggestion: Record<string, unknown> } {
  return {
    ok: false,
    reason: `payment_canon_guard: ${reason}`,
    suggestion: {
      guard: 'payment_canon_guard',
      blocked_tool: toolName,
      failed_tool: failed.name,
      failed_args: failed.args,
      failed_error: failed.error ?? null,
      retry:
        'Retry the required inventory_transfer first, preferably inside batch_mutate_world before any quest, memory, reward, string, or runtime-field canon writes. If transfer cannot succeed, narrate the failed payment and do not commit payment canon.',
    },
  };
}

function worldFactCanonVerdict(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
):
  | { ok: true }
  | { ok: false; reason: string; suggestion: Record<string, unknown> } {
  const unresolved = unresolvedFailedWorldFact(ctx);
  if (!unresolved) return { ok: true };

  if (toolName === 'batch_mutate_world') {
    const operations = readBatchOperations(args);
    const firstCanon = operations.findIndex((op) =>
      CANON_AFTER_PAYMENT_TOOLS.has(op.tool),
    );
    if (firstCanon < 0) return { ok: true };
    const firstRetry = operations.findIndex(
      (op) => op.tool === unresolved.name,
    );
    if (firstRetry >= 0 && firstRetry < firstCanon) return { ok: true };
    return worldFactReject(
      toolName,
      unresolved,
      `batch must retry ${unresolved.name} before canon-writing operations`,
    );
  }

  if (CANON_AFTER_PAYMENT_TOOLS.has(toolName)) {
    return worldFactReject(
      toolName,
      unresolved,
      `same-turn failed ${unresolved.name} is unresolved`,
    );
  }

  return { ok: true };
}

function worldFactReject(
  toolName: string,
  failed: ToolHistoryEntry,
  reason: string,
): { ok: false; reason: string; suggestion: Record<string, unknown> } {
  return {
    ok: false,
    reason: `world_fact_canon_guard: ${reason}`,
    suggestion: {
      guard: 'world_fact_canon_guard',
      blocked_tool: toolName,
      failed_tool: failed.name,
      failed_args: failed.args,
      failed_error: failed.error ?? null,
      retry:
        'Retry or explicitly resolve the failed world-state tool before writing memory, quest progress, rewards, strings, or runtime-field canon. If the world-state mutation cannot succeed, narrate the failed attempt without committing downstream canon.',
    },
  };
}

function mutationBudgetVerdict(
  toolName: string,
  args: unknown,
  ctx: ToolContext,
):
  | { ok: true }
  | { ok: false; reason: string; suggestion: Record<string, unknown> } {
  if (ctx.toolHistorySource !== 'ai_sdk') return { ok: true };
  const history = activeHistory(ctx);
  if (!history) return { ok: true };
  const budget = mutationBudget();
  const used = history.filter(
    (entry) =>
      entry.ok &&
      (entry.source === 'ai_sdk' || entry.source === 'batch_child') &&
      MUTATION_TOOLS.has(entry.name) &&
      entry.name !== 'batch_mutate_world',
  ).length;
  const cost =
    toolName === 'batch_mutate_world'
      ? Math.max(
          1,
          readBatchOperations(args).filter((op) => MUTATION_TOOLS.has(op.tool))
            .length,
        )
      : 1;
  if (used + cost <= budget) return { ok: true };
  return {
    ok: false,
    reason: `mutation_budget_exceeded: ${used}+${cost}>${budget}`,
    suggestion: {
      guard: 'mutation_budget',
      used_mutations: used,
      requested_mutations: cost,
      budget,
      retry:
        'Call narrate now with the current consequences. Continue further state changes only on the next player turn or by a compact atomic batch that fits the budget.',
    },
  };
}

function unresolvedFailedTransfer(ctx: ToolContext): ToolHistoryEntry | null {
  const history = activeHistory(ctx);
  if (!history) return null;
  let failed: ToolHistoryEntry | null = null;
  for (const entry of history) {
    if (entry.name !== 'inventory_transfer') continue;
    failed = entry.ok ? null : entry;
  }
  return failed;
}

function unresolvedFailedWorldFact(ctx: ToolContext): ToolHistoryEntry | null {
  const history = activeHistory(ctx);
  if (!history) return null;
  let failed: ToolHistoryEntry | null = null;
  for (const entry of history) {
    if (!WORLD_FACT_PREREQ_TOOLS.has(entry.name)) continue;
    if (entry.ok) {
      if (failed?.name === entry.name) failed = null;
      continue;
    }
    failed = entry;
  }
  return failed;
}

function activeHistory(ctx: ToolContext): ToolHistoryEntry[] | null {
  const active = activeTurn(ctx);
  return active?.toolHistory ?? null;
}

function activeTurn(ctx: ToolContext): {
  turnId: string;
  toolHistory?: ToolHistoryEntry[];
  brokerToolProfile?: string;
} | null {
  const session = sessionManager.get(ctx.sessionId);
  const active = session?.activeTurn;
  if (!active) return null;
  if (
    ctx.turnId &&
    active.turnId !== ctx.turnId &&
    !ctx.turnId.startsWith(`${active.turnId}:`)
  ) {
    return null;
  }
  return active;
}

function mutationBudget(): number {
  const raw = Number(config().mutationBudget ?? DEFAULT_MUTATION_BUDGET);
  if (!Number.isFinite(raw)) return DEFAULT_MUTATION_BUDGET;
  return Math.max(1, Math.min(20, Math.trunc(raw)));
}

function readBatchOperations(args: unknown): Array<{ tool: string }> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const operations = (args as Record<string, unknown>)['operations'];
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((op) => {
    if (!op || typeof op !== 'object' || Array.isArray(op)) return [];
    const tool = (op as Record<string, unknown>)['tool'];
    return typeof tool === 'string' && tool.trim()
      ? [{ tool: tool.trim() }]
      : [];
  });
}

async function readBatchTransferIntents(
  args: unknown,
): Promise<TransferIntent[]> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const operations = (args as Record<string, unknown>)['operations'];
  if (!Array.isArray(operations)) return [];
  const transfers = await Promise.all(
    operations.map((op) => {
      if (!op || typeof op !== 'object' || Array.isArray(op)) return null;
      const rec = op as Record<string, unknown>;
      if (rec['tool'] !== 'inventory_transfer') return null;
      return readTransferIntent(rec['args']);
    }),
  );
  return transfers.filter(
    (transfer): transfer is TransferIntent => transfer != null,
  );
}

async function readTransferIntent(
  args: unknown,
): Promise<TransferIntent | null> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const rec = args as Record<string, unknown>;
  const rawItem = rec['item'];
  const item =
    typeof rawItem === 'string'
      ? rawItem.trim()
      : typeof rawItem === 'number' && Number.isInteger(rawItem) && rawItem > 0
        ? String(rawItem)
        : '';
  if (!item) return null;
  const currency = await isCurrencyItemRef(rawItem, item);
  const fromPlayer = typeof rec['from_player_id'] === 'number';
  const toPlayer = typeof rec['to_player_id'] === 'number';
  const fromNull = rec['from'] === null;
  const fromName = readHolderIntent(rec, 'from');
  const toName = readHolderIntent(rec, 'to');
  return { item, currency, fromNull, fromPlayer, fromName, toPlayer, toName };
}

function readHolderIntent(
  rec: Record<string, unknown>,
  prefix: 'from' | 'to',
): string | null {
  const raw = rec[prefix];
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return String(raw);
  }
  return null;
}

function isCurrencyItem(item: string): boolean {
  // LANGUAGE-REGEX-OK: cartridge canonical currency-token allowlist ("Gold Coin" / "Silver Coin" / RFC-style "gp"/"sp"/"cp" abbreviations the cartridge ships). Token-based wire-format match against authored item identifiers, not player utterances.
  return /(?:^|[_\s-])(?:gold|silver|copper|coin|coins|gp|sp|cp)(?:$|[_\s-])/i.test(
    item,
  );
}

async function isCurrencyItemRef(
  rawItem: unknown,
  fallbackLabel: string,
): Promise<boolean> {
  if (isCurrencyItem(fallbackLabel)) return true;
  if (
    typeof rawItem !== 'number' ||
    !Number.isInteger(rawItem) ||
    rawItem <= 0
  ) {
    return false;
  }
  try {
    const row = await query<{
      slug: string | null;
      category: string | null;
      display_name: string | null;
    }>(
      `SELECT i.slug,
              i.category,
              e.display_name
         FROM items i
         LEFT JOIN entities e ON e.id = i.legacy_entity_id
        WHERE i.id = $1 OR i.legacy_entity_id = $1
        LIMIT 1`,
      [rawItem],
    );
    const item = row.rows[0];
    if (!item) return false;
    if (item.category === 'currency') return true;
    return [item.slug, item.display_name].some(
      (value) => typeof value === 'string' && isCurrencyItem(value),
    );
  } catch {
    return false;
  }
}

for (const toolName of MUTATION_TOOLS) {
  registerPreToolValidatorSpecialist({
    name: `finalization_guards.${toolName}`,
    phase: 'preToolValidator',
    toolName,
    validator,
  });
}
