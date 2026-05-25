/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// OWV-17 — materializer execution tool.
//
// Applies one authored materializer row from the
// `forge_materializer_bridge` cartridge_meta document to the active
// player's world state. A single transaction:
//
//   1. resolve the materializer entry via
//      `MaterializerBridgeService` (source / target / scope mentions
//      already joined onto `entities`);
//   2. short-circuit if the row has already been applied for this
//      player (idempotency keyed on the NPC-memory metadata field
//      `materializer_id`, looked up through `MemoryService`);
//   3. ensure a deterministic runtime target entity exists for the
//      authored `entity_slug` — created on first apply, reused on
//      every later call, keyed on `profile.source_slug` so a
//      re-export does not duplicate rows;
//   4. dispatch by `type`:
//        - `location/hidden-exit` — append a bidirectional exit
//          between the scope location and the target location;
//        - `item/*` with inventory scope — ensure the items catalog
//          row exists (creating it for `target_status: "new"`),
//          refuse currency, grant the item to the hero or named
//          NPC/container holder;
//        - any other supported type — the durable applied memory
//          plus the target entity are the only state changes;
//   5. roll the whole transaction back on any failure so partial
//      applications never persist.
//
// Read-only inspection still flows through the bridge service /
// runtime context tools; this tool is the only mutation surface
// the OWV-17 materializer slice adds.

import {z} from 'zod';
import {withTransaction, type TxClient} from '../db.js';
import {emitGuiEvent} from '../guiEventOutbox.js';
import {loadWitnessIdsForLocation} from '../locationPresence.js';
import {sessionManager} from '../sessionManager.js';
import {ToolExecutionError, registerTool, type ToolContext} from './base.js';
import {
  emitPlayerInventoryEvents,
  incrementPlayerItem,
  incrementLegacyItem,
  ensureLegacyEntityForItem,
  type InventoryItemRef,
} from './inventoryCommon.js';
import {
  listMaterializerEntries,
  findMaterializerEntry,
  type MaterializerEntry,
} from '../services/MaterializerBridgeService.js';
import {resolveActivePlayerCartridgeId} from '../services/CartridgePlaythroughService.js';
import {MemoryService} from '../domain/memory/index.js';

const ApplyMaterializerArgs = z.object({
  materializer_id: z
    .string()
    .min(1)
    .describe(
      'Stable per-row id minted by the Forge SQL export (`sha256(source_slug|entity_slug|type|scope|effect).slice(0,16)`).',
    ),
});

const APPLIED_MEMORY_KIND = 'materializer_applied';
const APPLIED_MEMORY_FAMILY = 'materializer';

const SUPPORTED_TYPE_PREFIXES = new Set([
  'location',
  'item',
  'container',
  'state',
  'hero',
]);

registerTool({
  name: 'apply_materializer_bridge',
  description:
    "Apply one authored materializer row for the active player in a single transaction. Idempotent: the second call is a no-op if the same materializer has already been applied to the player. For every supported type other than `location/hidden-exit`, the tool creates or reuses a deterministic runtime target entity (keyed on `profile.source_slug = entity_slug`). `location/hidden-exit` wires a bidirectional exit between the scope and target locations. `item/*` rows whose scope is exactly `hero inventory` or `@Name inventory` additionally ensure the items catalog row exists and grant non-currency items to the active hero or named holder; authors may add machine token `count=N` in Scope or Effect. Other supported families (`location/*`, `container/*`, `state|*/service`) materialize the target entity and record a durable applied memory. Unresolved source/target/scope or unsupported type rejects without DB changes.",
  paramsSchema: ApplyMaterializerArgs,
  async execute(args, ctx) {
    return applyMaterializerBridge(args, ctx);
  },
});

interface ItemGrant {
  item: InventoryItemRef;
  legacyEntityId: number;
  count: number;
  holderEntityId: number;
  holderKind: 'hero' | 'entity';
  holderMention?: string;
  emitPlayerInventoryEvent: boolean;
}

export interface AppliedMaterializerResult {
  ok: true;
  already_applied: boolean;
  materializer_id: string;
  type: string;
  source_entity_id: number;
  target_entity_id: number | null;
  target_entity_created?: boolean;
  memory_id: number;
  exits_wired?: number[];
  items_granted?: Array<{
    item_id: number;
    slug: string;
    count: number;
    holder_entity_id: number;
    holder_kind: 'hero' | 'entity';
    holder_mention?: string;
  }>;
  hero_profile_directive?: HeroProfileDirective;
  hero_status?: HeroStatusChange;
  hero_voice?: HeroVoiceMessage;
}

