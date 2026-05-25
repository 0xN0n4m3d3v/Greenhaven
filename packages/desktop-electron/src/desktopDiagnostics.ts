import {app, crashReporter, ipcMain, netLog} from 'electron';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import type {DesktopDiagnosticsPaths} from './desktopPaths.js';
import type {DesktopTelemetryRecorder} from './desktopTelemetry.js';

type ActiveNetLog = {
  path: string;
  startedAt: string;
  traceId: string;
};

export function installLocalCrashReporter(
  paths: DesktopDiagnosticsPaths,
  appName: string,
): void {
  try {
    app.setPath('crashDumps', paths.crashDir);
    crashReporter.start({
      uploadToServer: false,
      compress: false,
      productName: appName,
      companyName: 'GreenHaven',
      extra: {
        greenhaven_desktop: '1',
        telemetry_mode: 'local_only',
      },
    });
    console.log(
      `[greenhaven-desktop] local crash dumps: ${app.getPath('crashDumps')}`,
    );
  } catch (err) {
    console.warn('[greenhaven-desktop] crashReporter setup failed:', err);
  }
}

export function createDesktopDiagnostics(options: {
  getDiagnosticsPaths: () => DesktopDiagnosticsPaths | null;
  getServerUrl: () => string | null | undefined;
  recordTelemetry: DesktopTelemetryRecorder;
}): {
  installDiagnosticsIpc: () => void;
  startDesktopNetLog: (
    reason: string,
    serverUrl?: string | null | undefined,
  ) => Promise<Record<string, unknown>>;
  stopDesktopNetLog: (
    reason: string,
    serverUrl?: string | null | undefined,
  ) => Promise<Record<string, unknown>>;
} {
  let activeNetLog: ActiveNetLog | null = null;

  async function startDesktopNetLog(
    reason: string,
    serverUrl = options.getServerUrl(),
  ): Promise<Record<string, unknown>> {
    const paths = options.getDiagnosticsPaths();
    if (!paths) {
      return {ok: false, error: 'diagnostics_paths_unavailable'};
    }
    if (activeNetLog) {
      return {ok: true, active: true, path: activeNetLog.path};
    }
    const startedAt = new Date().toISOString();
    const traceId = `desktop-netlog-${Date.now()}`;
    const netlogPath = path.join(
      paths.netlogDir,
      `netlog-${startedAt.replace(/[:.]/g, '-')}.json`,
    );
    try {
      await netLog.startLogging(netlogPath, {captureMode: 'default'});
      activeNetLog = {path: netlogPath, startedAt, traceId};
      await options.recordTelemetry(serverUrl, {
        events: [
          {
            schemaName: 'desktop.netlog_started',
            eventName: 'netlog_started',
            severity: 'info',
            properties: {reason},
          },
        ],
      });
      return {ok: true, active: true, path: netlogPath, traceId};
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await options.recordTelemetry(serverUrl, {
        events: [
          {
            schemaName: 'desktop.netlog_failed',
            eventName: 'netlog_failed',
            severity: 'error',
            properties: {reason, error: message},
          },
        ],
      });
      return {ok: false, error: message};
    }
  }

  async function stopDesktopNetLog(
    reason: string,
    serverUrl = options.getServerUrl(),
  ): Promise<Record<string, unknown>> {
    if (!activeNetLog) {
      return {ok: true, active: false};
    }
    const current = activeNetLog;
    activeNetLog = null;
    const stoppedAt = Date.now();
    const finalPath = current.path;
    try {
      await netLog.stopLogging();
    } catch (err) {
      console.warn('[greenhaven-desktop] netLog stop failed:', err);
    }
    const size = await stat(finalPath)
      .then(s => s.size)
      .catch(() => null);
    await options.recordTelemetry(serverUrl, {
      events: [
        {
          schemaName: 'desktop.netlog_stopped',
          eventName: 'netlog_stopped',
          severity: 'info',
          properties: {
            reason,
            path: finalPath,
            size_bytes: size,
          },
        },
      ],
      spans: [
        {
          name: 'desktop.netlog_capture',
          status: 'ok',
          durationMs:
            stoppedAt - Math.max(0, new Date(current.startedAt).getTime()),
          attributes: {reason},
        },
      ],
      artifacts: [
        {
          artifactType: 'desktop_netlog',
          path: finalPath,
          mimeType: 'application/json',
          redactionTier: 'tier1_local_debug',
          metadata: {
            reason,
            started_at: current.startedAt,
            trace_id: current.traceId,
          },
        },
      ],
    });
    return {ok: true, active: false, path: finalPath, sizeBytes: size};
  }

  function installDiagnosticsIpc(): void {
    ipcMain.handle('greenhaven:diagnostics:get-paths', () =>
      options.getDiagnosticsPaths(),
    );
    ipcMain.handle('greenhaven:diagnostics:start-netlog', () =>
      startDesktopNetLog('renderer_ipc'),
    );
    ipcMain.handle('greenhaven:diagnostics:stop-netlog', () =>
      stopDesktopNetLog('renderer_ipc'),
    );
  }

  return {
    installDiagnosticsIpc,
    startDesktopNetLog,
    stopDesktopNetLog,
  };
}
