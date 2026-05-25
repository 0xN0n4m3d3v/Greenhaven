import { describe, expect, it } from 'vitest';
import {
  buildDepthCapTelemetryPayload,
  DEFAULT_DENSITY_CAPS,
  normalizeDensityCaps,
} from '../../density/index.js';

describe('normalizeDensityCaps', () => {
  it('returns the defaults for an empty / missing meta value', () => {
    expect(normalizeDensityCaps({})).toEqual(DEFAULT_DENSITY_CAPS);
    expect(normalizeDensityCaps(null)).toEqual(DEFAULT_DENSITY_CAPS);
    expect(normalizeDensityCaps(undefined)).toEqual(DEFAULT_DENSITY_CAPS);
    expect(normalizeDensityCaps('not an object')).toEqual(DEFAULT_DENSITY_CAPS);
    expect(normalizeDensityCaps([1, 2, 3])).toEqual(DEFAULT_DENSITY_CAPS);
  });

  it('honors integer overrides per key', () => {
    expect(
      normalizeDensityCaps({
        npcs: 32,
        child_locations: 48,
        scenes: 24,
        events: 24,
        activities: 24,
        quests: 16,
      }),
    ).toEqual({
      npcs: 32,
      child_locations: 48,
      scenes: 24,
      events: 24,
      activities: 24,
      quests: 16,
    });
  });

  it('merges partial overrides with defaults for unspecified keys', () => {
    expect(normalizeDensityCaps({ npcs: 24 })).toEqual({
      ...DEFAULT_DENSITY_CAPS,
      npcs: 24,
    });
    expect(normalizeDensityCaps({ scenes: 18, quests: 12 })).toEqual({
      ...DEFAULT_DENSITY_CAPS,
      scenes: 18,
      quests: 12,
    });
  });

  it('rejects non-positive / non-integer / non-numeric values', () => {
    expect(
      normalizeDensityCaps({
        npcs: 0,
        child_locations: -5,
        scenes: 1.5,
        events: null,
        activities: 'twelve',
        quests: NaN,
      }),
    ).toEqual(DEFAULT_DENSITY_CAPS);
  });

  it('parses numeric strings that match positive integers', () => {
    expect(normalizeDensityCaps({ npcs: '24', scenes: '18' })).toEqual({
      ...DEFAULT_DENSITY_CAPS,
      npcs: 24,
      scenes: 18,
    });
  });

  it('rejects leading-zero / fractional / negative strings', () => {
    expect(
      normalizeDensityCaps({
        npcs: '01',
        scenes: '-3',
        quests: '5.0',
      }),
    ).toEqual(DEFAULT_DENSITY_CAPS);
  });
});

describe('buildDepthCapTelemetryPayload', () => {
  it('returns null when no diagnostic rows were recorded', () => {
    expect(
      buildDepthCapTelemetryPayload({ cartridgeId: 'cart', rows: [] }),
    ).toBeNull();
  });

  it('aggregates a single warn row into one telemetry payload', () => {
    expect(
      buildDepthCapTelemetryPayload({
        cartridgeId: 'cart',
        rows: [{ root_id: 900000, truncated_child_count: 1 }],
      }),
    ).toEqual({
      target_cartridge: 'cart',
      depth_cap: 8,
      warning_count: 1,
      truncated_child_count_total: 1,
      root_ids: [900000],
    });
  });

  it('aggregates multiple warn rows into a single event', () => {
    expect(
      buildDepthCapTelemetryPayload({
        cartridgeId: 'cart',
        rows: [
          { root_id: 1, truncated_child_count: 2 },
          { root_id: 2, truncated_child_count: 3 },
          { root_id: 3, truncated_child_count: 1 },
        ],
      }),
    ).toEqual({
      target_cartridge: 'cart',
      depth_cap: 8,
      warning_count: 3,
      truncated_child_count_total: 6,
      root_ids: [1, 2, 3],
    });
  });

  it('coerces numeric strings returned by node-postgres bigint columns', () => {
    // PG bigint columns surface as strings in node-postgres; the
    // wrapper must coerce them to numbers without dropping precision
    // for the magnitudes that depth-8 topology can plausibly reach.
    expect(
      buildDepthCapTelemetryPayload({
        cartridgeId: 'cart',
        rows: [
          { root_id: '12345', truncated_child_count: '7' },
          { root_id: '67890', truncated_child_count: '4' },
        ],
      }),
    ).toEqual({
      target_cartridge: 'cart',
      depth_cap: 8,
      warning_count: 2,
      truncated_child_count_total: 11,
      root_ids: [12345, 67890],
    });
  });

  it('treats a null truncated_child_count as zero', () => {
    expect(
      buildDepthCapTelemetryPayload({
        cartridgeId: 'cart',
        rows: [{ root_id: 1, truncated_child_count: null }],
      }),
    ).toEqual({
      target_cartridge: 'cart',
      depth_cap: 8,
      warning_count: 1,
      truncated_child_count_total: 0,
      root_ids: [1],
    });
  });
});
