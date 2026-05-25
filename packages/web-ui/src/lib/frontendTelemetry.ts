import {
  CLIENT_STORAGE_KEYS,
  readClientStorage,
} from './clientStorage';

type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
type RedactionTier = 'tier0_safe' | 'tier1_local_debug' | 'tier2_sensitive_local';

interface FrontendContext {
  sessionId?: string | null;
  playerId?: number | null;
  turnId?: string | null;
  traceId?: string | null;
}

interface FrontendEvent {
  schemaName: string;
  schemaVersion?: number;
  category: string;
  eventName: string;
  severity: Severity;
  occurredAt?: string;
  properties?: Record<string, unknown>;
  redactionTier?: RedactionTier;
  turnId?: string | null;
  traceId?: string | null;
}

interface FrontendSpan {
  name: string;
  kind?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number | null;
  attributes?: Record<string, unknown>;
  error?: string | null;
  redactionTier?: RedactionTier;
  turnId?: string | null;
  traceId?: string | null;
}

interface FrontendMetric {
  name: string;
  unit?: string;
  aggregation?: string;
  count?: number;
  sum?: number | null;
  min?: number | null;
  max?: number | null;
  attributes?: Record<string, unknown>;
  turnId?: string | null;
  traceId?: string | null;
}

const ENDPOINT = '/api/telemetry/frontend';
const MAX_QUEUE = 100;
const FLUSH_DELAY_MS = 1000;

let context: FrontendContext = {};
let initialized = false;
let timer: number | null = null;
let flushing = false;
const events: FrontendEvent[] = [];
const spans: FrontendSpan[] = [];
const metrics: FrontendMetric[] = [];
const observers: PerformanceObserver[] = [];

export function setFrontendTelemetryContext(next: FrontendContext): void {
  context = {...context, ...next};
}

export function initFrontendTelemetry(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  recordFrontendEvent('info', 'app_boot', 'Frontend telemetry initialized', {
    userAgent: navigator.userAgent,
    language: navigator.language,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
  });
  initNavigationTelemetry();
  initPaintTelemetry();
  initLongTaskTelemetry();
  window.addEventListener('pagehide', () => {
    void flushFrontendTelemetry({beacon: true});
  });
}

export function recordFrontendEvent(
  severity: Severity,
  eventName: string,
  message: string,
  properties: Record<string, unknown> = {},
  opts: {category?: string; turnId?: string | null; traceId?: string | null; redactionTier?: RedactionTier} = {},
): void {
  enqueue('event', {
    schemaName: `frontend.${eventName}`,
    schemaVersion: 1,
    category: opts.category ?? (severity === 'error' || severity === 'fatal' ? 'error' : 'frontend'),
    eventName,
    severity,
    occurredAt: new Date().toISOString(),
    turnId: opts.turnId,
    traceId: opts.traceId,
    redactionTier: opts.redactionTier ?? (severity === 'error' ? 'tier1_local_debug' : 'tier0_safe'),
    properties: sanitizeProperties({
      message,
      ...properties,
    }),
  });
}

export function recordFrontendSpan(span: FrontendSpan): void {
  enqueue('span', {
    kind: 'internal',
    status: 'ok',
    redactionTier: 'tier0_safe',
    ...span,
    attributes: sanitizeProperties(span.attributes ?? {}),
  });
}

export function recordFrontendMetric(metric: FrontendMetric): void {
  enqueue('metric', {
    aggregation: 'raw',
    count: 1,
    ...metric,
    attributes: sanitizeProperties(metric.attributes ?? {}),
  });
}

