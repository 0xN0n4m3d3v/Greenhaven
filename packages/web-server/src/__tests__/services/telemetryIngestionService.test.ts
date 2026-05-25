import { describe, expect, it } from 'vitest';
import {
  TelemetryIngestionService,
  telemetryIngestionServiceInternals as internals,
} from '../../services/TelemetryIngestionService.js';

describe('TelemetryIngestionService.ingestBatch — invalid payloads', () => {
  it('returns 400 for a null body', async () => {
    await expect(
      TelemetryIngestionService.ingestBatch(null, 'frontend'),
    ).resolves.toEqual({
      status: 400,
      body: { error: 'invalid_telemetry_payload' },
    });
  });

  it('returns 400 for a primitive body', async () => {
    await expect(
      TelemetryIngestionService.ingestBatch('not-an-object', 'desktop'),
    ).resolves.toEqual({
      status: 400,
      body: { error: 'invalid_telemetry_payload' },
    });
  });

  it('returns 400 for an array body', async () => {
    await expect(
      TelemetryIngestionService.ingestBatch([{ eventName: 'x' }], 'frontend'),
    ).resolves.toEqual({
      status: 400,
      body: { error: 'invalid_telemetry_payload' },
    });
  });

  it('accepts an empty valid object with accepted=0', async () => {
    await expect(
      TelemetryIngestionService.ingestBatch({}, 'frontend'),
    ).resolves.toEqual({ status: 200, body: { ok: true, accepted: 0 } });
  });
});

describe('TelemetryIngestionService.buildBatch — batch truncation', () => {
  it('caps each section at MAX_BATCH_ITEMS (50)', () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      eventName: `evt-${i}`,
    }));
    const spans = Array.from({ length: 75 }, (_, i) => ({ name: `span-${i}` }));
    const metrics = Array.from({ length: 60 }, (_, i) => ({
      name: `metric-${i}`,
    }));
    const artifacts = Array.from({ length: 55 }, (_, i) => ({
      artifactType: 'log',
      path: `/tmp/file-${i}.log`,
    }));
    const result = internals.buildBatch(
      { events, spans, metrics, artifacts },
      'frontend',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.events.length).toBe(internals.MAX_BATCH_ITEMS);
    expect(result.spans.length).toBe(internals.MAX_BATCH_ITEMS);
    expect(result.metrics.length).toBe(internals.MAX_BATCH_ITEMS);
    expect(result.artifacts.length).toBe(internals.MAX_BATCH_ITEMS);
    expect(result.accepted).toBe(4 * internals.MAX_BATCH_ITEMS);
  });
});

describe('TelemetryIngestionService.buildBatch — context propagation', () => {
  it('falls back to batch context fields when the item omits them', () => {
    const result = internals.buildBatch(
      {
        context: {
          sessionId: 'sess-1',
          playerId: 7,
          traceId: 'trace-batch',
          turnId: 'turn-batch',
        },
        events: [{ eventName: 'evt' }],
      },
      'frontend',
    );
    if (!result.ok) throw new Error('expected ok');
    const event = result.events[0]!;
    expect(event.sessionId).toBe('sess-1');
    expect(event.playerId).toBe(7);
    expect(event.traceId).toBe('trace-batch');
    expect(event.turnId).toBe('turn-batch');
  });

  it('lets item-level fields override the batch context', () => {
    const result = internals.buildBatch(
      {
        context: { traceId: 'trace-batch', turnId: 'turn-batch' },
        events: [
          { eventName: 'evt', traceId: 'trace-item', turnId: 'turn-item' },
        ],
      },
      'frontend',
    );
    if (!result.ok) throw new Error('expected ok');
    const event = result.events[0]!;
    expect(event.traceId).toBe('trace-item');
    expect(event.turnId).toBe('turn-item');
  });
});

describe('TelemetryIngestionService — per-shape sanitization', () => {
  it('skips events without a name and keeps named events', () => {
    const result = internals.buildBatch(
      {
        events: [
          { eventName: 'good' },
          {},
          { eventName: '' },
          { eventName: 'another' },
        ],
      },
      'frontend',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.events.map((e) => e.eventName)).toEqual(['good', 'another']);
    expect(result.accepted).toBe(2);
  });

  it('skips spans/metrics without a name', () => {
    const result = internals.buildBatch(
      {
        spans: [{ name: 'span-keep' }, {}, { name: '   ' }],
        metrics: [{ name: 'metric-keep' }, { name: '' }],
      },
      'desktop',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.spans.map((s) => s.name)).toEqual(['span-keep']);
    expect(result.metrics.map((m) => m.name)).toEqual(['metric-keep']);
  });

  it('skips artifacts missing artifactType or path', () => {
    const result = internals.buildBatch(
      {
        artifacts: [
          { artifactType: 'log', path: '/tmp/x.log' },
          { artifactType: 'log' },
          { path: '/tmp/y.log' },
          {},
        ],
      },
      'desktop',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.path).toBe('/tmp/x.log');
  });

  it('tags items with the batch source', () => {
    const result = internals.buildBatch(
      {
        events: [{ eventName: 'evt' }],
        spans: [{ name: 'span' }],
        metrics: [{ name: 'metric' }],
        artifacts: [{ artifactType: 'log', path: '/tmp/x.log' }],
      },
      'desktop',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.events[0]!.source).toBe('desktop');
    expect(result.spans[0]!.source).toBe('desktop');
    expect(result.metrics[0]!.source).toBe('desktop');
    expect(result.artifacts[0]!.source).toBe('desktop');
  });

  it('defaults schemaName to "<source>.<eventName>" when omitted', () => {
    const result = internals.buildBatch(
      { events: [{ eventName: 'login' }] },
      'frontend',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.events[0]!.schemaName).toBe('frontend.login');
    expect(result.events[0]!.category).toBe('frontend');
  });
});

