import {useCallback, useEffect, useState} from 'react';
import {
  CLIENT_STORAGE_KEYS,
  readClientBoolean,
  writeClientBoolean,
} from '../lib/clientStorage';

const EVENT = 'greenhaven:rail-collapsed-changed';

/**
 * Persisted boolean for the chat-stage rail collapse state.
 *
 * Default: collapsed (true). Players see the icon-bar first; an
 * explicit toggle expands it to the full 220 px widget rail. The
 * choice is stored in clientStorage so it survives reloads.
 */
export function useRailCollapsed(): {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggle: () => void;
} {
  const [collapsed, setCollapsedState] = useState<boolean>(() =>
    readClientBoolean(CLIENT_STORAGE_KEYS.railCollapsed, true),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () =>
      setCollapsedState(
        readClientBoolean(CLIENT_STORAGE_KEYS.railCollapsed, true),
      );
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    writeClientBoolean(CLIENT_STORAGE_KEYS.railCollapsed, next);
    setCollapsedState(next);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(EVENT));
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed(!collapsed);
  }, [collapsed, setCollapsed]);

  return {collapsed, setCollapsed, toggle};
}
