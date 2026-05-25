import {BrowserWindow, shell} from 'electron';
import path from 'node:path';
import {installRendererConsoleLogger} from './desktopLogging.js';
import type {DesktopTelemetryRecorder} from './desktopTelemetry.js';

export async function createMainWindow(options: {
  url: string;
  appName: string;
  appPath: string;
  getServerUrl: () => string | null | undefined;
  recordTelemetry: DesktopTelemetryRecorder;
}): Promise<BrowserWindow> {
  const mainWindow = new BrowserWindow({
    title: options.appName,
    fullscreen: true,
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#111827',
    show: false,
    webPreferences: {
      preload: path.join(options.appPath, 'dist', 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    void options.recordTelemetry(options.getServerUrl(), {
      events: [
        {
          schemaName: 'desktop.window_ready',
          eventName: 'window_ready',
          severity: 'info',
          properties: {
            fullscreen: mainWindow.isFullScreen(),
          },
        },
      ],
    });
  });

  mainWindow.webContents.setWindowOpenHandler(({url: targetUrl}) => {
    void shell.openExternal(targetUrl);
    return {action: 'deny'};
  });
  mainWindow.on('unresponsive', () => {
    void options.recordTelemetry(options.getServerUrl(), {
      events: [
        {
          schemaName: 'desktop.window_unresponsive',
          eventName: 'window_unresponsive',
          severity: 'warn',
          properties: {},
        },
      ],
    });
  });
  mainWindow.on('responsive', () => {
    void options.recordTelemetry(options.getServerUrl(), {
      events: [
        {
          schemaName: 'desktop.window_responsive',
          eventName: 'window_responsive',
          severity: 'info',
          properties: {},
        },
      ],
    });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void options.recordTelemetry(options.getServerUrl(), {
      events: [
        {
          schemaName: 'desktop.render_process_gone',
          eventName: 'render_process_gone',
          severity: details.reason === 'clean-exit' ? 'info' : 'error',
          properties: {
            reason: details.reason,
            exit_code: details.exitCode,
          },
        },
      ],
    });
  });
  installRendererConsoleLogger(mainWindow);

  await mainWindow.loadURL(options.url);
  return mainWindow;
}