interface HeroProfileDirective {
  type: string;
  scope: string;
  prompt: string;
  applied_at: string;
}

interface HeroStatusChange {
  actor_id: number;
  status_kind: string;
  status_value: string;
  intensity: number;
  reason: string | null;
}

interface HeroVoiceMessage {
  message_id: number;
  turn_index: number;
  text: string;
  turn_id: string;
}

export interface AutoMaterializerTriggerResult {
  trigger_source: string;
  source_slug: string | null;
  applied: AppliedMaterializerResult[];
  rejected: Array<{materializer_id: string; error: string}>;
}

export async function applyMaterializerBridge(
  args: z.infer<typeof ApplyMaterializerArgs>,
  ctx: ToolContext,
): Promise<AppliedMaterializerResult> {
  const cartridgeId = await resolveActivePlayerCartridgeId(ctx.playerId);
  const entry = await findMaterializerEntry(args.materializer_id, {
    cartridgeId,
  });
  if (!entry) {
    throw new ToolExecutionError(
      `unknown materializer: ${args.materializer_id}`,
      {rejected: true},
    );
  }
  return applyMaterializerEntry(entry, ctx, cartridgeId);
}

export async function applyMaterializersForTrigger(
  ctx: ToolContext,
  triggerSource: string,
  opts: {sourceSlug?: string | null} = {},
): Promise<AutoMaterializerTriggerResult> {
  const cartridgeId = await resolveActivePlayerCartridgeId(ctx.playerId);
  const sourceSlug = normalizeSlug(opts.sourceSlug);
  if (sourceSlug == null) {
    return {trigger_source: triggerSource, source_slug: null, applied: [], rejected: []};
  }
  const entries = (await listMaterializerEntries({cartridgeId})).filter(
    entry =>
      entry.triggerSource === triggerSource &&
      entry.sourceSlug === sourceSlug &&
      isSupportedType(entry.type),
  );
  const applied: AppliedMaterializerResult[] = [];
  const rejected: Array<{materializer_id: string; error: string}> = [];
  for (const entry of entries) {
    try {
      applied.push(await applyMaterializerEntry(entry, ctx, cartridgeId));
    } catch (err) {
      rejected.push({
        materializer_id: entry.materializerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (applied.length > 0 || rejected.length > 0) {
    await emitGuiEvent(ctx, 'materializer:auto_applied', {
      triggerSource,
      sourceSlug,
      applied: applied.map(summaryForEvent),
      rejected,
    });
  }
  return {trigger_source: triggerSource, source_slug: sourceSlug, applied, rejected};
}

async function applyMaterializerEntry(
  entry: MaterializerEntry,
  ctx: ToolContext,
  cartridgeId: string,
): Promise<AppliedMaterializerResult> {
  if (entry.sourceEntityId == null) {
    throw new ToolExecutionError(
      `materializer source entity not resolved for slug \`${entry.sourceSlug}\``,
      {rejected: true, suggestion: {materializer_id: entry.materializerId}},
    );
  }
  if (!isSupportedType(entry.type)) {
    throw new ToolExecutionError(
      `unsupported materializer type: ${entry.type}`,
      {
        rejected: true,
        suggestion: {materializer_id: entry.materializerId, type: entry.type},
      },
    );
  }

  const alreadyApplied = await findAppliedMemoryId(
    ctx.playerId,
    entry.materializerId,
  );
  if (alreadyApplied != null) {
    return {
      ok: true,
      already_applied: true,
      materializer_id: entry.materializerId,
      type: entry.type,
      source_entity_id: entry.sourceEntityId,
      target_entity_id: entry.targetEntityId,
      memory_id: alreadyApplied,
    };
  }

  const itemGrants: ItemGrant[] = [];
  let heroProfileDirective: HeroProfileDirective | undefined;
  let heroStatus: HeroStatusChange | undefined;
  let heroVoice: HeroVoiceMessage | undefined;
  let exitsWired: number[] = [];
  let targetEntityId: number | null = entry.targetEntityId;
  let targetEntityCreated = false;

  const result = await withTransaction(async client => {
    if (isHeroMaterializer(entry.type)) {
      const heroResult = await applyHeroMaterializer(
        client,
        ctx,
        entry,
        cartridgeId,
      );
      targetEntityId = ctx.playerId;
      heroProfileDirective = heroResult.profileDirective;
      heroStatus = heroResult.status;
      heroVoice = heroResult.voice;
    } else if (entry.type === 'location/hidden-exit') {
      // Hidden exits link two existing locations; the bridge
      // service already resolved both ids so we never create
      // entities here. A null target is a rejection.
      exitsWired = await applyHiddenExit(client, entry);
    } else {
      // Every other supported type promises a deterministic
      // runtime target. Create it if absent, reuse otherwise.
      const ensured = await ensureMaterializerTargetEntity(
        client,
        entry,
        cartridgeId,
      );
      targetEntityId = ensured.entityId;
      targetEntityCreated = ensured.created;
      if (isItemMaterializer(entry.type)) {
        const grant = await applyAccessItemGrant(
          client,
          ctx.playerId,
          entry,
          targetEntityId,
          cartridgeId,
        );
        if (grant) itemGrants.push(grant);
      }
    }
    // Every successful path writes the same durable applied memory:
    // it is both the audit row and the idempotency key.
    const memory = await MemoryService.insertNpcMemory({
      ownerEntityId: entry.sourceEntityId!,
      aboutEntityId: ctx.playerId,
      text: entry.effect || `Applied materializer ${entry.materializerId}.`,
      importance: 0.5,
      tags: appliedTags(entry),
      sensitive: false,
      salience: 0.5,
      memoryKind: APPLIED_MEMORY_KIND,
      memoryFamily: APPLIED_MEMORY_FAMILY,
      sourceTurnId: ctx.turnId ?? null,
      sourceTool: 'apply_materializer_bridge',
      metadata: {
        materializer_id: entry.materializerId,
        type: entry.type,
        source_slug: entry.sourceSlug,
        entity_slug: entry.entitySlug,
        target_status: entry.targetStatus,
        trigger_source: entry.triggerSource,
        trigger_condition: entry.triggerCondition,
        scope: entry.scope,
        target_entity_id: targetEntityId,
        target_entity_created: targetEntityCreated,
        ...(exitsWired.length > 0 ? {exits_wired: exitsWired} : {}),
        ...(itemGrants.length > 0
          ? {
              items_granted: itemGrants.map(g => ({
                item_id: g.item.id,
                slug: g.item.slug,
                count: g.count,
                holder_entity_id: g.holderEntityId,
                holder_kind: g.holderKind,
                ...(g.holderMention ? {holder_mention: g.holderMention} : {}),
              })),
            }
          : {}),
        ...(heroProfileDirective ? {hero_profile_directive: heroProfileDirective} : {}),
        ...(heroStatus ? {hero_status: heroStatus} : {}),
        ...(heroVoice ? {hero_voice: heroVoice} : {}),
      },
    });
    return {
      ok: true as const,
      already_applied: false,
      materializer_id: entry.materializerId,
      type: entry.type,
      source_entity_id: entry.sourceEntityId!,
      target_entity_id: targetEntityId,
      target_entity_created: targetEntityCreated,
      memory_id: memory.id,
      exits_wired: exitsWired,
      items_granted: itemGrants.map(g => ({
        item_id: g.item.id,
        slug: g.item.slug,
        count: g.count,
        holder_entity_id: g.holderEntityId,
        holder_kind: g.holderKind,
        ...(g.holderMention ? {holder_mention: g.holderMention} : {}),
      })),
      hero_profile_directive: heroProfileDirective,
      hero_status: heroStatus,
      hero_voice: heroVoice,
    };
  });

  // SSE-OK: the underlying inventory write already committed via
  // `withTransaction`; `emitPlayerInventoryEvents` is safe to fire
  // post-commit. Each granted item gets its own emit so the
  // inventory bridge sees a fresh balance per slug.
  for (const grant of itemGrants) {
    if (!grant.emitPlayerInventoryEvent) continue;
    await emitPlayerInventoryEvents(ctx.sessionId, [ctx.playerId], {
      id: grant.item.id,
      slug: grant.item.slug,
      category: grant.item.category,
      legacy_entity_id: grant.legacyEntityId,
    });
  }
  if (heroVoice) emitHeroVoiceMessage(ctx, heroVoice);
  await emitGuiEvent(ctx, 'materializer:applied', summaryForEvent(result));
  return result;
}

function isSupportedType(type: string): boolean {
  const prefix = type.split('/')[0];
  return typeof prefix === 'string' && SUPPORTED_TYPE_PREFIXES.has(prefix);
}

function normalizeSlug(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isItemMaterializer(type: string): boolean {
  return type.split('/')[0] === 'item';
}

function isHeroMaterializer(type: string): boolean {
  return type.split('/')[0] === 'hero';
}

function summaryForEvent(result: AppliedMaterializerResult): Record<string, unknown> {
  return {
    materializer_id: result.materializer_id,
    type: result.type,
    already_applied: result.already_applied,
    source_entity_id: result.source_entity_id,
    target_entity_id: result.target_entity_id,
    target_entity_created: result.target_entity_created ?? false,
    memory_id: result.memory_id,
    exits_wired: result.exits_wired ?? [],
    items_granted: result.items_granted ?? [],
    hero_profile_directive: result.hero_profile_directive ?? null,
    hero_status: result.hero_status ?? null,
    hero_voice: result.hero_voice ?? null,
  };
}

function appliedTags(entry: MaterializerEntry): string[] {
  return [
    'materializer',
    entry.type,
    entry.sourceSlug,
    `materializer:${entry.materializerId}`,
  ];
}

async function findAppliedMemoryId(
  playerId: number,
  materializerId: string,
): Promise<number | null> {
  return MemoryService.selectAppliedMaterializerMemoryId({
    playerId,
    materializerId,
  });
}

async function applyHiddenExit(
  client: TxClient,
  entry: MaterializerEntry,
): Promise<number[]> {
  if (entry.targetEntityId == null) {
    throw new ToolExecutionError(
      `materializer target location not resolved for \`${entry.entitySlug}\``,
      {rejected: true, suggestion: {materializer_id: entry.materializerId}},
    );
  }
  const scopeLocation = entry.scopeMentions.find(m => m.entityId != null);
  if (!scopeLocation || scopeLocation.entityId == null) {
    throw new ToolExecutionError(
      `materializer scope location not resolved for \`${entry.scope}\``,
      {rejected: true, suggestion: {materializer_id: entry.materializerId}},
    );
  }
  const a = scopeLocation.entityId;
  const b = entry.targetEntityId;
  // OWV-7: clear the compile-time visibility gate the Obsidian
  // compiler set on this target. `move_player.validateMovement-
  // Reachability` reads `profile.hidden_until_stage`; while it is
  // truthy the route is unreachable. We also drop a `'hidden'` tag
  // if the compiler ever emits one alongside the gate. Both ops
  // are idempotent (`profile - 'hidden_until_stage'` and
  // `array_remove(tags, 'hidden')` are no-ops when absent), so
  // re-applying a hidden-exit is safe.
  await client.query(
    `UPDATE entities
        SET profile = COALESCE(profile, '{}'::jsonb) - 'hidden_until_stage',
            tags = COALESCE(array_remove(tags, 'hidden'), tags),
            updated_at = now()
      WHERE id = $1
        AND kind = 'location'`,
    [b],
  );
  if (a === b) return [];
  await appendExit(client, a, b);
  await appendExit(client, b, a);
  return [a, b].sort((x, y) => x - y);
}

async function appendExit(
  client: TxClient,
  from: number,
  to: number,
): Promise<void> {
  // jsonb_set + JSON containment guard keeps the exits array
  // deduped: if `to` is already present we leave the row alone, so
  // a re-application after a manual edit doesn't duplicate the id.
  await client.query(
    `UPDATE entities
        SET profile = jsonb_set(
              COALESCE(profile, '{}'::jsonb),
              '{exits}',
              COALESCE(profile->'exits', '[]'::jsonb) || jsonb_build_array($2::bigint),
              true
            ),
            updated_at = now()
      WHERE id = $1
        AND kind = 'location'
        AND NOT (COALESCE(profile->'exits', '[]'::jsonb) @> jsonb_build_array($2::bigint))`,
    [from, to],
  );
}

async function applyAccessItemGrant(
  client: TxClient,
  playerId: number,
  entry: MaterializerEntry,
  targetEntityId: number,
  cartridgeId: string,
): Promise<ItemGrant | null> {
  const target = await resolveInventoryGrantTarget(
    client,
    entry,
    playerId,
    cartridgeId,
  );
  if (!target) {
    // Scope didn't promise the hero gets a tangible item — fall
    // through to the durable-memory-only path.
    return null;
  }
  const item = await ensureMaterializerItemRow(client, entry, targetEntityId);
  if (item.category === 'currency') {
    throw new ToolExecutionError(
      `materializer cannot grant currency items: ${entry.entitySlug}`,
      {rejected: true, suggestion: {materializer_id: entry.materializerId}},
    );
  }
  const count = materializerGrantCount(entry);
  const legacyId = await ensureLegacyEntityForItem(client, item);
  if (target.holderKind === 'hero') {
    await incrementPlayerItem(client, playerId, item.id, count);
    await incrementLegacyItem(client, playerId, legacyId, count);
  } else {
    await incrementLegacyItem(client, target.holderEntityId, legacyId, count);
  }
  return {
    item,
    legacyEntityId: legacyId,
    count,
    holderEntityId: target.holderEntityId,
    holderKind: target.holderKind,
    holderMention: target.holderMention,
    emitPlayerInventoryEvent: target.holderKind === 'hero',
  };
}

async function applyHeroMaterializer(
  client: TxClient,
  ctx: ToolContext,
  entry: MaterializerEntry,
  cartridgeId: string,
): Promise<{
  profileDirective?: HeroProfileDirective;
  status?: HeroStatusChange;
  voice?: HeroVoiceMessage;
}> {
  const family = entry.type.split('/')[1]?.trim().toLowerCase() ?? '';
  if (family === 'voice' || family === 'speak' || family === 'line') {
    return {voice: await applyHeroVoice(client, ctx, entry, cartridgeId)};
  }
  if (family === 'status' || family === 'state') {
    return {status: await applyHeroStatus(client, ctx, entry, cartridgeId)};
  }
  if (
    family === 'profile' ||
    family === 'profile-prompt' ||
    family === 'backstory' ||
    family === 'starting'
  ) {
    return {
      profileDirective: await applyHeroProfileDirective(
        client,
        ctx,
        entry,
        cartridgeId,
      ),
    };
  }
  throw new ToolExecutionError(
    `unsupported hero materializer type: ${entry.type}`,
    {
      rejected: true,
      suggestion: {
        materializer_id: entry.materializerId,
        supported: [
          'hero/backstory',
          'hero/profile',
          'hero/profile-prompt',
          'hero/status',
          'hero/voice',
        ],
      },
    },
  );
}

async function applyHeroProfileDirective(
  client: TxClient,
  ctx: ToolContext,
  entry: MaterializerEntry,
  cartridgeId: string,
): Promise<HeroProfileDirective> {
  const prompt = entry.effect.trim();
  if (!prompt) {
    throw new ToolExecutionError(
      `hero profile materializer requires Effect text: ${entry.materializerId}`,
      {rejected: true, suggestion: {materializer_id: entry.materializerId}},
    );
  }
  const row = await client.query<{profile: Record<string, unknown> | null}>(
    `SELECT profile
       FROM entities
      WHERE id = $1 AND kind = 'player'
      LIMIT 1`,
    [ctx.playerId],
  );
  if (!row.rows[0]) {
    throw new ToolExecutionError(`unknown hero: ${ctx.playerId}`, {
      rejected: true,
      suggestion: {materializer_id: entry.materializerId},
    });
  }
  const profile = cloneRecord(row.rows[0]!.profile ?? {});
  const directive: HeroProfileDirective = {
    type: entry.type,
    scope: entry.scope,
    prompt: prompt.slice(0, 6000),
    applied_at: new Date().toISOString(),
  };
  const directives = Array.isArray(profile['cartridge_directives'])
    ? [...(profile['cartridge_directives'] as unknown[])]
    : [];
  directives.push({
    materializer_id: entry.materializerId,
    source_slug: entry.sourceSlug,
    source_path: entry.sourcePath,
    cartridge_id: cartridgeId,
    ...directive,
  });
  profile['cartridge_directives'] = directives.slice(-20);

  const background = cloneRecord(profile['background']);
  const corrections = Array.isArray(background['cartridge_corrections'])
    ? [...(background['cartridge_corrections'] as unknown[])]
    : [];
  corrections.push({
    materializer_id: entry.materializerId,
    prompt: directive.prompt,
    scope: entry.scope,
    applied_at: directive.applied_at,
  });
  background['cartridge_corrections'] = corrections.slice(-20);
  background['cartridge_prompt'] = directive.prompt;
  profile['background'] = background;

  const creatorSheet = cloneRecord(profile['creator_sheet']);
  const historyPrompts = Array.isArray(creatorSheet['history_corrections'])
    ? [...(creatorSheet['history_corrections'] as unknown[])]
    : [];
  historyPrompts.push({
    materializer_id: entry.materializerId,
    prompt: directive.prompt,
    applied_at: directive.applied_at,
  });
  creatorSheet['history_corrections'] = historyPrompts.slice(-20);
  profile['creator_sheet'] = creatorSheet;
  profile['last_edited'] = directive.applied_at;

  await client.query(
    `UPDATE entities
        SET profile = $2::jsonb
      WHERE id = $1 AND kind = 'player'`,
    [ctx.playerId, JSON.stringify(profile)],
  );
  return directive;
}

async function applyHeroStatus(
  client: TxClient,
  ctx: ToolContext,
  entry: MaterializerEntry,
  cartridgeId: string,
): Promise<HeroStatusChange> {
  const kv = parseEffectPairs(entry.effect);
  const typeParts = entry.type.split('/').map(part => part.trim()).filter(Boolean);
  const inferredKind = typeParts.length > 2 ? typeParts.slice(2).join('_') : '';
  const statusKind = cleanStatusToken(
    kv.get('status_kind') ?? kv.get('kind') ?? inferredKind ?? 'cartridge',
    'cartridge',
  );
  const statusValue = cleanStatusValue(
    kv.get('status_value') ?? kv.get('value') ?? firstSentence(entry.effect),
  );
  const intensity = clamp01(Number(kv.get('intensity') ?? '0.5'));
  const reason = materializerText(entry).slice(0, 240) || null;
  await client.query(
    `INSERT INTO actor_statuses
       (player_id, actor_entity_id, status_kind, status_value, intensity,
        source, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'materializer:hero/status', $6::jsonb, now())
     ON CONFLICT (player_id, actor_entity_id, status_kind) DO UPDATE SET
       status_value = EXCLUDED.status_value,
       intensity = EXCLUDED.intensity,
       source = EXCLUDED.source,
       metadata = actor_statuses.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [
      ctx.playerId,
      ctx.playerId,
      statusKind,
      statusValue,
      intensity,
      JSON.stringify({
        materializer_id: entry.materializerId,
        source_slug: entry.sourceSlug,
        source_path: entry.sourcePath,
        cartridge_id: cartridgeId,
        scope: entry.scope,
        effect: entry.effect,
        turn_id: ctx.turnId ?? null,
      }),
    ],
  );
  const actor = await client.query<{display_name: string}>(
    `SELECT display_name FROM entities WHERE id = $1`,
    [ctx.playerId],
  );
  await emitGuiEvent(ctx, 'actor:status_changed', {
    actorId: ctx.playerId,
    actorName: actor.rows[0]?.display_name ?? 'Hero',
    statusKind,
    statusValue,
    intensity,
    reason,
  });
  return {
    actor_id: ctx.playerId,
    status_kind: statusKind,
    status_value: statusValue,
    intensity,
    reason,
  };
}

async function applyHeroVoice(
  client: TxClient,
  ctx: ToolContext,
  entry: MaterializerEntry,
  cartridgeId: string,
): Promise<HeroVoiceMessage> {
  const kv = parseEffectPairs(entry.effect);
  const text = cleanVoiceText(kv.get('line') ?? kv.get('text') ?? entry.effect);
  if (!text) {
    throw new ToolExecutionError(
      `hero voice materializer requires Effect line text: ${entry.materializerId}`,
      {rejected: true, suggestion: {materializer_id: entry.materializerId}},
    );
  }
  const turnId = ctx.turnId ?? `materializer:${entry.materializerId}`;
  const turnIndex = await client.query<{n: number}>(
    `SELECT COALESCE(MAX(turn_index), 0) + 1 AS n
       FROM chat_messages WHERE session_id = $1`,
    [ctx.sessionId],
  );
  const current = await client.query<{
    current_location_id: number | string | null;
  }>(
    `SELECT current_location_id
       FROM players
      WHERE entity_id = $1`,
    [ctx.playerId],
  );
  const locationId =
    current.rows[0]?.current_location_id == null
      ? null
      : Number(current.rows[0]!.current_location_id);
  const normalizedLocationId =
    locationId != null && Number.isFinite(locationId) && locationId > 0
      ? locationId
      : null;
  const witnessIds = await loadWitnessIdsForLocation(
    normalizedLocationId,
    cartridgeId,
  );
  const inserted = await client.query<{id: number; turn_index: number}>(
    `INSERT INTO chat_messages
       (session_id, author_entity_id, tone, text, turn_index, payload,
        player_id, location_entity_id, witness_entity_ids)
     VALUES ($1, $2, 'player', $3, $4, $5::jsonb, $6, $7, $8::bigint[])
     RETURNING id, turn_index`,
    [
      ctx.sessionId,
      ctx.playerId,
      text,
      turnIndex.rows[0]!.n,
      JSON.stringify({
        turn_id: turnId,
        source: 'cartridge_hero_voice',
        materializer_id: entry.materializerId,
        source_slug: entry.sourceSlug,
        source_path: entry.sourcePath,
        cartridge_id: cartridgeId,
        scope: entry.scope,
      }),
      ctx.playerId,
      normalizedLocationId,
      witnessIds,
    ],
  );
  return {
    message_id: Number(inserted.rows[0]!.id),
    turn_index: Number(inserted.rows[0]!.turn_index),
    text,
    turn_id: turnId,
  };
}

function emitHeroVoiceMessage(ctx: ToolContext, voice: HeroVoiceMessage): void {
  const session = sessionManager.get(ctx.sessionId);
  session?.sse.emit('message:created', {
    messageId: voice.message_id,
    turnId: voice.turn_id,
    turnIndex: voice.turn_index,
    tone: 'player',
    authorId: ctx.playerId,
    text: voice.text,
    visibleText: voice.text,
    source: 'cartridge_hero_voice',
  });
}

interface InventoryGrantTarget {
  holderEntityId: number;
  holderKind: 'hero' | 'entity';
  holderMention?: string;
}

async function resolveInventoryGrantTarget(
  client: TxClient,
  entry: MaterializerEntry,
  playerId: number,
  cartridgeId: string,
): Promise<InventoryGrantTarget | null> {
  const scope = normalizeScope(entry.scope);
  if (!scope.includes('inventory')) return null;
  if (scope.includes('hero inventory')) {
    return {holderEntityId: playerId, holderKind: 'hero'};
  }
  const mention = entry.scopeMentions.find(m => {
    if (m.entityId == null) return false;
    return scope.includes(`${normalizeScope(m.mention)} inventory`);
  });
  if (!mention) {
    const suffixMention = await resolveInventorySuffixMention(
      client,
      entry,
      cartridgeId,
    );
    if (suffixMention) return suffixMention;
  }
  if (!mention) {
    throw new ToolExecutionError(
      `materializer inventory scope must target \`hero inventory\` or \`@Name inventory\`: ${entry.scope}`,
      {rejected: true, suggestion: {materializer_id: entry.materializerId}},
    );
  }
  return {
    holderEntityId: mention.entityId!,
    holderKind: 'entity',
    holderMention: mention.mention,
  };
}

async function resolveInventorySuffixMention(
  client: TxClient,
  entry: MaterializerEntry,
  cartridgeId: string,
): Promise<InventoryGrantTarget | null> {
  for (const mention of entry.scopeMentions) {
    if (!normalizeScope(mention.mention).endsWith(' inventory')) continue;
    const holderSlug = mention.slug.replace(/-inventory$/, '');
    if (!holderSlug) continue;
    const rows = await client.query<{id: number}>(
      `SELECT id
         FROM entities
        WHERE profile->>'source_slug' = $1
          AND cartridge_id = $2
        ORDER BY id ASC
        LIMIT 1`,
      [holderSlug, cartridgeId],
    );
    const id = rows.rows[0]?.id;
    if (id == null) continue;
    return {
      holderEntityId: Number(id),
      holderKind: 'entity',
      holderMention: mention.mention.replace(/\s+inventory$/i, ''),
    };
  }
  return null;
}

function normalizeScope(value: string): string {
  return value
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function materializerGrantCount(entry: MaterializerEntry): number {
  for (const text of [entry.scope, entry.effect]) {
    const match = /\bcount=([1-9]\d{0,3})\b/i.exec(text);
    if (!match) continue;
    return Math.min(Number(match[1]), 999);
  }
  return 1;
}

function materializerText(entry: MaterializerEntry): string {
  return [entry.effect, entry.scope]
    .map(text => text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return {...(value as Record<string, unknown>)};
}

function parseEffectPairs(effect: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of effect.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim().toLowerCase().replace(/-/g, '_');
    const value = part.slice(index + 1).trim();
    if (key && value) out.set(key, value);
  }
  return out;
}

function cleanStatusToken(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned || fallback;
}

function cleanStatusValue(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || 'active';
}

function firstSentence(value: string): string {
  const end = value.search(/[.!?\n;]/);
  const sentence = end >= 0 ? value.slice(0, end) : value;
  return sentence.trim() || value.trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function cleanVoiceText(value: string): string {
  return value
    .trim()
    .replace(/^["“”']+|["“”']+$/g, '')
    .replace(/\s+\n/g, '\n')
    .slice(0, 2000)
    .trim();
}

/** Create or reuse the deterministic runtime entity authored by a
 *  materializer row. Keyed on `profile.source_slug = entry.entitySlug`
 *  so a second apply on the same vault re-export reuses the row
 *  instead of duplicating it. The first matching row wins when more
 *  than one entity carries the same slug — we never mutate unrelated
 *  rows.
 *
 *  Kind is derived from the materializer type prefix: `location/*`
 *  becomes a location entity; `item/*` and `container/*` are items
 *  (containers ride the items catalog like other holders); `state/*`
 *  and other supported families become `event` rows so they thread
 *  into world-fact / timeline plumbing rather than the actor mesh.
 */
async function ensureMaterializerTargetEntity(
  client: TxClient,
  entry: MaterializerEntry,
  cartridgeId: string,
): Promise<{entityId: number; created: boolean}> {
  const existing = await client.query<{id: number}>(
    `SELECT id FROM entities
      WHERE profile->>'source_slug' = $1
        AND cartridge_id = $2
      ORDER BY id ASC
      LIMIT 1`,
    [entry.entitySlug, cartridgeId],
  );
  if (existing.rows[0]) {
    return {entityId: Number(existing.rows[0].id), created: false};
  }
  const kind = targetKindForType(entry.type);
  const displayName = (
    entry.entity.startsWith('@') ? entry.entity.slice(1) : entry.entity
  ).trim() || entry.entitySlug;
  const profile: Record<string, unknown> = {
    source_slug: entry.entitySlug,
    source_path: entry.sourcePath,
    source_category: 'materializer',
    materializer_id: entry.materializerId,
    materializer_type: entry.type,
    materializer_source_slug: entry.sourceSlug,
    materializer_source_path: entry.sourcePath,
    target_status: entry.targetStatus,
    scope: entry.scope,
    effect: entry.effect,
  };
  const tags = materializerTags(kind, entry);
  const inserted = await client.query<{id: number}>(
    `INSERT INTO entities
       (kind, display_name, summary, profile, tags, cartridge_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING id`,
    [
      kind,
      displayName,
      entry.effect ? entry.effect.slice(0, 500) : null,
      JSON.stringify(profile),
      tags,
      cartridgeId,
    ],
  );
  return {entityId: Number(inserted.rows[0]!.id), created: true};
}

function targetKindForType(type: string): string {
  const prefix = type.split('/')[0] ?? '';
  switch (prefix) {
    case 'location':
      return 'location';
    case 'item':
    case 'container':
      return 'item';
    case 'state':
    default:
      return 'event';
  }
}

function materializerTags(kind: string, entry: MaterializerEntry): string[] {
  const out = new Set<string>([
    kind,
    'materializer',
    entry.type,
    entry.sourceSlug,
  ]);
  if (entry.type.startsWith('container/')) out.add('container');
  if (entry.type.includes('service')) out.add('service');
  if (entry.targetStatus) out.add(`target:${entry.targetStatus}`);
  return [...out].filter(t => t && t.length > 0);
}

/** Ensure the runtime `items` catalog has a row for an
 *  `item/access-state` materializer. Reuses an existing row when one
 *  is already present (backfilling its `legacy_entity_id` when null
 *  so future grants resolve the ledger correctly), otherwise inserts
 *  a fresh row pointing at the just-created target entity. Currency
 *  rows are returned as-is; the caller rejects on currency before
 *  granting.
 */
async function ensureMaterializerItemRow(
  client: TxClient,
  entry: MaterializerEntry,
  targetEntityId: number,
): Promise<InventoryItemRef> {
  const existing = await client.query<InventoryItemRef>(
    `SELECT id, slug, category, legacy_entity_id
       FROM items
      WHERE slug = $1
      LIMIT 1`,
    [entry.entitySlug],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.legacy_entity_id == null) {
      const updated = await client.query<{legacy_entity_id: number | null}>(
        `UPDATE items
            SET legacy_entity_id = $2
          WHERE id = $1 AND legacy_entity_id IS NULL
        RETURNING legacy_entity_id`,
        [row.id, targetEntityId],
      );
      if (updated.rows[0]) row.legacy_entity_id = updated.rows[0].legacy_entity_id;
    }
    return row;
  }
  const inserted = await client.query<InventoryItemRef>(
    `INSERT INTO items
       (slug, category, weight_kg, stackable, max_stack, behaviour, legacy_entity_id)
     VALUES ($1, 'tool', 0.0, false, 1, $2::jsonb, $3)
     RETURNING id, slug, category, legacy_entity_id`,
    [
      entry.entitySlug,
      JSON.stringify({
        materializer_id: entry.materializerId,
        source_path: entry.sourcePath,
        materializer_type: entry.type,
      }),
      targetEntityId,
    ],
  );
  return inserted.rows[0]!;
}
