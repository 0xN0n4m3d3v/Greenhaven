/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ARCH-1 — deterministic broker fallback machinery extracted from
// `turnBrokerStage.ts`. This module owns the five fallback entry
// points the broker stage delegates to:
//
//   * `tryResolveIntimacyEmptyBrokerFallback` — empty broker output
//     in intimacy mode falls through to a dice-check + intimacy-
//     state-tool dispatch + scripted prose.
//   * `tryResolveIntimacyNarrateOnlyBrokerFallback` — broker
//     requested narrate-only without first persisting an intimacy
//     state tool; reuses the empty-broker path with a different
//     telemetry phase.
//   * `tryResolveCombatNegotiationEmptyBrokerFallback` — combat-
//     mode empty output where the player text reads as
//     negotiation; runs a charm check and scripted prose.
//   * `ensureSceneItemPickupBeforeNarrate` — scene-trade narrate
//     guard that picks up the mentioned location item BEFORE the
//     narrator runs, so the prose can describe ownership change.
//   * `tryResolveBrokerToolsNoVisibleFallback` — broker called
//     tools but produced no visible output; synthesises a
//     world-acknowledgment line so the turn never ends silent.
//
// All fallback prose, regex constants, dice-check helpers, SQL
// loaders, and the synthetic-broker-call SSE dispatcher
// (`dispatchFallbackTool`) live here. Behavior is unchanged
// byte-for-byte: same telemetry event names + payloads, same
// `SSE-OK` annotations, same prose, same regex.

import type {BrokerOutcome} from '../../ai/handoff.js';
import {query} from '../../db.js';
import {
  currentLocationAuthorId,
  synthesiseNarrate,
} from '../../narrationSynthesis.js';
import type {Session} from '../../sessionManager.js';
import {telemetry} from '../../telemetry/index.js';
import {
  dispatch,
  type ToolContext,
  type ToolResult,
} from '../../tools/base.js';
import {hasVisibleNarrateMessage} from '../../turnNarrationStage.js';
import type {BrokerStageInput} from '../../turnBrokerStage.js';

interface DialoguePartner {
  id: number;
  name: string;
}

interface SceneItemCandidate {
  id: number;
  displayName: string;
  locationId: number;
}

export async function tryResolveIntimacyEmptyBrokerFallback(
  input: BrokerStageInput,
  opts: {
    source?:
      | 'intimacy_empty_broker_fallback'
      | 'intimacy_state_broker_fallback';
    phase?: string;
  } = {},
): Promise<boolean> {
  if (
    input.mode !== 'intimacy' &&
    input.brokerToolProfile !== 'intimacy_social'
  ) {
    return false;
  }
  const partner = await loadActiveDialoguePartner(input.playerId);
  if (!partner) return false;

  const ctx: ToolContext = {
    sessionId: input.session.id,
    playerId: input.playerId,
    turnId: input.turnId,
    signal: input.signal,
    toolHistorySource: 'direct',
  };
  const payment = parseIntimacyPaymentOffer(input.rawPlayerText);
  const hasClearConsent = CLEAR_CONSENT_RE.test(input.rawPlayerText);
  const shouldRoll =
    payment != null || UNCERTAIN_INTIMACY_DEAL_RE.test(input.rawPlayerText);
  let rollOutcome = existingDiceOutcome(input);

  if (shouldRoll && rollOutcome == null && input.brokerTools.has('dice_check')) {
    const roll = await dispatchFallbackTool(input, ctx, 'dice_check', {
      d: 20,
      modifier: 1,
      dc: 14,
      label: `Consent and leverage with ${partner.name}`,
      roller: 'player',
      position: payment != null ? 'risky' : 'controlled',
      effect: 'standard',
      advantage: false,
      disadvantage: false,
      skill: 'Charm',
      category: 'check',
      target_id: partner.id,
      check_kind: payment != null ? 'intimacy_offer' : 'intimacy_approach',
      environment_tags: [],
    });
    rollOutcome = readDiceOutcome(roll);
  }

  const beatLands =
    hasClearConsent || (rollOutcome === 'success' && payment != null);

  if (beatLands) {
    if (payment != null && input.brokerTools.has('inventory_transfer')) {
      await dispatchFallbackTool(input, ctx, 'inventory_transfer', {
        item: 'Gold Coin',
        count: payment.amount,
        from_player_id: input.playerId,
        to: partner.name,
        reason: 'consensual intimate payment',
      });
    }
    if (input.brokerTools.has('apply_intimacy_trigger')) {
      await dispatchFallbackTool(input, ctx, 'apply_intimacy_trigger', {
        trigger_tag: 'first_kiss',
        partner_id: partner.id,
      });
    }
    if (input.brokerTools.has('string_award')) {
      await dispatchFallbackTool(input, ctx, 'string_award', {
        npc: partner.name,
        delta: 1,
        reason: 'consensual intimate beat',
      });
    }
    if (input.brokerTools.has('add_memory')) {
      await dispatchFallbackTool(input, ctx, 'add_memory', {
        owner: partner.id,
        about: input.playerId,
        text: `${partner.name} remembers that this intimate beat was explicit, consensual, and changed the leverage between them.`,
        importance: 0.72,
        tags: ['intimacy', 'consent', 'first_kiss'],
        sensitive: true,
      });
    }
    await narrateIntimacyFallback(
      input,
      partner,
      'accepted',
      payment,
      opts.source,
    );
  } else {
    if (input.brokerTools.has('add_memory')) {
      await dispatchFallbackTool(input, ctx, 'add_memory', {
        owner: partner.id,
        about: input.playerId,
        text:
          payment != null
            ? `${partner.name} remembers the player's paid intimacy offer and keeps the boundary explicit.`
            : `${partner.name} remembers the player's intimate approach and answers with a clear boundary.`,
        importance: 0.62,
        tags: ['intimacy', 'boundary'],
        sensitive: true,
      });
    }
    await narrateIntimacyFallback(
      input,
      partner,
      'boundary',
      payment,
      opts.source,
    );
  }

  const intimacyPhase = opts.phase ?? 'turn.intimacy_empty_broker_fallback';
  telemetry.record({
    channel: 'performance',
    name: intimacyPhase,
    sessionId: input.session.id,
    playerId: input.playerId,
    turnId: input.turnId,
    traceId: input.turnId,
    kind: 'turn',
    phase: intimacyPhase,
    status: 'ok',
    durationMs: 0,
    metadata: {
      partner_id: partner.id,
      payment_amount: payment?.amount ?? null,
      roll_outcome: rollOutcome,
      beat_lands: beatLands,
    },
  });
  return true;
}

