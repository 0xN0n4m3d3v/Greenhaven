// Spec 36 §1 carried-over — UI-side mechanic-vocabulary lookup.
//
// Fetches /api/i18n/mechanic?lang=… once on mount, caches per-lang.
// Components call `tMech('condition.bleeding')` and get the localized
// label. Falls through to the literal key when not loaded yet (visible
// indicator that the registry hasn't bootstrapped).

import {useCallback, useEffect, useState} from 'react';
import {fetchMechanicI18n} from '../bridge/mechanicI18n';

const cache = new Map<string, Record<string, string>>();

export function useMechI18n(lang: string | null): {
  tMech: (key: string) => string;
  ready: boolean;
} {
  const effectiveLang = lang ?? 'en';
  const [ready, setReady] = useState(cache.has(effectiveLang));

  useEffect(() => {
    if (cache.has(effectiveLang)) {
      setReady(true);
      return;
    }
    let cancelled = false;
    fetchMechanicI18n({language: effectiveLang})
      .then(map => {
        if (cancelled) return;
        cache.set(effectiveLang, map);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        cache.set(effectiveLang, {});
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveLang]);

  const tMech = useCallback(
    (key: string) => {
      const map = cache.get(effectiveLang);
      return map?.[key] ?? key;
    },
    [effectiveLang, ready],
  );

  return {tMech, ready};
}
