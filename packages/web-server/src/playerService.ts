/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Player service — anonymous-first identity with recovery codes.
//
//   POST /api/player/anonymous   → fresh UUID + recovery code (shown
//                                  ONCE; we store only its bcrypt hash).
//   POST /api/player/restore     → swap recovery code for the public_id.
//   GET  /api/player/me?id=...   → snapshot for the web-ui's player HUD.
//
// On creation we:
//   1. Insert an `entities` row with kind='player' so the rest of the
//      world model (memories, inventory, runtime overlays) can target
//      the player like any other entity.
//   2. Insert a `players` row carrying the progression state.
//   3. Copy starting inventory / stats / skills from the seeded class.

// DEEP-13 — `@node-rs/bcrypt` is a native (NAPI) bcrypt binding that
// offloads `hash`/`compare` to a libuv worker thread instead of
// blocking the main event loop the way `bcryptjs` did. Wire format is
// identical: produces `$2a$`/`$2b$` hashes and verifies any
// `$2a$`/`$2b$`/`$2y$` legacy hash written by the previous
// implementation, so stored player rows do not need a rehash.
import {compare, hash} from '@node-rs/bcrypt';
import {randomBytes, randomUUID} from 'node:crypto';
import {getMeta} from './cartridge.js';
import {query} from './db.js';

// All cartridge-specific values now live in cartridge_meta (migration
// 0018). Engine reads them at runtime so a different cartridge can
// ship its own currency / starting location / class without engine
// code edits. Player display names are created by the character flow,
// not by cartridge seed metadata.

export interface PublicPlayer {
  public_id: string;
  entity_id: number;
  display_name: string;
  profile_created: boolean;
  current_xp: number;
  current_level: number;
  current_hp: number;
  max_hp: number;
  current_location_id: number | null;
  current_scene_id: number | null;
  /** Display name of the entity referenced by current_location_id, if any. */
  current_location_name: string | null;
  /** Display name of the entity referenced by current_scene_id, if any. */
  current_scene_name: string | null;
  /** Spec 55 — surface persisted dialogue partner so the UI can show
   *  the partner banner immediately after F5 / cold start, without
   *  waiting for the next turn's dialogue:engaged SSE. */
  dialogue_partner_id: number | null;
  dialogue_partner_name: string | null;
  /** Spec 55 — bonded companion roster (spec 52). Frontend shows them
   *  in PEOPLE HERE / sidebar as travelling with the player. */
  companions: Array<{id: number; name: string}>;
}

export interface CreatedPlayer extends PublicPlayer {
  /**
   * Plain-text recovery code shown ONCE. Server only stores the hash.
   * Lose it = lose the account.
   */
  recovery_code: string;
}

interface FindByPublicIdOptions {
  preferCreated?: boolean;
}

interface FindLatestLocalOptions {
  preferCreated?: boolean;
}

// DEEP-1 — entropy is sourced from `crypto.randomBytes`, never from
// the unsalted browser-style PRNG. The user-facing format stays
// identical: four groups of four characters from a 32-symbol base32
// alphabet that drops the visually-ambiguous `0`/`O`/`1`/`I` glyphs.
// Sixteen base32 symbols carry log2(32) * 16 = 80 bits of entropy.
// 256 % 32 = 0, so taking `byte % 32` from a uniform byte is unbiased
// across the alphabet — no rejection-sampling loop is needed.
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generate a recovery code that is human-readable and copy-pasteable
 * but high-entropy. Format: 4 groups of 4 base32 chars separated by
 * dashes, e.g. "Q3F7-K2NB-9XJP-LM4D" (~80 bits).
 */
function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  const chars: string[] = new Array(16);
  for (let i = 0; i < 16; i++) {
    chars[i] = RECOVERY_CODE_ALPHABET[bytes[i]! % 32]!;
  }
  return (
    chars.slice(0, 4).join('') +
    '-' +
    chars.slice(4, 8).join('') +
    '-' +
    chars.slice(8, 12).join('') +
    '-' +
    chars.slice(12, 16).join('')
  );
}

/**
 * DEEP-1 internals export — exposes the pure recovery-code generator
 * so unit tests can verify the format and the absence of the
 * unsalted browser-style PRNG without going through the DB-backed
 * `createAnonymousPlayer` flow.
 */
export const playerServiceInternals = {
  generateRecoveryCode,
};

/**
 * Create a fresh anonymous player. Returns the public_id (for cookie /
 * localStorage) and the recovery_code which the UI must show to the
 * user once.
 */