export async function tryResolveIntimacyNarrateOnlyBrokerFallback(
  input: BrokerStageInput,
): Promise<boolean> {
  if (
    input.mode !== 'intimacy' &&
    input.brokerToolProfile !== 'intimacy_social'
  ) {
    return false;
  }
  const history = input.session.activeTurn?.toolHistory ?? [];
  const persisted = history.some(entry =>
    [
      'apply_intimacy_trigger',
      'string_award',
      'add_memory',
      'advance_quest',
      'start_quest',
    ].includes(entry.name),
  );
  if (persisted) return false;
  return tryResolveIntimacyEmptyBrokerFallback(input, {
    source: 'intimacy_state_broker_fallback',
    phase: 'turn.intimacy_state_broker_fallback',
  });
}

export async function tryResolveCombatNegotiationEmptyBrokerFallback(
  input: BrokerStageInput,
): Promise<boolean> {
  if (!COMBAT_NEGOTIATION_RE.test(input.rawPlayerText)) return false;
  if (!input.brokerTools.has('dice_check')) return false;

  const target = await loadNearbyCombatTarget(input.playerId);
  const ctx: ToolContext = {
    sessionId: input.session.id,
    playerId: input.playerId,
    turnId: input.turnId,
    signal: input.signal,
    toolHistorySource: 'direct',
  };
  const roll = await dispatchFallbackTool(input, ctx, 'dice_check', {
    d: 20,
    modifier: 1,
    dc: 13,
    label: target
      ? `De-escalate ${target.name}`
      : 'De-escalate the immediate threat',
    roller: 'player',
    position: 'risky',
    effect: 'standard',
    advantage: false,
    disadvantage: false,
    skill: 'Charm',
    category: 'check',
    ...(target ? {target_id: target.id} : {}),
    check_kind: 'combat_deescalation',
    environment_tags: [],
  });
  const outcome = readDiceOutcome(roll);
  const text = combatNegotiationFallbackText(input, target, outcome);
  const author = await currentLocationAuthorId(input.playerId);
  await synthesiseNarrate(
    input.session,
    input.playerId,
    input.turnId,
    text,
    false,
    {
      ...(author != null ? {author} : {}),
      tone: 'narrator',
      text,
      done: true,
    },
    'combat_negotiation_empty_broker_fallback',
  );
  telemetry.record({
    channel: 'performance',
    name: 'turn.combat_negotiation_empty_broker_fallback',
    sessionId: input.session.id,
    playerId: input.playerId,
    turnId: input.turnId,
    traceId: input.turnId,
    kind: 'turn',
    phase: 'turn.combat_negotiation_empty_broker_fallback',
    status: 'ok',
    durationMs: 0,
    metadata: {
      target_id: target?.id ?? null,
      roll_outcome: outcome,
    },
  });
  return true;
}

