/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {query} from '../db.js';

export interface AmbientBedConfig {
  slug: string;
  drone_url: string | null;
  room_tone_url: string | null;
  foley_pool: unknown;
  sting_pool: unknown;
  cross_fade_ms: number;
}

export class AudioService {
  static async bed(slug: string): Promise<AmbientBedConfig | null> {
    const normalizedSlug = slug.trim();
    if (normalizedSlug.length === 0) return null;

    const r = await query<AmbientBedConfig>(
      `SELECT slug, drone_url, room_tone_url, foley_pool, sting_pool, cross_fade_ms
         FROM ambient_beds WHERE slug = $1`,
      [normalizedSlug],
    );
    return r.rows[0] ?? null;
  }

  static async beds(): Promise<string[]> {
    const r = await query<{slug: string}>(
      `SELECT slug FROM ambient_beds ORDER BY slug`,
    );
    return r.rows.map(x => x.slug);
  }
}
