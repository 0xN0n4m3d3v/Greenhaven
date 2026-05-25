/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {withTransaction} from '../db.js';

export interface PlayerProfileView {
  display_name: string;
  profile: unknown;
}

export class ProfileService {
  static async get(playerId: number): Promise<PlayerProfileView | null> {
    return withTransaction(async tx => {
      const r = await tx.query<{display_name: string; profile: unknown}>(
        `SELECT display_name, profile FROM entities
          WHERE id = $1 AND kind = 'player'`,
        [playerId],
      );
      const row = r.rows[0];
      return row
        ? {display_name: row.display_name, profile: row.profile ?? {}}
        : null;
    });
  }

  static async patch(
    playerId: number,
    patch: Record<string, unknown>,
  ): Promise<PlayerProfileView | null> {
    const merge = {...patch, last_edited: new Date().toISOString()};
    const incomingName =
      typeof (patch['identity'] as Record<string, unknown> | undefined)?.[
        'name'
      ] === 'string'
        ? String(
            (patch['identity'] as Record<string, unknown>)['name'],
          ).trim()
        : '';

    return withTransaction(async tx => {
      const update = incomingName
        ? await tx.query(
            `UPDATE entities
                SET display_name = $1,
                    profile = COALESCE(profile, '{}'::jsonb) || $2::jsonb
              WHERE id = $3 AND kind = 'player'`,
            [incomingName, JSON.stringify(merge), playerId],
          )
        : await tx.query(
            `UPDATE entities
                SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
              WHERE id = $2 AND kind = 'player'`,
            [JSON.stringify(merge), playerId],
          );
      if (update.rowCount === 0) return null;

      const fresh = await tx.query<{display_name: string; profile: unknown}>(
        `SELECT display_name, profile FROM entities
          WHERE id = $1 AND kind = 'player'`,
        [playerId],
      );
      const row = fresh.rows[0];
      return row
        ? {display_name: row.display_name, profile: row.profile ?? {}}
        : null;
    });
  }
}
