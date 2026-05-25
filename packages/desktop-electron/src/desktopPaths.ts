/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdir} from 'node:fs/promises';
import path from 'node:path';

export type DesktopDiagnosticsPaths = {
  dataRoot: string;
  logDir: string;
  telemetryRoot: string;
  artifactRoot: string;
  crashDir: string;
  netlogDir: string;
  logPath: string;
};

export function isPortableDataMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env['GREENHAVEN_PORTABLE_DATA'] === '1';
}

export function resolveDesktopDataRoot(options: {
  userDataPath: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (isPortableDataMode(options.env ?? process.env)) {
    return path.join(
      path.dirname(options.execPath ?? process.execPath),
      'GreenHavenData',
    );
  }
  return options.userDataPath;
}

export async function ensureDataFolders(dataRoot: string): Promise<void> {
  for (const folder of [
    'pgdata',
    'config',
    'saves',
    'logs',
    'backups',
    'cartridges',
  ]) {
    await mkdir(path.join(dataRoot, folder), {recursive: true});
  }
  const artifactRoot = path.join(dataRoot, 'telemetry', 'artifacts');
  for (const folder of [
    'bundles',
    'traces',
    'profiles',
    'heap',
    'netlog',
    'replay',
    'screenshots',
    'crashes',
    'logs',
    'misc',
  ]) {
    await mkdir(path.join(artifactRoot, folder), {recursive: true});
  }
}

export function buildDiagnosticsPaths(
  dataRoot: string,
): DesktopDiagnosticsPaths {
  const logDir = path.join(dataRoot, 'logs');
  const telemetryRoot = path.join(dataRoot, 'telemetry');
  const artifactRoot = path.join(telemetryRoot, 'artifacts');
  return {
    dataRoot,
    logDir,
    telemetryRoot,
    artifactRoot,
    crashDir: path.join(artifactRoot, 'crashes'),
    netlogDir: path.join(artifactRoot, 'netlog'),
    logPath: path.join(logDir, 'desktop.log'),
  };
}
