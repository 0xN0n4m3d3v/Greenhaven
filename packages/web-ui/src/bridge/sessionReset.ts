import {engine} from './platform';
import {
  CLIENT_STORAGE_KEYS,
  clearGreenhavenStorage,
  clearStoredPlayerIdentity,
  listGreenhavenStorage,
  type GreenhavenStorageEntry,
} from '../lib/clientStorage';
import {clearLocalSessionRuntime} from './turnJobState';

interface SessionResetRuntime {
  source: EventSource;
  state: engine.GameState;
}

export interface SessionResetBridgeDeps {
  getBridge(): Promise<SessionResetRuntime>;
  postJSON<T>(path: string, body?: unknown): Promise<T>;
  resetBootstrap(): void;
}

export interface SessionResetBridgeApi {
  SignOut(): void;
  ListLocalClientStorage(): GreenhavenStorageEntry[];
  ClearLocalClientStorage(opts?: {keepPreferences?: boolean}): string[];
  ResetGame(): Promise<engine.GameState>;
}

const RESET_RELEVANT_KEYS = new Set<string>([
  CLIENT_STORAGE_KEYS.playerPublicId,
  CLIENT_STORAGE_KEYS.sessionId,
]);

const PREFERENCE_KEYS = [
  CLIENT_STORAGE_KEYS.uiLanguage,
  CLIENT_STORAGE_KEYS.modelOverride,
  CLIENT_STORAGE_KEYS.brokerModel,
  CLIENT_STORAGE_KEYS.narratorModel,
  CLIENT_STORAGE_KEYS.audioVolume,
  CLIENT_STORAGE_KEYS.audioMuted,
];

export function createSessionResetBridge(
  deps: SessionResetBridgeDeps,
): SessionResetBridgeApi {
  function clearLocalClientStorage(
    opts: {keepPreferences?: boolean} = {},
  ): string[] {
    const removed = clearGreenhavenStorage({
      keep: opts.keepPreferences ? PREFERENCE_KEYS : [],
    });
    const resetRuntime =
      !opts.keepPreferences || removed.some(key => RESET_RELEVANT_KEYS.has(key));
    if (resetRuntime) {
      deps.resetBootstrap();
      clearLocalSessionRuntime('local storage cleared');
    }
    return removed;
  }

  return {
    SignOut(): void {
      clearStoredPlayerIdentity();
      deps.resetBootstrap();
    },
    ListLocalClientStorage(): GreenhavenStorageEntry[] {
      return listGreenhavenStorage();
    },
    ClearLocalClientStorage: clearLocalClientStorage,
    async ResetGame(): Promise<engine.GameState> {
      const b = await deps.getBridge();
      await deps.postJSON('/player/reset-local-game');
      try {
        b.source.close();
      } catch {
        // Ignore stale EventSource close errors during reset.
      }
      b.state = engine.GameState.createFrom({...b.state, messages: []});
      clearLocalSessionRuntime('local game reset');
      clearLocalClientStorage({keepPreferences: true});
      deps.resetBootstrap();
      return engine.GameState.createFrom(b.state);
    },
  };
}
