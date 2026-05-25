import {useEffect, useState} from 'react';
import {GetAvailableLanguages, i18n} from '../bridge/platform';

export function useAvailableLanguages(): i18n.Language[] {
  const [availableLanguages, setAvailableLanguages] = useState<i18n.Language[]>(
    [],
  );

  useEffect(() => {
    let alive = true;
    GetAvailableLanguages()
      .then(langs => {
        if (alive) setAvailableLanguages(langs ?? []);
      })
      .catch(err => console.error('GetAvailableLanguages failed', err));
    return () => {
      alive = false;
    };
  }, []);

  return availableLanguages;
}
