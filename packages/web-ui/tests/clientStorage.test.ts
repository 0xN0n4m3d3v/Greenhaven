import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  CLIENT_STORAGE_KEYS,
  readAudioSettings,
  writeAudioVolume,
} from '../src/lib/clientStorage';

function installStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  const storage = {
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      map.delete(key);
    }),
    clear: vi.fn(() => {
      map.clear();
    }),
    key: vi.fn((index: number) => Array.from(map.keys())[index] ?? null),
  };
  Object.defineProperty(storage, 'length', {
    get: () => map.size,
  });
  vi.stubGlobal('localStorage', storage);
  return {map, storage};
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('audio client storage', () => {
  it('defaults master volume to 75%', () => {
    installStorage();

    expect(readAudioSettings()).toEqual({volume: 0.75, muted: false});
  });

  it('treats a stale stored zero as the 75% default', () => {
    installStorage({
      [CLIENT_STORAGE_KEYS.audioVolume]: '0',
    });

    expect(readAudioSettings()).toEqual({volume: 0.75, muted: false});
  });

  it('keeps explicit mute separate from volume', () => {
    installStorage({
      [CLIENT_STORAGE_KEYS.audioVolume]: '0',
      [CLIENT_STORAGE_KEYS.audioMuted]: 'true',
    });

    expect(readAudioSettings()).toEqual({volume: 0.75, muted: true});
  });

  it('does not persist future volume writes below the audible floor', () => {
    const {map} = installStorage();

    writeAudioVolume(0);

    expect(map.get(CLIENT_STORAGE_KEYS.audioVolume)).toBe('0.01');
  });
});
