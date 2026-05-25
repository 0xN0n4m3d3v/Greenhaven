/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const LOCAL_ENV_FILE = 'greenhaven.env';
export const AUTH_SECRET_FILE = 'auth-secret';

const DESKTOP_ENV_KEYS = new Set([
  'AUTH_SECRET',
  'DEEPSEEK_API_KEY',
  'FEATHERLESS_API_KEY',
  'GREENHAVEN_DESKTOP_NETLOG',
]);
const API_KEY_ENV_KEYS = new Set(['DEEPSEEK_API_KEY']);
const MAX_LOCAL_SECRET_LENGTH = 4096;
const INHERITED_ENV_VALUES = new Map(
  Array.from(DESKTOP_ENV_KEYS)
    .map(key => [key, process.env[key]] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
);

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const equals = trimmed.indexOf('=');
  if (equals <= 0) return null;
  const key = trimmed.slice(0, equals).trim();
  if (!/^[A-Z0-9_]+$/.test(key) || !DESKTOP_ENV_KEYS.has(key)) return null;

  let value = trimmed.slice(equals + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

async function readLocalEnvRaw(configDir: string): Promise<string> {
  try {
    return await readFile(path.join(configDir, LOCAL_ENV_FILE), 'utf8');
  } catch {
    return '';
  }
}

async function readLocalEnvValue(
  configDir: string,
  key: string,
): Promise<string | null> {
  const raw = await readLocalEnvRaw(configDir);
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed?.[0] === key && parsed[1]) return parsed[1];
  }
  return null;
}

function normalizeLocalSecret(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (normalized.length > MAX_LOCAL_SECRET_LENGTH) {
    throw new Error('local_secret_too_long');
  }
  return normalized;
}

function restoreInheritedEnvValue(key: string): void {
  const inherited = INHERITED_ENV_VALUES.get(key);
  if (inherited) {
    process.env[key] = inherited;
    return;
  }
  delete process.env[key];
}

export async function writeLocalEnvValue(
  configDir: string,
  key: string,
  rawValue: unknown,
): Promise<void> {
  if (!API_KEY_ENV_KEYS.has(key)) {
    throw new Error(`unsupported_local_env_key:${key}`);
  }
  const value = normalizeLocalSecret(rawValue);
  await mkdir(configDir, {recursive: true});
  const envPath = path.join(configDir, LOCAL_ENV_FILE);
  const raw = await readLocalEnvRaw(configDir);
  const lines = raw.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const retained = lines.filter(line => parseEnvLine(line)?.[0] !== key);
  if (value) retained.push(`${key}=${value}`);

  const next = retained.length > 0 ? `${retained.join('\n')}\n` : '';
  await writeFile(envPath, next, {encoding: 'utf8', mode: 0o600});

  if (value) {
    process.env[key] = value;
  } else {
    restoreInheritedEnvValue(key);
  }
}

export async function getApiKeyStatus(
  configDir: string,
  key: string,
): Promise<{saved: boolean; source: 'local' | 'environment' | 'none'}> {
  const localValue = await readLocalEnvValue(configDir, key);
  if (localValue) return {saved: true, source: 'local'};
  if (process.env[key]) return {saved: true, source: 'environment'};
  return {saved: false, source: 'none'};
}

export async function loadLocalEnv(configDir: string): Promise<void> {
  const envPath = path.join(configDir, LOCAL_ENV_FILE);
  let raw: string;
  try {
    raw = await readFile(envPath, 'utf8');
  } catch {
    return;
  }

  const loaded: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key]) continue;
    process.env[key] = value;
    loaded.push(key);
  }
  if (loaded.length > 0) {
    console.log(
      `[greenhaven-desktop] loaded local config keys: ${loaded.join(', ')}`,
    );
  }
}

export async function loadOrCreateAuthSecret(
  configDir: string,
): Promise<string> {
  const secretPath = path.join(configDir, AUTH_SECRET_FILE);
  try {
    const existing = (await readFile(secretPath, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Create below.
  }

  const secret = randomBytes(48).toString('base64url');
  await writeFile(secretPath, `${secret}\n`, {encoding: 'utf8', mode: 0o600});
  console.log('[greenhaven-desktop] created local auth secret');
  return secret;
}
