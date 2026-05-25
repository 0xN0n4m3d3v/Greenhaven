export const GREENHAVEN_STORAGE_PREFIX = 'greenhaven.';

export const CLIENT_STORAGE_KEYS = {
  playerPublicId: 'greenhaven.playerPublicId',
  sessionId: 'greenhaven.sessionId',
  uiLanguage: 'greenhaven.uiLanguage',
  modelOverride: 'greenhaven.modelOverride',
  brokerModel: 'greenhaven.brokerModel',
  narratorModel: 'greenhaven.narratorModel',
  audioVolume: 'greenhaven.audio.volume',
  audioMuted: 'greenhaven.audio.muted',
  entitlementNsfw: 'greenhaven.entitlement.nsfw_2026',
  railCollapsed: 'greenhaven.rail.collapsed',
} as const;

export type ClientStorageKey =
  (typeof CLIENT_STORAGE_KEYS)[keyof typeof CLIENT_STORAGE_KEYS];

export interface GreenhavenStorageEntry {
  key: string;
  value: string;
}

export interface AudioSettings {
  volume: number;
  muted: boolean;
}

const DEFAULT_AUDIO_SETTINGS: AudioSettings = {volume: 0.75, muted: false};
const MIN_PERSISTED_AUDIO_VOLUME = 0.01;

function getLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && 'localStorage' in window) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    return null;
  }
  return null;
}

export function readClientStorage(key: ClientStorageKey): string | null {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    const value = storage.getItem(key);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeClientStorage(
  key: ClientStorageKey,
  value: string | null | undefined,
): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    if (value == null || value.length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, value);
    }
  } catch {
    // Browsers can reject storage writes in private/sandboxed contexts.
  }
}

export function removeClientStorage(key: ClientStorageKey): boolean {
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function removeMany(keys: readonly ClientStorageKey[]): string[] {
  const removed: string[] = [];
  for (const key of keys) {
    if (removeClientStorage(key)) removed.push(key);
  }
  return removed;
}

export function readClientBoolean(
  key: ClientStorageKey,
  fallback: boolean,
): boolean {
  const value = readClientStorage(key);
  if (value == null) return fallback;
  return value === 'true';
}

export function writeClientBoolean(key: ClientStorageKey, value: boolean): void {
  writeClientStorage(key, value ? 'true' : 'false');
}

export function readClientNumber(
  key: ClientStorageKey,
  opts: {fallback: number; min?: number; max?: number},
): number {
  const parsed = Number(readClientStorage(key));
  if (!Number.isFinite(parsed)) return opts.fallback;
  if (opts.min != null && parsed < opts.min) return opts.fallback;
  if (opts.max != null && parsed > opts.max) return opts.fallback;
  return parsed;
}

export function writeClientNumber(
  key: ClientStorageKey,
  value: number,
  opts: {min?: number; max?: number} = {},
): void {
  if (!Number.isFinite(value)) return;
  const min = opts.min ?? Number.NEGATIVE_INFINITY;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const bounded = Math.min(max, Math.max(min, value));
  writeClientStorage(key, String(bounded));
}

export function readStoredPlayerPublicId(): string | null {
  return readClientStorage(CLIENT_STORAGE_KEYS.playerPublicId);
}

export function writeStoredPlayerPublicId(id: string): void {
  writeClientStorage(CLIENT_STORAGE_KEYS.playerPublicId, id);
}

export function readStoredSessionId(): string | null {
  return readClientStorage(CLIENT_STORAGE_KEYS.sessionId);
}

export function writeStoredSessionId(id: string): void {
  writeClientStorage(CLIENT_STORAGE_KEYS.sessionId, id);
}

export function clearStoredSessionId(): string[] {
  return removeMany([CLIENT_STORAGE_KEYS.sessionId]);
}

export function clearStoredPlayerIdentity(): string[] {
  return removeMany([
    CLIENT_STORAGE_KEYS.playerPublicId,
    CLIENT_STORAGE_KEYS.sessionId,
  ]);
}

export function readAudioSettings(
  defaults: AudioSettings = DEFAULT_AUDIO_SETTINGS,
): AudioSettings {
  const storedVolume = readClientStorage(CLIENT_STORAGE_KEYS.audioVolume);
  const parsedVolume = storedVolume == null ? Number.NaN : Number(storedVolume);
  const fallbackVolume =
    Number.isFinite(defaults.volume) &&
    defaults.volume >= MIN_PERSISTED_AUDIO_VOLUME &&
    defaults.volume <= 1
      ? defaults.volume
      : DEFAULT_AUDIO_SETTINGS.volume;

  return {
    volume:
      Number.isFinite(parsedVolume) &&
      parsedVolume >= MIN_PERSISTED_AUDIO_VOLUME &&
      parsedVolume <= 1
        ? parsedVolume
        : fallbackVolume,
    muted: readClientBoolean(CLIENT_STORAGE_KEYS.audioMuted, defaults.muted),
  };
}

export function writeAudioVolume(volume: number): void {
  writeClientNumber(CLIENT_STORAGE_KEYS.audioVolume, volume, {
    min: MIN_PERSISTED_AUDIO_VOLUME,
    max: 1,
  });
}

export function writeAudioMuted(muted: boolean): void {
  writeClientBoolean(CLIENT_STORAGE_KEYS.audioMuted, muted);
}

export function listGreenhavenStorage(): GreenhavenStorageEntry[] {
  const storage = getLocalStorage();
  if (!storage) return [];
  const entries: GreenhavenStorageEntry[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(GREENHAVEN_STORAGE_PREFIX)) continue;
      entries.push({key, value: storage.getItem(key) ?? ''});
    }
  } catch {
    return [];
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

export function clearGreenhavenStorage(
  opts: {keep?: readonly string[]} = {},
): string[] {
  const storage = getLocalStorage();
  if (!storage) return [];
  const keep = new Set(opts.keep ?? []);
  const keys = listGreenhavenStorage()
    .map(entry => entry.key)
    .filter(key => !keep.has(key));
  const removed: string[] = [];
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removed.push(key);
    } catch {
      // Keep clearing the rest.
    }
  }
  return removed;
}
