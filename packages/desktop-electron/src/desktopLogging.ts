/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BrowserWindow} from 'electron';
import {appendFile} from 'node:fs/promises';
import path from 'node:path';

let fileLoggingInstalled = false;

function formatLogArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function installFileLogger(logDir: string): string {
  const logPath = path.join(logDir, 'desktop.log');
  if (fileLoggingInstalled) return logPath;
  fileLoggingInstalled = true;

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const write = (level: string, args: unknown[]) => {
    const line = `${new Date().toISOString()} ${level} ${args
      .map(formatLogArg)
      .join(' ')}\n`;
    void appendFile(logPath, line, 'utf8').catch(() => undefined);
  };

  console.log = (...args: unknown[]) => {
    write('INFO', args);
    original.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    write('WARN', args);
    original.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    write('ERROR', args);
    original.error(...args);
  };

  process.on('uncaughtException', err => {
    console.error('[greenhaven-desktop] uncaught exception:', err);
  });
  process.on('unhandledRejection', reason => {
    console.error('[greenhaven-desktop] unhandled rejection:', reason);
  });

  console.log(`[greenhaven-desktop] log file: ${logPath}`);
  return logPath;
}

function rendererConsoleLevel(level: number | string): string {
  if (typeof level === 'string') {
    return level === 'warning' ? 'warn' : level;
  }
  switch (level) {
    case 3:
      return 'error';
    case 2:
      return 'warn';
    case 1:
      return 'info';
    default:
      return 'verbose';
  }
}

export function installRendererConsoleLogger(window: BrowserWindow): void {
  window.webContents.on('console-message', details => {
    const source = details.sourceId
      ? `${path.basename(details.sourceId)}:${details.lineNumber}`
      : `line:${details.lineNumber}`;
    console.log(
      `[renderer:${rendererConsoleLevel(details.level)}] ${details.message} (${source})`,
    );
  });
}