export async function ensureSceneItemPickupBeforeNarrate(
  input: BrokerStageInput,
): Promise<void> {
  if (input.brokerToolProfile !== 'scene_trade') return;
  if (hasSuccessfulToolCall(input, 'inventory_transfer')) return;
  const candidate = await findMentionedCurrentLocationItem(input);
  if (!candidate) return;
  if (!sceneItemTradePickupIntent(input.rawPlayerText, candidate)) return;

  const ctx: ToolContext = {
    sessionId: input.session.id,
    playerId: input.playerId,
    turnId: input.turnId,
    signal: input.signal,
    toolHistorySource: 'direct',
  };
  const started = Date.now();
  const result = await dispatchFallbackTool(input, ctx, 'inventory_transfer', {
    from: candidate.locationId,
    item: candidate.id,
    count: 1,
    to_player_id: input.playerId,
    reason: 'scene item pickup before trade narration',
  });
  telemetry.record({
    channel: 'performance',
    name: 'turn.scene_item_pickup_fallback',
    sessionId: input.session.id,
    playerId: input.playerId,
    turnId: input.turnId,
    traceId: input.turnId,
    kind: 'turn',
    phase: 'turn.scene_item_pickup_fallback',
    status: result.ok ? 'ok' : 'error',
    durationMs: Date.now() - started,
    error: result.ok ? null : result.error ?? 'inventory_transfer failed',
    metadata: {
      item_id: candidate.id,
      item_name: candidate.displayName,
      location_id: candidate.locationId,
      source: 'scene_trade_narrate_guard',
    },
  });
}

function hasSuccessfulToolCall(
  input: BrokerStageInput,
  toolName: string,
): boolean {
  return (input.session.activeTurn?.toolHistory ?? []).some(
    entry => entry.name === toolName && entry.ok,
  );
}

async function findMentionedCurrentLocationItem(
  input: BrokerStageInput,
): Promise<SceneItemCandidate | null> {
  const player = await query<{current_location_id: number | null}>(
    `SELECT current_location_id
       FROM players
      WHERE entity_id = $1`,
    [input.playerId],
  );
  const locationId = player.rows[0]?.current_location_id;
  if (locationId == null) return null;

  const items = await query<{
    id: number;
    display_name: string | null;
    count: number;
  }>(
    `SELECT e.id, e.display_name, ie.count
       FROM inventory_entries ie
       JOIN entities e ON e.id = ie.item_entity_id
      WHERE ie.holder_entity_id = $1
        AND ie.count > 0
      ORDER BY length(COALESCE(e.display_name, '')) DESC, e.id`,
    [locationId],
  );
  const text = normalizeLooseText(input.rawPlayerText);
  for (const item of items.rows) {
    const displayName = item.display_name?.trim();
    if (!displayName || item.count <= 0) continue;
    const normalizedName = normalizeLooseText(displayName);
    if (normalizedName && text.includes(normalizedName)) {
      return {id: Number(item.id), displayName, locationId};
    }
  }
  return null;
}

function sceneItemTradePickupIntent(
  text: string,
  item: SceneItemCandidate,
): boolean {
  const normalized = normalizeLooseText(text);
  const itemName = normalizeLooseText(item.displayName);
  if (!itemName || !normalized.includes(itemName)) return false;
  // Language-neutral: an @-mention + a number in the same message that
  // also names the scene item is enough signal that the player is making
  // a buy/sell/transfer offer for the item. Per-language keyword tests
  // were removed (they only covered en+ru and broke multilingual play).
  return /@\S+/.test(text) && /\b\d{1,4}\b/.test(text);
}

function normalizeLooseText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

async function loadActiveDialoguePartner(
  playerId: number,
): Promise<DialoguePartner | null> {
  const row = await query<{id: number | null; display_name: string | null}>(
    `SELECT e.id, e.display_name
       FROM players p
       LEFT JOIN entities e ON e.id = p.dialogue_partner_id
      WHERE p.entity_id = $1`,
    [playerId],
  );
  const partner = row.rows[0];
  if (partner?.id == null || !partner.display_name) return null;
  return {id: Number(partner.id), name: partner.display_name};
}

