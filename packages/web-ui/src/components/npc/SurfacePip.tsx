// DOS2-style surface icon pip. Cartridge can extend the maps in spec 33.

import type {CSSProperties} from 'react';

const SURFACE_GLYPH: Record<string, string> = {
  fire: 'F',
  oil: 'O',
  water: '~',
  ice: '*',
  electric: 'E',
  poison: 'P',
  blood: 'B',
  smoke: 'S',
  steam: '=',
  acid: 'A',
  web: '#',
  lava: 'L',
};

const SURFACE_HUE: Record<string, string> = {
  fire: '12 75% 50%',
  oil: '40 30% 30%',
  water: '210 70% 55%',
  ice: '195 80% 70%',
  electric: '50 100% 60%',
  poison: '120 60% 35%',
  blood: '350 70% 30%',
  smoke: '0 0% 50%',
  steam: '195 20% 75%',
  acid: '85 70% 45%',
  web: '60 5% 75%',
  lava: '20 90% 45%',
};

export function SurfacePip({type, title}: {type: string; title?: string}) {
  const hue = SURFACE_HUE[type] ?? '0 0% 50%';
  const vars = {'--surface-pip-hue': hue} as CSSProperties;
  return (
    <span
      className="surface-pip"
      style={vars}
      title={title ?? type}
      aria-label={type}
    >
      {SURFACE_GLYPH[type] ?? '*'}
    </span>
  );
}
