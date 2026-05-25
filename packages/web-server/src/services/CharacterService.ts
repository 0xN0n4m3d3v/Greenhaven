/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  POINT_BUY_BUDGET,
  POINT_BUY_COSTS,
  pointBuyCostFor,
  rollFourD6DropLowest,
  SKILLS,
  STANDARD_ARRAY,
  totalPointBuyCost,
  type Ability,
} from '../character/skills.js';
import {qualitySqlPredicate} from '../contentQuality.js';
import {query, withTransaction} from '../db.js';
import {loc} from '../i18n.js';

export interface CharacterMeta {
  skills: typeof SKILLS;
  standard_array: typeof STANDARD_ARRAY;
  point_buy: {
    budget: typeof POINT_BUY_BUDGET;
    costs: typeof POINT_BUY_COSTS;
  };
}

export interface CharacterClassRow {
  id: number;
  display_name: string;
  summary: string | null;
  profile: Record<string, unknown>;
}

export interface CharacterPersonRow {
  id: number;
  name: string;
  portrait_set: Record<string, string | null> | null;
  persona_slug: string | null;
  persona_hue: string | null;
}

export type StatsMethod = 'standard_array' | 'point_buy' | 'rolled';
export type AbilityScores = Record<Ability, number>;

export type CharacterWriteResult =
  | {ok: true}
  | {ok: false; error: string};

export class CharacterService {
  static meta(): CharacterMeta {
    return {
      skills: SKILLS,
      standard_array: STANDARD_ARRAY,
      point_buy: {budget: POINT_BUY_BUDGET, costs: POINT_BUY_COSTS},
    };
  }

  static async listClasses(language: string): Promise<CharacterClassRow[]> {
    const r = await query<{
      id: number;
      display_name: string;
      summary: string | null;
      profile: Record<string, unknown> | null;
      i18n: Record<string, Record<string, unknown>> | null;
    }>(
      `SELECT id, display_name, summary, profile, COALESCE(i18n, '{}'::jsonb) AS i18n
         FROM entities
        WHERE kind = 'class'
        ORDER BY id`,
    );
    return r.rows.map(row => localizeClassRow(row, language));
  }

  static async listOrigins(language: string): Promise<unknown[]> {
    const r = await query<{value: unknown}>(
      `SELECT value FROM cartridge_meta WHERE key = 'origin_templates'`,
    );
    const value = r.rows[0]?.value;
    const origins = Array.isArray(value) ? value : [];
    return origins.map(origin => localizeOriginTemplate(origin, language));
  }

  static async listPersons(): Promise<CharacterPersonRow[]> {
    const r = await query<{
      id: number;
      display_name: string;
      profile: Record<string, unknown> | null;
      persona_slug: string | null;
    }>(
      `SELECT id, display_name, profile, persona_slug
         FROM entities
        WHERE kind = 'person'
          AND ${qualitySqlPredicate('entities')}
        ORDER BY id`,
    );
    return r.rows.map(row => ({
      id: row.id,
      name: row.display_name,
      portrait_set: (row.profile?.['portrait_set'] ?? null) as Record<
        string,
        string | null
      > | null,
      persona_slug: row.persona_slug,
      persona_hue: (row.profile?.['persona_hue'] ?? null) as string | null,
    }));
  }

  static rollStats(): number[] {
    return [0, 0, 0, 0, 0, 0].map(() => rollFourD6DropLowest());
  }

  static async applyStats(
    playerId: number,
    scores: AbilityScores,
    method: StatsMethod,
  ): Promise<CharacterWriteResult> {
    if (method === 'point_buy') {
      for (const value of Object.values(scores)) {
        if (pointBuyCostFor(value) === null) {
          return {
            ok: false,
            error: `point-buy score out of range (8-15): ${value}`,
          };
        }
      }
      const total = totalPointBuyCost(scores);
      if (total > POINT_BUY_BUDGET) {
        return {
          ok: false,
          error: `point-buy budget exceeded: ${total} / ${POINT_BUY_BUDGET}`,
        };
      }
    }

    await withTransaction(async tx => {
      for (const [statKey, score] of Object.entries(scores) as Array<
        [Ability, number]
      >) {
        await tx.query(
          `INSERT INTO player_stats (player_id, stat_key, base, current)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (player_id, stat_key)
           DO UPDATE SET base = EXCLUDED.base, current = EXCLUDED.current`,
          [playerId, statKey, score],
        );
      }
    });
    return {ok: true};
  }

  static async applySkills(
    playerId: number,
    picks: string[],
  ): Promise<CharacterWriteResult> {
    const known = new Set(SKILLS.map(skill => skill.name));
    const seen = new Set<string>();
    for (const pick of picks) {
      if (!known.has(pick)) return {ok: false, error: `unknown skill: ${pick}`};
      if (seen.has(pick)) {
        return {ok: false, error: `duplicate skill: ${pick}`};
      }
      seen.add(pick);
    }

    await withTransaction(async tx => {
      await tx.query(`DELETE FROM player_proficient_skills WHERE player_id = $1`, [
        playerId,
      ]);
      for (const skill of picks) {
        await tx.query(
          `INSERT INTO player_proficient_skills
             (player_id, skill_name, proficiency_level)
           VALUES ($1, $2, 1)`,
          [playerId, skill],
        );
      }
    });
    return {ok: true};
  }
}

function localizeClassRow(
  row: {
    id: number;
    display_name: string;
    summary: string | null;
    profile: Record<string, unknown> | null;
    i18n: Record<string, Record<string, unknown>> | null;
  },
  language: string,
): CharacterClassRow {
  const localizable = {i18n: row.i18n};
  const profile = {...(row.profile ?? {})};
  for (const [key, value] of Object.entries(profile)) {
    if (typeof value === 'string') {
      profile[key] = loc(localizable, language, key, value);
    }
  }
  return {
    id: row.id,
    display_name: row.display_name,
    summary:
      row.summary == null
        ? row.summary
        : loc(localizable, language, 'summary', row.summary),
    profile,
  };
}

function localizeOriginTemplate(origin: unknown, language: string): unknown {
  if (!isRecord(origin)) return origin;
  const localizable = origin as {
    i18n?: Record<string, Record<string, unknown>> | null;
  };
  const label =
    typeof origin['label'] === 'string'
      ? loc(localizable, language, 'label', origin['label'])
      : origin['label'];
  const blurb =
    typeof origin['blurb'] === 'string'
      ? loc(localizable, language, 'blurb', origin['blurb'])
      : origin['blurb'];
  const {i18n: _i18n, ...rest} = origin;
  return {
    ...rest,
    label,
    blurb,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
