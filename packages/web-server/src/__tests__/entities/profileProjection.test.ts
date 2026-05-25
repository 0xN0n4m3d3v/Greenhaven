import { describe, expect, it } from 'vitest';
import { projectEntityNormalizedColumns } from '../../entities/profileProjection.js';

describe('projectEntityNormalizedColumns', () => {
  it('extracts cartridge_id from profile.cartridge_id when present', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: { cartridge_id: 'grinhaven-full' },
        tags: [],
      }).cartridge_id,
    ).toBe('grinhaven-full');
  });

  it('returns null cartridge_id for missing, empty, or non-string values', () => {
    expect(
      projectEntityNormalizedColumns({ profile: {}, tags: [] }).cartridge_id,
    ).toBeNull();
    expect(
      projectEntityNormalizedColumns({
        profile: { cartridge_id: '' },
        tags: [],
      }).cartridge_id,
    ).toBeNull();
    expect(
      projectEntityNormalizedColumns({
        profile: { cartridge_id: '   ' },
        tags: [],
      }).cartridge_id,
    ).toBeNull();
    expect(
      projectEntityNormalizedColumns({
        profile: { cartridge_id: 42 },
        tags: [],
      }).cartridge_id,
    ).toBeNull();
  });

  it('trims whitespace around cartridge_id to match update_entity SQL behavior', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: { cartridge_id: '  grinhaven-full  ' },
        tags: [],
      }).cartridge_id,
    ).toBe('grinhaven-full');
    expect(
      projectEntityNormalizedColumns({
        profile: { cartridge_id: '\tsupport-smoke\n' },
        tags: [],
      }).cartridge_id,
    ).toBe('support-smoke');
  });

  it('parses topology_parent_id from numeric profile field', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: 201019 },
        tags: [],
      }).topology_parent_id,
    ).toBe(201019);
  });

  it('parses topology_parent_id from string profile field', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: '201019' },
        tags: [],
      }).topology_parent_id,
    ).toBe(201019);
  });

  it('rejects topology_parent_id values that overflow JS safe-integer or pg bigint range', () => {
    // 2^53 — first JS-unsafe integer; Number(...) would lose precision
    // when passed as $N::bigint, so the helper must reject it.
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: '9007199254740993' },
        tags: [],
      }).topology_parent_id,
    ).toBeNull();
    // 2^64 — well outside pg bigint range.
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: '18446744073709551616' },
        tags: [],
      }).topology_parent_id,
    ).toBeNull();
    // A 30-digit garbage number string — must not throw, must return
    // null instead of relying on Number(...) silently rounding.
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: '999999999999999999999999999999' },
        tags: [],
      }).topology_parent_id,
    ).toBeNull();
    // A JS unsafe integer passed as a number; Number.isSafeInteger
    // catches it before any cast to bigint can drift.
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: 2 ** 53 },
        tags: [],
      }).topology_parent_id,
    ).toBeNull();
    // The largest still-safe integer should pass through.
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: Number.MAX_SAFE_INTEGER },
        tags: [],
      }).topology_parent_id,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects non-integer, zero, negative, or malformed topology_parent_id', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: 0 },
        tags: [],
      }).topology_parent_id,
    ).toBeNull();
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: -5 },
        tags: [],
      }).topology_parent_id,
    ).toBeNull();
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: '1.5' },
        tags: [],
      }).topology_parent_id,
    ).toBeNull();
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: 'not a number' },
        tags: [],
      }).topology_parent_id,
    ).toBeNull();
    expect(
      projectEntityNormalizedColumns({
        profile: { topology_parent_id: null },
        tags: [],
      }).topology_parent_id,
    ).toBeNull();
    expect(
      projectEntityNormalizedColumns({ profile: {}, tags: [] }).topology_parent_id,
    ).toBeNull();
  });

  it('marks dynamic_origin true when profile.origin = dynamic', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: { origin: 'dynamic' },
        tags: [],
      }).dynamic_origin,
    ).toBe(true);
  });

  it('marks dynamic_origin true when tags include dynamic', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: {},
        tags: ['dynamic'],
      }).dynamic_origin,
    ).toBe(true);
    expect(
      projectEntityNormalizedColumns({
        profile: {},
        tags: ['person', 'dynamic', 'live_playtest'],
      }).dynamic_origin,
    ).toBe(true);
  });

  it('marks dynamic_origin false when neither origin nor tags signal dynamic', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: { origin: 'cartridge' },
        tags: ['static', 'authored'],
      }).dynamic_origin,
    ).toBe(false);
    expect(
      projectEntityNormalizedColumns({ profile: {}, tags: [] }).dynamic_origin,
    ).toBe(false);
  });

  it('handles missing profile and tags gracefully', () => {
    expect(projectEntityNormalizedColumns({})).toEqual({
      cartridge_id: null,
      topology_parent_id: null,
      dynamic_origin: false,
    });
  });

  it('returns a full projection for a typical dynamic spawn', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: { origin: 'dynamic', topology_parent_id: 201019 },
        tags: ['dynamic', 'location'],
      }),
    ).toEqual({
      cartridge_id: null,
      topology_parent_id: 201019,
      dynamic_origin: true,
    });
  });

  it('returns a full projection for a cartridge-author entity', () => {
    expect(
      projectEntityNormalizedColumns({
        profile: {
          cartridge_id: 'grinhaven-full',
          topology_parent_id: '201019',
        },
        tags: ['location', 'grinhaven-full'],
      }),
    ).toEqual({
      cartridge_id: 'grinhaven-full',
      topology_parent_id: 201019,
      dynamic_origin: false,
    });
  });
});