export async function createAnonymousPlayer(
  displayName?: string,
): Promise<CreatedPlayer> {
  const publicId = randomUUID();
  const recoveryCode = generateRecoveryCode();
  const recoveryHash = await hash(recoveryCode, 10);
  // DEEP-2 — store the first four plaintext characters so `restoreByRecoveryCode`
  // can narrow the bcrypt-compare candidate set via an index lookup instead of
  // scanning every player. Generator output is already uppercase, but the
  // explicit `.toUpperCase()` mirrors the restore-side normalisation.
  const recoveryPrefix = recoveryCode.slice(0, 4).toUpperCase();

  // FEAT-ENGINE-BASELINE-6 — cartridge defaults are now soft. On a
  // clean baseline (no cartridge installed) `cartridge_meta` is empty,
  // so a hero can be minted with a null spawn location / class /
  // currency. The cartridge values are applied later by playthrough
  // launch (which assigns the cartridge-scoped starting location) and
  // by the apply pipeline (which seeds class / currency content). The
  // legacy seeded-default path is preserved when the keys are present.
  const [classId, locationId, sceneId, currencyItemId, startingCurrency] =
    await Promise.all([
      getMeta<number | null>('default_class_id', null),
      getMeta<number | null>('starting_location_id', null),
      getMeta<number | null>('starting_scene_id', null),
      getMeta<number | null>('currency_item_id', null),
      getMeta<number>('starting_currency_count', 0),
    ]);
  const cleanDisplayName = displayName?.trim();
  const finalDisplayName =
    cleanDisplayName && cleanDisplayName.length > 0
      ? cleanDisplayName
      : `Uncreated Player ${publicId.slice(0, 8)}`;

  // 1) Player entity. Tag includes 'anonymous' so we can distinguish
  //    from named accounts later.
  const entity = await query<{id: number}>(
    `INSERT INTO entities (kind, display_name, profile, tags)
     VALUES ('player', $1, $2::jsonb, $3)
     RETURNING id`,
    [
      finalDisplayName,
      JSON.stringify({public_id: publicId, anonymous: true}),
      ['player', 'anonymous'],
    ],
  );
  const entityId = entity.rows[0]!.id;

  // 2) Player progression row. `class_id`, `current_location_id`, and
  //    `current_scene_id` are all nullable on the schema; null values
  //    here mean "unassigned until launch", which playthrough
  //    launch/new-game resolves against the chosen cartridge's scoped
  //    starting location.
  const player = await query<PublicPlayer>(
    `INSERT INTO players
       (entity_id, public_id, recovery_code_hash, recovery_code_prefix,
        class_id, current_location_id, current_scene_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING entity_id, public_id, current_xp, current_level,
               current_hp, max_hp, current_location_id, current_scene_id`,
    [
      entityId,
      publicId,
      recoveryHash,
      recoveryPrefix,
      classId ?? null,
      locationId ?? null,
      sceneId ?? null,
    ],
  );

  // 3) Copy starting class loadout when a class is seeded for the
  //    active cartridge. On a clean baseline there is no class to copy.
  if (classId != null) {
    await applyClassLoadout(entityId, classId);
  }

  // 4a-spec26) Seed an empty profile shell on the player entity so
  //    the new /api/player/:id/profile endpoints (spec 26) and the
  //    PLAYER preamble block always have something to read.
  await query(
    `UPDATE entities SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
      WHERE id = $2 AND kind = 'player'`,
    [
      JSON.stringify({
        identity: {},
        physical: {},
        background: {},
        created: false,
      }),
      entityId,
    ],
  );

  // 4a) Spec 20 — seed an empty 'trauma' runtime_field for the new
  //    player. Same id formula (7000 + entity_id) as the migration
  //    backfill so existing and new players share the layout.
  await query(
    `INSERT INTO runtime_fields
       (id, owner_entity_id, field_key, value_type, default_value, allowed_values, scope, scope_per_player, description)
     VALUES (
       7000 + $1, $1, 'trauma', 'json', '[]'::jsonb, NULL,
       'permanent', false,
       'Accumulated Trauma tags from combat-resistance failures and quest catastrophes.'
     )
     ON CONFLICT (id) DO NOTHING`,
    [entityId],
  );

  // 4) Starting currency purse — cartridge-defined amount of the
  //    cartridge-defined currency item. Skipped entirely on a clean
  //    baseline (no currency item registered yet).
  if ((startingCurrency ?? 0) > 0 && currencyItemId != null) {
    await query(
      `INSERT INTO inventory_entries (holder_entity_id, item_entity_id, count)
       VALUES ($1, $2, $3)
       ON CONFLICT (holder_entity_id, item_entity_id)
       DO UPDATE SET count = inventory_entries.count + EXCLUDED.count`,
      [entityId, currencyItemId, startingCurrency],
    );
    const currencyItem = await query<{id: number}>(
      `SELECT id FROM items
        WHERE legacy_entity_id = $1
           OR category = 'currency'
        ORDER BY CASE WHEN legacy_entity_id = $1 THEN 0 ELSE 1 END
        LIMIT 1`,
      [currencyItemId],
    );
    const itemId = currencyItem.rows[0]?.id;
    if (itemId != null) {
      await query(
        `INSERT INTO player_inventory (player_id, item_id, quantity, equipped)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (player_id, item_id) WHERE equipped = false
         DO UPDATE SET quantity = player_inventory.quantity + EXCLUDED.quantity`,
        [entityId, itemId, startingCurrency],
      );
    }
  }

  // Resolve location/scene display names for the snapshot — UI uses
  // them to label the chat-header and (where relevant) the location-list.
  const namesRow = await query<{
    current_location_name: string | null;
    current_scene_name: string | null;
  }>(
    `SELECT loc.display_name AS current_location_name,
            scn.display_name AS current_scene_name
       FROM players p
       LEFT JOIN entities loc ON loc.id = p.current_location_id
       LEFT JOIN entities scn ON scn.id = p.current_scene_id
      WHERE p.entity_id = $1`,
    [entityId],
  );

  return {
    public_id: publicId,
    entity_id: entityId,
    display_name: finalDisplayName,
    profile_created: false,
    current_xp: player.rows[0]!.current_xp,
    current_level: player.rows[0]!.current_level,
    current_hp: player.rows[0]!.current_hp,
    max_hp: player.rows[0]!.max_hp,
    current_location_id: player.rows[0]!.current_location_id,
    current_scene_id: player.rows[0]!.current_scene_id,
    current_location_name: namesRow.rows[0]?.current_location_name ?? null,
    current_scene_name: namesRow.rows[0]?.current_scene_name ?? null,
    // Spec 55 — fresh player has no partner / no companions.
    dialogue_partner_id: null,
    dialogue_partner_name: null,
    companions: [],
    recovery_code: recoveryCode,
  };
}