export async function flushFrontendTelemetry(
  opts: {beacon?: boolean} = {},
): Promise<void> {
  if (flushing || (events.length === 0 && spans.length === 0 && metrics.length === 0)) {
    return;
  }
  flushing = true;
  if (timer != null) {
    window.clearTimeout(timer);
    timer = null;
  }
  const payload = JSON.stringify({
    context: buildContext(),
    events: events.splice(0, events.length),
    spans: spans.splice(0, spans.length),
    metrics: metrics.splice(0, metrics.length),
  });
  try {
    if (opts.beacon && navigator.sendBeacon) {
      const ok = navigator.sendBeacon(
        ENDPOINT,
        new Blob([payload], {type: 'application/json'}),
      );
      if (ok) return;
    }
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: payload,
      credentials: 'include',
      keepalive: payload.length < 60_000,
    });
  } catch {
    // Telemetry must never affect gameplay or UI responsiveness.
  } finally {
    flushing = false;
  }
}

function enqueue(kind: 'event' | 'span' | 'metric', value: FrontendEvent | FrontendSpan | FrontendMetric): void {
  if (kind === 'event') events.push(value as FrontendEvent);
  else if (kind === 'span') spans.push(value as FrontendSpan);
  else metrics.push(value as FrontendMetric);

  while (events.length + spans.length + metrics.length > MAX_QUEUE) {
    if (events.length > 0) events.shift();
    else if (spans.length > 0) spans.shift();
    else metrics.shift();
  }
  if (events.length + spans.length + metrics.length >= 10) {
    void flushFrontendTelemetry();
    return;
  }
  if (timer == null) {
    timer = window.setTimeout(() => {
      timer = null;
      void flushFrontendTelemetry();
    }, FLUSH_DELAY_MS);
  }
}

function buildContext(): FrontendContext {
  return {
    ...context,
    sessionId: context.sessionId ?? readClientStorage(CLIENT_STORAGE_KEYS.sessionId),
    traceId:
      context.traceId ??
      context.turnId ??
      readClientStorage(CLIENT_STORAGE_KEYS.sessionId) ??
      'frontend',
  };
}

function initNavigationTelemetry(): void {
  window.addEventListener('load', () => {
    const entry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (!entry) return;
    recordFrontendSpan({
      name: 'frontend.navigation',
      startedAt: new Date(performance.timeOrigin).toISOString(),
      endedAt: new Date(performance.timeOrigin + entry.duration).toISOString(),
      durationMs: Math.round(entry.duration),
      attributes: {
        dom_content_loaded_ms: Math.round(entry.domContentLoadedEventEnd),
        load_event_ms: Math.round(entry.loadEventEnd),
        response_end_ms: Math.round(entry.responseEnd),
        transfer_size: entry.transferSize,
      },
    });
  }, {once: true});
}

function initPaintTelemetry(): void {
  observePerformance(['paint'], list => {
    for (const entry of list.getEntries()) {
      recordFrontendMetric({
        name: `frontend.${entry.name.replace(/-/g, '_')}`,
        unit: 'ms',
        sum: Math.round(entry.startTime),
        attributes: {entry_type: entry.entryType},
      });
    }
  });
}

function initLongTaskTelemetry(): void {
  observePerformance(['longtask'], list => {
    for (const entry of list.getEntries()) {
      recordFrontendSpan({
        name: 'frontend.long_task',
        status: entry.duration >= 250 ? 'warn' : 'ok',
        startedAt: new Date(performance.timeOrigin + entry.startTime).toISOString(),
        endedAt: new Date(performance.timeOrigin + entry.startTime + entry.duration).toISOString(),
        durationMs: Math.round(entry.duration),
        attributes: {
          entry_type: entry.entryType,
          name: entry.name,
        },
      });
    }
  });
}

function observePerformance(
  entryTypes: string[],
  callback: PerformanceObserverCallback,
): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver(callback);
    observer.observe({entryTypes});
    observers.push(observer);
  } catch {
    // Unsupported entry type in this runtime.
  }
}

function sanitizeProperties(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeJson(value, 0) as Record<string, unknown>;
}

function sanitizeJson(value: unknown, depth: number): unknown {
  if (depth > 5) return '[max_depth]';
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 1200);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 80)) {
      out[key.slice(0, 160)] = sanitizeJson(nested, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 1200);
}
