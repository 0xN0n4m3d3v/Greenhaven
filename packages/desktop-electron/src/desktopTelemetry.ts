export type DesktopTelemetryEvent = {
  schemaName?: string;
  eventName: string;
  severity?: string;
  properties?: Record<string, unknown>;
};

export type DesktopTelemetrySpan = {
  name: string;
  status?: string;
  durationMs?: number;
  attributes?: Record<string, unknown>;
};

export type DesktopTelemetryArtifact = {
  artifactType: string;
  path: string;
  mimeType?: string;
  redactionTier?: string;
  metadata?: Record<string, unknown>;
};

export type DesktopTelemetryBatch = {
  events?: DesktopTelemetryEvent[];
  spans?: DesktopTelemetrySpan[];
  artifacts?: DesktopTelemetryArtifact[];
};

export type DesktopTelemetryRecorder = (
  serverUrl: string | null | undefined,
  batch: DesktopTelemetryBatch,
) => Promise<void>;

export function createDesktopTelemetryRecorder(options: {
  traceId: string;
  appVersion: string;
}): DesktopTelemetryRecorder {
  return async (serverUrl, batch) => {
    if (!serverUrl) return;
    try {
      await fetch(new URL('/api/telemetry/desktop', serverUrl), {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          context: {
            traceId: options.traceId,
            appVersion: options.appVersion,
          },
          ...batch,
        }),
      });
    } catch (err) {
      console.warn('[greenhaven-desktop] desktop telemetry post failed:', err);
    }
  };
}