/** Read class.profile.base_stats + starting_skills, write to player_*. */
async function applyClassLoadout(playerEntityId: number, classEntityId: number): Promise<void> {
  const cls = await query<{profile: Record<string, unknown>}>(
    `SELECT profile FROM entities WHERE id = $1 AND kind = 'class'`,
    [classEntityId],
  );
  const profile = (cls.rows[0]?.profile ?? {}) as {
    base_stats?: Record<string, number>;
    starting_skills?: number[];
  };

  if (profile.base_stats) {
    for (const [stat_key, value] of Object.entries(profile.base_stats)) {
      await query(
        `INSERT INTO player_stats (player_id, stat_key, base, current)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (player_id, stat_key) DO NOTHING`,
        [playerEntityId, stat_key, value],
      );
    }
  }
  if (Array.isArray(profile.starting_skills)) {
    for (const skillId of profile.starting_skills) {
      await query(
        `INSERT INTO player_skills (player_id, skill_entity_id, rank)
         VALUES ($1, $2, 1)
         ON CONFLICT DO NOTHING`,
        [playerEntityId, skillId],
      );
    }
  }
}

export async function findByPublicId(
  publicId: string,
  opts: FindByPublicIdOptions = {},
): Promise<PublicPlayer | null> {
  const r = await query<{
    public_id: string;
    entity_id: number;
    display_name: string;
    profile_created: boolean;
    current_xp: number;
    current_level: number;
    current_hp: number;
    max_hp: number;
    current_location_id: number | null;
    current_scene_id: number | null;
    current_location_name: string | null;
    current_scene_name: string | null;
    dialogue_partner_id: number | null;
    dialogue_partner_name: string | null;
    companions_raw: number[] | null;
  }>(
    `SELECT p.entity_id, p.public_id, e.display_name,
            COALESCE((e.profile->>'created')::boolean, false) AS profile_created,
            p.current_xp, p.current_level, p.current_hp, p.max_hp,
            p.current_location_id, p.current_scene_id,
            loc.display_name AS current_location_name,
            scn.display_name AS current_scene_name,
            p.dialogue_partner_id,
            dp.display_name AS dialogue_partner_name,
            (p.metadata->'companions') AS companions_raw
       FROM players p
       JOIN entities e ON e.id = p.entity_id
       LEFT JOIN entities loc ON loc.id = p.current_location_id
       LEFT JOIN entities scn ON scn.id = p.current_scene_id
       LEFT JOIN entities dp ON dp.id = p.dialogue_partner_id
      WHERE p.public_id = $1`,
    [publicId],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (opts.preferCreated && !row.profile_created) {
    const created = await query<{public_id: string}>(
      `SELECT p.public_id
         FROM players p
         JOIN entities e ON e.id = p.entity_id
        WHERE e.kind = 'player'
          AND COALESCE((e.profile->>'created')::boolean, false) = true
        ORDER BY p.last_seen DESC NULLS LAST, p.created_at DESC, p.entity_id DESC
        LIMIT 1`,
    );
    const createdPublicId = created.rows[0]?.public_id;
    if (createdPublicId && createdPublicId !== publicId) {
      return findByPublicId(createdPublicId);
    }
  }
  // Resolve companion display_names. Companions array from
  // players.metadata.companions[] (spec 52).
  let companions: Array<{id: number; name: string}> = [];
  const companionIds = Array.isArray(row.companions_raw)
    ? (row.companions_raw as number[])
    : [];
  if (companionIds.length > 0) {
    const compRows = await query<{id: number; display_name: string}>(
      `SELECT id, display_name FROM entities WHERE id = ANY($1::bigint[])`,
      [companionIds],
    );
    companions = compRows.rows.map(c => ({id: c.id, name: c.display_name}));
  }
  return {
    public_id: row.public_id,
    entity_id: row.entity_id,
    display_name: row.display_name,
    profile_created: row.profile_created,
    current_xp: row.current_xp,
    current_level: row.current_level,
    current_hp: row.current_hp,
    max_hp: row.max_hp,
    current_location_id: row.current_location_id,
    current_scene_id: row.current_scene_id,
    current_location_name: row.current_location_name,
    current_scene_name: row.current_scene_name,
    dialogue_partner_id: row.dialogue_partner_id,
    dialogue_partner_name: row.dialogue_partner_name,
    companions,
  };
}

/**
 * Desktop/offline recovery path. Electron localStorage can be cleared while
 * the local PGlite database still contains the real player. In that case the
 * boot bridge has no public_id to ask for, so it would otherwise create a new
 * empty anonymous player and hide the existing playthrough behind the wrong
 * player_id. Prefer a completed character, then fall back to the newest player
 * shell if no completed character exists.
 */
export async function findLatestLocalPlayer(
  opts: FindLatestLocalOptions = {},
): Promise<PublicPlayer | null> {
  const preferCreated = opts.preferCreated ?? true;
  const r = await query<{public_id: string}>(
    `SELECT p.public_id::text AS public_id
       FROM players p
       JOIN entities e ON e.id = p.entity_id
      ORDER BY
        CASE
          WHEN $1::boolean
           AND COALESCE((e.profile->>'created')::boolean, false)
          THEN 0
          ELSE 1
        END,
        p.last_seen DESC NULLS LAST,
        p.created_at DESC,
        p.entity_id DESC
      LIMIT 1`,
    [preferCreated],
  );
  const publicId = r.rows[0]?.public_id;
  return publicId ? findByPublicId(publicId, {preferCreated}) : null;
}

/**
 * Verify a recovery code matches one of our players and return them.
 * Returns null on no-match — never reveals which step failed.
 */
export async function restoreByRecoveryCode(
  recoveryCode: string,
): Promise<PublicPlayer | null> {
  const code = recoveryCode.trim().toUpperCase();
  if (code.length < 8) return null;
  // DEEP-2 — the indexed `players.recovery_code_prefix` column narrows
  // the bcrypt-compare candidate set to rows whose plaintext code
  // starts with the same four characters as the submitted code. The
  // prefix must match the migration's CHECK regex
  // (`^[A-HJ-NP-Z2-9]{4}$`) — anything else (e.g. user pastes a
  // garbled string) is rejected before we touch the DB. Legacy rows
  // written before migration 0116 have `recovery_code_prefix IS NULL`
  // and are deliberately skipped here: we never stored the plaintext
  // and cannot derive the prefix from the bcrypt hash, so reintroducing
  // a `WHERE recovery_code_hash IS NOT NULL` scan would just hand
  // back the O(N) DoS surface the prefix index exists to remove.
  const prefix = code.slice(0, 4);
  if (!/^[A-HJ-NP-Z2-9]{4}$/.test(prefix)) return null;
  const candidates = await query<{
    public_id: string;
    recovery_code_hash: string;
  }>(
    `SELECT p.public_id, p.recovery_code_hash
       FROM players p
      WHERE p.recovery_code_prefix = $1
        AND p.recovery_code_hash IS NOT NULL`,
    [prefix],
  );

  for (const row of candidates.rows) {
    const ok = await compare(code, row.recovery_code_hash);
    if (ok) {
      // Re-pull through findByPublicId so we get the full PublicPlayer
      // shape (including spec 55 fields: dialogue_partner_id,
      // dialogue_partner_name, companions).
      return await findByPublicId(row.public_id);
    }
  }
  return null;
}
