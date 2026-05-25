import {useEffect} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import {EventsOn} from '../bridge/platform';

// FEAT-ENGINE-BASELINE-6 corrective (2026-05-17) — the global
// `resetting` UI flag was removed alongside the in-game New Game
// path. This hook now just clears transient session UI + drops the
// busy flag when the server emits `session:reset` (e.g. from a
// per-hero playthrough new-game, or a dev-tools reset).
export function useSessionResetUi(
  clearTransientSessionUi: () => void,
  setBusy: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    const off = EventsOn('session:reset', () => {
      clearTransientSessionUi();
      setBusy(false);
    });
    return () => off();
  }, [clearTransientSessionUi, setBusy]);
}
