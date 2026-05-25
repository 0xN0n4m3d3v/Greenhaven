// Spec 31 — set CSS custom props `--mood-hue` and `--mood-saturation`
// based on scene mode. body::before listens via the rpg-frame.css
// gradient and slowly cross-fades on the 1.2s transition.

import {useEffect} from 'react';

const MODE_HUE: Record<string, number> = {
  exploration: 200,
  dialogue: 220,
  rest: 180,
  combat: 12,
  intimacy: 320,
  travel: 50,
};

export function useMoodPulse(mode: string, _weather?: string) {
  useEffect(() => {
    const target = MODE_HUE[mode] ?? 220;
    const sat = mode === 'combat' || mode === 'intimacy' ? 50 : 22;
    document.documentElement.style.setProperty('--mood-hue', String(target));
    document.documentElement.style.setProperty(
      '--mood-saturation',
      `${sat}%`,
    );
    document.documentElement.style.setProperty('--mood-transition', '1200ms');
  }, [mode]);
}
