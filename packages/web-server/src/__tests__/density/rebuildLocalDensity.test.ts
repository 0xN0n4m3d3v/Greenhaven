import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryState = vi.hoisted(() => ({
  responses: [] as Array<(sql: string, params?: unknown[]) => unknown>,
  calls: [] as Array<{ sql: string; params: unknown[] | undefined }>,
}));

const telemetryState = vi.hoisted(() => ({
  events: [] as unknown[],
}));

vi.mock('../../db.js', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    queryState.calls.push({ sql, params });
    const handler = queryState.responses.shift();
    if (!handler) {
      throw new Error(
        `unmocked query: ${sql.slice(0, 80)}${sql.length > 80 ? '...' : ''}`,
      );
    }
    return handler(sql, params);
  }),
}));

vi.mock('../../cartridge.js', () => ({
  getMeta: vi.fn(async () => null),
}));

vi.mock('../../cartridgeScope.js', () => ({
  activeCartridgeId: vi.fn(async () => 'grinhaven-full'),
}));

vi.mock('../../telemetry/index.js', () => ({
  telemetry: {
    record: vi.fn((event: unknown) => {
      telemetryState.events.push(event);
    }),
    flush: vi.fn(async () => {}),
    pendingCount: vi.fn(() => 0),
  },
}));

import { rebuildLocalDensity } from '../../density/index.js';

function queueQuery(handler: (sql: string, params?: unknown[]) => unknown) {
  queryState.responses.push(handler);
}

function rebuildRowsResponse() {
  return {
    rows: [
      { location_id: 1, npc_count: 0, child_count: 0 },
      { location_id: 2, npc_count: 1, child_count: 2 },
    ],
    rowCount: 2,
  };
}

beforeEach(() => {
  queryState.responses.length = 0;
  queryState.calls.length = 0;
  telemetryState.events.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rebuildLocalDensity diagnostics resilience', () => {
  it('still runs the rebuild when the pre-rebuild diagnostics snapshot fails', async () => {
    queueQuery(() => {
      throw Object.assign(
        new Error('relation "migration_diagnostics" does not exist'),
        { code: '42P01' },
      );
    });
    const rebuildResult = rebuildRowsResponse();
    queueQuery(() => rebuildResult);

    const result = await rebuildLocalDensity({ cartridgeId: 'cart-a' });

    expect(result).toEqual(rebuildResult.rows);
    expect(queryState.calls.length).toBe(2);
    expect(queryState.calls[0]!.sql).toContain('MAX(id)');
    expect(queryState.calls[1]!.sql).toContain('rebuild_local_density(');
    // X-3/X-4 follow-up #12 — the pre-snapshot failure now records a
    // structured gameplay telemetry event before falling back. No
    // `gameplay:density_depth_cap_hit` event is emitted because we
    // still cannot safely isolate which warn rows belong to this call.
    expect(telemetryState.events).toHaveLength(1);
    expect(telemetryState.events[0]).toMatchObject({
      channel: 'gameplay',
      name: 'density.depth_cap_diagnostic_failed',
      data: {cartridgeId: 'cart-a', stage: 'pre_snapshot'},
    });
  });

  it('still returns rebuild rows when the post-rebuild diagnostics query fails', async () => {
    queueQuery(() => ({ rows: [{ max_id: 0 }], rowCount: 1 }));
    const rebuildResult = rebuildRowsResponse();
    queueQuery(() => rebuildResult);
    queueQuery(() => {
      throw Object.assign(
        new Error('relation "migration_diagnostics" does not exist'),
        { code: '42P01' },
      );
    });

    const result = await rebuildLocalDensity({ cartridgeId: 'cart-a' });

    expect(result).toEqual(rebuildResult.rows);
    expect(queryState.calls.length).toBe(3);
    // X-3/X-4 follow-up #12 — the post-rebuild diagnostics failure now
    // records a structured gameplay telemetry event before falling
    // back. Rebuild rows still return so callers stay unaffected.
    expect(telemetryState.events).toHaveLength(1);
    expect(telemetryState.events[0]).toMatchObject({
      channel: 'gameplay',
      name: 'density.depth_cap_telemetry_failed',
      data: {cartridgeId: 'cart-a', stage: 'post_rebuild_emit'},
    });
  });

  it('emits exactly one telemetry event when post-rebuild diagnostics returns warn rows', async () => {
    queueQuery(() => ({ rows: [{ max_id: 100 }], rowCount: 1 }));
    const rebuildResult = rebuildRowsResponse();
    queueQuery(() => rebuildResult);
    queueQuery(() => ({
      rows: [
        { root_id: '900000', truncated_child_count: '1' },
        { root_id: '900100', truncated_child_count: '3' },
      ],
      rowCount: 2,
    }));

    const result = await rebuildLocalDensity({ cartridgeId: 'cart-a' });

    expect(result).toEqual(rebuildResult.rows);
    expect(telemetryState.events).toHaveLength(1);
    expect(telemetryState.events[0]).toEqual({
      channel: 'gameplay',
      name: 'gameplay:density_depth_cap_hit',
      data: {
        target_cartridge: 'cart-a',
        depth_cap: 8,
        warning_count: 2,
        truncated_child_count_total: 4,
        root_ids: [900000, 900100],
      },
    });
  });

  it('emits no telemetry when post-rebuild diagnostics returns no warn rows', async () => {
    queueQuery(() => ({ rows: [{ max_id: 0 }], rowCount: 1 }));
    const rebuildResult = rebuildRowsResponse();
    queueQuery(() => rebuildResult);
    queueQuery(() => ({ rows: [], rowCount: 0 }));

    const result = await rebuildLocalDensity({ cartridgeId: 'cart-a' });

    expect(result).toEqual(rebuildResult.rows);
    expect(telemetryState.events).toEqual([]);
  });

  it('lets the underlying rebuild SQL failure propagate', async () => {
    queueQuery(() => ({ rows: [{ max_id: 0 }], rowCount: 1 }));
    queueQuery(() => {
      throw new Error('boom: rebuild_local_density crashed');
    });

    await expect(
      rebuildLocalDensity({ cartridgeId: 'cart-a' }),
    ).rejects.toThrow(/boom: rebuild_local_density crashed/);
    // Post-rebuild diagnostics query is never reached when the
    // rebuild itself failed.
    expect(queryState.calls.length).toBe(2);
  });
});