async function loadNearbyCombatTarget(
  playerId: number,
): Promise<DialoguePartner | null> {
  const row = await query<{id: number; display_name: string | null}>(
    `SELECT e.id, e.display_name
       FROM players p
       JOIN entities e
        ON e.kind = 'person'
       AND e.id <> p.entity_id
       AND (
         e.profile->>'current_location_id' = p.current_location_id::text
         OR e.profile->>'home_id' = p.current_location_id::text
         OR e.profile->>'location_id' = p.current_location_id::text
       )
       AND NOT EXISTS (
         SELECT 1 FROM actor_statuses s
          WHERE s.player_id = p.entity_id
            AND s.actor_entity_id = e.id
            AND s.intensity > 0
            AND s.status_kind IN ('dead', 'missing')
       )
      WHERE p.entity_id = $1
      ORDER BY
        CASE
          WHEN 'combat_probe' = ANY(e.tags) THEN 0
          WHEN lower(COALESCE(e.profile->>'social_role', '')) LIKE '%hostile%' THEN 1
          ELSE 2
        END,
        e.id DESC
      LIMIT 1`,
    [playerId],
  );
  const target = row.rows[0];
  if (!target?.display_name) return null;
  return {id: Number(target.id), name: target.display_name};
}

async function dispatchFallbackTool(
  input: BrokerStageInput,
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const callId = `intimacy-fallback:${name}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  // SSE-OK: emit outside tx (reason: synthetic broker tool-call
  // marker for the intimacy-fallback dispatch).
  input.session.sse.emit('tool.request', {callId, name, args});
  const result = await dispatch(name, args, ctx);
  // SSE-OK: emit outside tx (reason: synthetic broker tool-call
  // completion marker for the intimacy-fallback dispatch; the
  // tool itself already committed its writes via dispatch()).
  input.session.sse.emit('tool.result', {
    callId,
    status: result.ok ? 'success' : 'error',
    display: '',
    error: result.ok
      ? undefined
      : {
          type: 'TOOL_EXECUTION_ERROR',
          message: result.error ?? 'tool failed',
        },
  });
  return result;
}

function parseIntimacyPaymentOffer(
  text: string,
): {amount: number; currency: 'Gold Coin'} | null {
  // LANGUAGE-REGEX-OK: structured-amount extractor — number followed by the cartridge's canonical "Gold Coin" currency identifier (en+ru inflection variants the cartridge ships). Wire-format parsing, not natural-language intent classification.
  const match = text.match(
    /\b(\d{1,3})\s*(?:Gold Coin|Gold Coins|gold|coins?|золот(?:ые|ых|ой|ая)?|монет(?:ы|у|а)?)\b/iu,
  );
  if (!match?.[1]) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {amount, currency: 'Gold Coin'};
}

function readDiceOutcome(result: ToolResult): 'success' | 'failure' | null {
  if (!result.ok || !result.data || typeof result.data !== 'object')
    return null;
  const outcome = (result.data as {outcome?: unknown}).outcome;
  return outcome === 'success' || outcome === 'failure' ? outcome : null;
}

function existingDiceOutcome(
  input: BrokerStageInput,
): 'success' | 'failure' | null {
  const history = input.session.activeTurn?.toolHistory ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry || entry.name !== 'dice_check') continue;
    if (!entry.ok || !entry.result || typeof entry.result !== 'object') {
      continue;
    }
    const outcome = (entry.result as {outcome?: unknown}).outcome;
    if (outcome === 'success' || outcome === 'failure') return outcome;
  }
  return null;
}

function combatNegotiationFallbackText(
  input: BrokerStageInput,
  target: DialoguePartner | null,
  outcome: 'success' | 'failure' | null,
): string {
  const ru = input.playerLang.trim().toLowerCase().startsWith('ru');
  const name = target?.name ?? (ru ? 'противник' : 'the threat');
  if (ru) {
    if (outcome === 'success') {
      return `${name} замирает на полушаге: монеты звякают по камню, а твой отступ не выглядит бегством. Проверка удерживает сцену от резни. Угроза ещё рядом, но теперь у неё есть выбор — взять плату, отступить или назвать цену вслух.`;
    }
    if (outcome === 'failure') {
      return `${name} не покупается на жест сразу. Монеты разлетаются по полу, но давление не исчезает: ты выиграл мгновение, не победу. Следующий ход должен решить, отступаешь ли ты дальше, зовёшь свидетелей или переходишь к защите.`;
    }
    return `${name} получает шанс ответить на твой жест без пустого технического провала. Монеты на полу становятся ставкой сцены, а не завершённой сделкой; следующий ход уточнит цену, страх или насилие.`;
  }

  if (outcome === 'success') {
    return `${name} freezes half a step forward: the coins ring across the stone, and your retreat does not read as panic. The check keeps the scene from becoming slaughter. The threat is still present, but now it can take the offer, back away, or name a price aloud.`;
  }
  if (outcome === 'failure') {
    return `${name} does not buy the gesture at once. The coins scatter, but the pressure stays: you bought a moment, not safety. The next move needs to decide whether you keep backing away, call witnesses, or defend yourself.`;
  }
  return `${name} gets a real chance to answer the gesture instead of a technical stall. The coins on the floor become the scene's stake, not a completed deal; the next move will test price, fear, or violence.`;
}

