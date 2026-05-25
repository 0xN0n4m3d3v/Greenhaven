import {useCallback, useEffect, useState} from 'react';
import {
  CLIENT_STORAGE_KEYS,
  readClientBoolean,
  writeClientBoolean,
} from '../lib/clientStorage';

export interface Entitlements {
  nsfw_2026: boolean;
}

const DEFAULT_ENTITLEMENTS: Entitlements = {nsfw_2026: false};

const STORAGE_EVENT = 'greenhaven:entitlements-changed';

function readEntitlements(): Entitlements {
  return {
    nsfw_2026: readClientBoolean(
      CLIENT_STORAGE_KEYS.entitlementNsfw,
      DEFAULT_ENTITLEMENTS.nsfw_2026,
    ),
  };
}

export function setEntitlement<K extends keyof Entitlements>(
  key: K,
  value: Entitlements[K],
): void {
  if (key === 'nsfw_2026') {
    writeClientBoolean(CLIENT_STORAGE_KEYS.entitlementNsfw, value as boolean);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(STORAGE_EVENT));
  }
}

export function useEntitlements(): {
  entitlements: Entitlements;
  unlock: <K extends keyof Entitlements>(key: K, value: Entitlements[K]) => void;
} {
  const [entitlements, setState] = useState<Entitlements>(() =>
    readEntitlements(),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => setState(readEntitlements());
    window.addEventListener(STORAGE_EVENT, handler);
    return () => window.removeEventListener(STORAGE_EVENT, handler);
  }, []);

  const unlock = useCallback(
    <K extends keyof Entitlements>(key: K, value: Entitlements[K]) => {
      setEntitlement(key, value);
      setState(prev => ({...prev, [key]: value}));
    },
    [],
  );

  return {entitlements, unlock};
}
