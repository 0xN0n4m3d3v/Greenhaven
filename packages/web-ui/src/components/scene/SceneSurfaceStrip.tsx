// Scene-level surface chip strip.
//
// Renders above the chat. Each chip is one active surface in the current
// location, with optional severity and affected-count metadata.

import {useRuntimeField} from '../../hooks/useRuntimeFields';
import {SurfacePip} from '../npc/SurfacePip';

interface SurfaceEntry {
  type?: string;
  severity?: number;
  affected?: number[];
  area?: string;
}

export function SceneSurfaceStrip({locationId}: {locationId: number | null}) {
  const surfaces =
    useRuntimeField<SurfaceEntry[]>(locationId ?? 0, 'active_surfaces') ?? [];
  const real = Array.isArray(surfaces)
    ? surfaces.filter(s => s && typeof s.type === 'string')
    : [];
  if (real.length === 0) return null;
  return (
    <div className="scene-surface-strip">
      {real.map((s, i) => {
        const affected = Array.isArray(s.affected) ? s.affected.length : 0;
        const severity = s.severity != null && s.severity > 1 ? s.severity : null;
        const title = `${s.type}${severity != null ? ` x${severity}` : ''}${
          affected > 0 ? ` - ${affected} affected` : ''
        }`;
        return (
          <span
            key={`${s.type}-${i}`}
            className="scene-surface-chip"
            title={title}
          >
            <SurfacePip type={s.type!} />
            <span>{s.type}</span>
            {severity != null && (
              <span className="scene-surface-chip__muted">x{severity}</span>
            )}
            {affected > 0 && (
              <span className="scene-surface-chip__muted">- {affected}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