async function narrateIntimacyFallback(
  input: BrokerStageInput,
  partner: DialoguePartner,
  kind: 'accepted' | 'boundary',
  payment: {amount: number; currency: 'Gold Coin'} | null,
  source:
    | 'intimacy_empty_broker_fallback'
    | 'intimacy_state_broker_fallback' = 'intimacy_empty_broker_fallback',
): Promise<void> {
  const ru = input.playerLang.trim().toLowerCase().startsWith('ru');
  const text = ru
    ? intimacyFallbackRu(partner, kind, payment)
    : intimacyFallbackEn(partner, kind, payment);
  await synthesiseNarrate(
    input.session,
    input.playerId,
    input.turnId,
    text,
    false,
    {
      author: partner.id,
      tone: 'npc',
      text,
      done: true,
    },
    source,
  );
}

export async function tryResolveBrokerToolsNoVisibleFallback(
  input: BrokerStageInput,
  broker: BrokerOutcome,
): Promise<boolean> {
  if (hasVisibleNarrateMessage(input.session, input.turnId)) return false;
  const history = input.session.activeTurn?.toolHistory ?? [];
  const toolNames =
    broker.toolNamesCalled.length > 0
      ? broker.toolNamesCalled
      : history.map(entry => entry.name);
  const nonNarrateTools = toolNames.filter(name => name !== 'narrate');
  if (nonNarrateTools.length === 0) return false;

  const text = buildBrokerToolsNoVisibleFallbackText(
    input,
    history,
    nonNarrateTools,
  );
  const author = await currentLocationAuthorId(input.playerId);
  await synthesiseNarrate(
    input.session,
    input.playerId,
    input.turnId,
    text,
    false,
    {
      ...(author != null ? {author} : {}),
      tone: 'narrator',
      text,
      done: true,
    },
    'broker_tools_no_visible_output_fallback',
  );
  telemetry.record({
    channel: 'performance',
    name: 'turn.broker_tools_no_visible_output_fallback',
    sessionId: input.session.id,
    playerId: input.playerId,
    turnId: input.turnId,
    traceId: input.turnId,
    kind: 'turn',
    phase: 'turn.broker_tools_no_visible_output_fallback',
    status: 'ok',
    durationMs: 0,
    metadata: {
      tool_names: nonNarrateTools,
      tool_errors: history
        .filter(entry => !entry.ok)
        .map(entry => ({name: entry.name, error: entry.error ?? null})),
    },
  });
  return true;
}