describe('TelemetryIngestionService — severity / redaction fallback', () => {
  it('falls back to info for missing or unknown severity values', () => {
    expect(internals.cleanSeverity(undefined)).toBe('info');
    expect(internals.cleanSeverity('')).toBe('info');
    expect(internals.cleanSeverity('catastrophic')).toBe('info');
    expect(internals.cleanSeverity('warn')).toBe('warn');
    expect(internals.cleanSeverity('debug')).toBe('debug');
    expect(internals.cleanSeverity('fatal')).toBe('fatal');
  });

  it('falls back to tier1_local_debug for missing/invalid redaction tiers', () => {
    expect(internals.cleanRedactionTier(undefined)).toBeNull();
    expect(internals.cleanRedactionTier('tier99_internal')).toBeNull();
    expect(internals.cleanRedactionTier('tier0_safe')).toBe('tier0_safe');
    const result = internals.buildBatch(
      { events: [{ eventName: 'evt' }] },
      'frontend',
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.events[0]!.redactionTier).toBe('tier1_local_debug');
  });
});

describe('TelemetryIngestionService — JSON sanitization', () => {
  it('truncates strings longer than MAX_STRING', () => {
    const big = 'x'.repeat(internals.MAX_STRING + 500);
    const cleaned = internals.sanitizeJson(big, 0);
    expect(typeof cleaned).toBe('string');
    expect((cleaned as string).length).toBe(internals.MAX_STRING);
  });

  it('caps arrays at MAX_ARRAY entries', () => {
    const arr = Array.from({ length: internals.MAX_ARRAY + 25 }, (_, i) => i);
    const cleaned = internals.sanitizeJson(arr, 0) as number[];
    expect(Array.isArray(cleaned)).toBe(true);
    expect(cleaned.length).toBe(internals.MAX_ARRAY);
  });

  it('replaces values beyond MAX_DEPTH with the [max_depth] marker', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < internals.MAX_DEPTH + 3; i++) {
      nested = { next: nested };
    }
    const cleaned = internals.sanitizeJson(nested, 0);
    let cursor: unknown = cleaned;
    // The marker appears once recursion exceeds MAX_DEPTH, so after
    // MAX_DEPTH+1 successful .next descents the chain terminates.
    for (let i = 0; i < internals.MAX_DEPTH + 1; i++) {
      expect(typeof cursor).toBe('object');
      cursor = (cursor as Record<string, unknown>)['next'];
    }
    expect(cursor).toBe('[max_depth]');
  });

  it('caps object key counts at MAX_OBJECT_KEYS', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < internals.MAX_OBJECT_KEYS + 30; i++) {
      big[`key-${i}`] = i;
    }
    const cleaned = internals.sanitizeJson(big, 0) as Record<string, unknown>;
    expect(Object.keys(cleaned).length).toBe(internals.MAX_OBJECT_KEYS);
  });

  it('drops non-finite numbers to null', () => {
    expect(internals.sanitizeJson(Number.NaN, 0)).toBeNull();
    expect(internals.sanitizeJson(Number.POSITIVE_INFINITY, 0)).toBeNull();
    expect(internals.sanitizeJson(42, 0)).toBe(42);
  });
});

describe('TelemetryIngestionService — accepted-count', () => {
  it('counts only items that survive per-shape sanitization', () => {
    const result = internals.buildBatch(
      {
        events: [{ eventName: 'ok-1' }, {}, { eventName: 'ok-2' }],
        spans: [{ name: 'span-ok' }, { name: '' }],
        metrics: [{ name: 'metric-ok' }],
        artifacts: [
          { artifactType: 'log', path: '/tmp/x.log' },
          { artifactType: 'log' },
        ],
      },
      'frontend',
    );
    if (!result.ok) throw new Error('expected ok');
    // 2 events + 1 span + 1 metric + 1 artifact = 5
    expect(result.accepted).toBe(5);
  });
});