function buildBrokerToolsNoVisibleFallbackText(
  input: BrokerStageInput,
  history: NonNullable<NonNullable<Session['activeTurn']>['toolHistory']>,
  toolNames: readonly string[],
): string {
  const ru = input.playerLang.trim().toLowerCase().startsWith('ru');
  const failedTransfer = history.some(
    entry => entry.name === 'inventory_transfer' && !entry.ok,
  );
  const successfulTransfer = history.some(
    entry => entry.name === 'inventory_transfer' && entry.ok,
  );
  const readOnly = toolNames.every(name =>
    [
      'query_entity',
      'query_inventory',
      'query_player_state',
      'get_recent_history',
      'search_entities',
      'query_memory',
    ].includes(name),
  );

  if (ru) {
    if (failedTransfer) {
      return 'Сделка не исчезает в тишине: собеседник останавливает руку и требует сначала закрепить владение предметом или монетами как ясный факт сцены. Пока предмет не оказался у нужного владельца, оплаты и передачи не происходит; следующий ход должен явно назвать источник, владельца и условие сделки.';
    }
    if (successfulTransfer) {
      return 'Действие закреплено в мире: предметы или монеты уже сменили владельца, и собеседник реагирует на это как на состоявшийся факт. Теперь можно требовать цену, подтверждение, маршрут или следующий шаг сделки.';
    }
    if (readOnly) {
      return 'Мир сверяет память, инвентарь и положение персонажей, но не оставляет ход пустым: собеседники признают проверенные факты и предлагают двигаться дальше через конкретное действие, доказательство или вопрос.';
    }
    return 'Ход не проваливается в молчание: мир фиксирует выполненные проверки и возвращает инициативу игроку через ближайшее видимое последствие сцены.';
  }

  if (failedTransfer) {
    return 'The deal does not vanish into silence: the other character stops the exchange until ownership of the item or coins is clear in the scene. No payment or handoff happens until the next move names the source, holder, and terms.';
  }
  if (successfulTransfer) {
    return 'The action is now anchored in the world: items or coins have changed hands, and the other character treats that as a real fact. The next move can press for a price, confirmation, route, or condition.';
  }
  if (readOnly) {
    return 'The world checks memory, inventory, and character positions without leaving the turn blank. The characters acknowledge the verified facts and push toward a concrete action, proof, or question.';
  }
  return 'The turn does not fall silent: the world keeps the checks visible and hands the initiative back through the nearest consequence in the scene.';
}

function intimacyFallbackRu(
  partner: DialoguePartner,
  kind: 'accepted' | 'boundary',
  payment: {amount: number; currency: 'Gold Coin'} | null,
): string {
  if (kind === 'accepted') {
    const paid =
      payment != null
        ? ` ${payment.amount} Gold Coin исчезают с твоей ладони только после её явного кивка.`
        : '';
    return `${partner.name} не даёт моменту распасться на неловкую паузу.${paid} Она обозначает границу прямо, без игры в недомолвки, и отвечает на поцелуй так, чтобы согласие осталось сказанным, а не подразумеваемым. Когда она отстраняется, между вами уже есть след: не обещание владения, а новая нить взаимного риска.`;
  }
  const price =
    payment != null
      ? ` На предложенные ${payment.amount} Gold Coin она смотрит как на повод к разговору, а не как на разрешение.`
      : '';
  return `${partner.name} удерживает сцену живой, но не отдаёт её на автопилот.${price} «Нет, не так. Сначала условие, потом близость. Скажи, чего ты правда хочешь, и что готов оставить за дверью».`;
}

function intimacyFallbackEn(
  partner: DialoguePartner,
  kind: 'accepted' | 'boundary',
  payment: {amount: number; currency: 'Gold Coin'} | null,
): string {
  if (kind === 'accepted') {
    const paid =
      payment != null
        ? ` The ${payment.amount} Gold Coin leaves your hand only after her clear nod.`
        : '';
    return `${partner.name} keeps the moment from collapsing into a pause.${paid} She names the boundary plainly, then answers the kiss as something chosen, not assumed. When she draws back, the scene has left a mark: not ownership, but a new thread of mutual risk.`;
  }
  const price =
    payment != null
      ? ` She treats the offered ${payment.amount} Gold Coin as a conversation, not permission.`
      : '';
  return `${partner.name} keeps the scene alive without letting it run on autopilot.${price} "No, not like that. Terms first, closeness after. Say what you really want, and what you are willing to leave at the door."`;
}

const CLEAR_CONSENT_RE = new RegExp(
  [
    String.raw`\b(?:clear|explicit|consensual|consent|agreed)\b`,
    String.raw`(?:явн|соглас|добровол)`,
  ].join('|'),
  'iu',
);

const UNCERTAIN_INTIMACY_DEAL_RE = new RegExp(
  [
    String.raw`\b(?:offer|price|paid|payment|deal|bargain)\b`,
    String.raw`(?:предлаг|цен|плат|торг|сделк)`,
  ].join('|'),
  'iu',
);

const COMBAT_NEGOTIATION_RE = new RegExp(
  [
    String.raw`\b(?:back away|de-escalate|do not want to kill|drop|throw)\b.{0,120}\b(?:coin|surrender|take them|walk away)\b`,
    String.raw`\b(?:spare|talk down)\b.{0,120}\b(?:attacker|bandit|cutpurse|enemy|raider)\b`,
    String.raw`(?:не\s+хочу\s+убив|броса\w*\s+монет|шаг\s+назад|бери\s+и\w*\s+уход|налетчик)`,
  ].join('|'),
  'iu',
);
