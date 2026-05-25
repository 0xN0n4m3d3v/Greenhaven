import {Navigation, X} from 'lucide-react';
import {
  relationshipBandLabel,
  type RelationshipBand,
} from '../../lib/presenceLabels';

interface LocationNode {
  id: number;
  name: string;
  status?: string;
  unread?: number;
}

interface MapNode {
  id: number;
  name: string;
  kind: string;
  location_kind: string | null;
  x: number;
  y: number;
  color: string | null;
  topology_parent_id: number | null;
  is_current: boolean;
  is_exit: boolean;
}

interface NearbyNpc {
  id: number;
  name: string;
  status?: string;
  // FEAT-PRESENCE-1 — server-canonical bond + status badges.
  relationship?: {band: string | null; count: number | null} | null;
  statuses?: Array<{kind: string; value: string; intensity: number}>;
}

interface Props {
  currentLocation: LocationNode;
  locations: LocationNode[];
  mapNodes: MapNode[];
  nearby: NearbyNpc[];
  busy: boolean;
  onClose: () => void;
  onTravel: (location: LocationNode) => void;
  // FEAT-PRESENCE-2 — translation function for the band labels in
  // the "Here now" panel. Optional so existing callers keep
  // working; falls back to the English label baked into
  // `relationshipBandLabel`.
  t?: (key: string) => string;
}

// SVG canvas pixel size. The (x,y) coordinates we store in the cartridge are
// 0–100 normalized; we project them onto this viewBox so the layout scales
// with the modal width.
const CANVAS_W = 720;
const CANVAS_H = 420;
// Inset so labels near the edges don't clip.
const INSET_X = 40;
const INSET_Y = 30;

function project(x: number, y: number): {x: number; y: number} {
  return {
    x: INSET_X + (Math.max(0, Math.min(100, x)) / 100) * (CANVAS_W - INSET_X * 2),
    y: INSET_Y + (Math.max(0, Math.min(100, y)) / 100) * (CANVAS_H - INSET_Y * 2),
  };
}

export function CityMapModal({
  currentLocation,
  locations,
  mapNodes,
  nearby,
  busy,
  onClose,
  onTravel,
  t,
}: Props) {
  const presenceT = t ?? ((key: string) => key);
  // Prefer authored topography when present. Fallback: radial layout around
  // the current node — preserves the old behaviour for locations the cartridge
  // hasn't placed yet.
  const useTopography = mapNodes && mapNodes.length > 0;
  const projectedNodes = useTopography
    ? mapNodes.map(node => {
        const projected = project(node.x, node.y);
        return {
          id: node.id,
          name: node.name,
          kind: node.kind,
          location_kind: node.location_kind,
          color: node.color,
          topology_parent_id: node.topology_parent_id,
          is_current: node.is_current,
          is_exit: node.is_exit,
          x: projected.x,
          y: projected.y,
        };
      })
    : buildRadialFallback(currentLocation, locations);

  const current = projectedNodes.find(node => node.is_current) ?? projectedNodes[0];
  const exits = projectedNodes.filter(node => !node.is_current && node.is_exit);
  const distant = projectedNodes.filter(node => !node.is_current && !node.is_exit);

  // District nodes are the underlying "zone" labels; draw them as soft rings
  // behind their child venues so the player can read the city as Velvet
  // Quarter / Steelgate / etc.
  const districtNodes = projectedNodes.filter(node => node.kind === 'district');

  return (
    <div className="city-map-backdrop gh-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="city-map-modal gh-panel gh-city-map"
        role="dialog"
        aria-modal="true"
        aria-label="City map"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="city-map-header">
          <div>
            <p className="eyebrow">City map</p>
            <h2>{currentLocation.name}</h2>
          </div>
          <button
            type="button"
            className="city-map-close gh-control"
            aria-label="Close map"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="city-map-body">
          <div className="city-map-canvas" aria-hidden>
            <svg viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} role="img">
              <defs>
                <radialGradient id="city-map-glow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="hsl(38 80% 72% / 0.55)" />
                  <stop offset="100%" stopColor="hsl(38 80% 45% / 0)" />
                </radialGradient>
              </defs>
              <rect x="0" y="0" width={CANVAS_W} height={CANVAS_H} rx="0" />

              {/* Compass marks for orientation. */}
              {/* Spec 139 — compass marks removed; landmark-based map. */}

              {/* District zones — soft circular halo coloured by district. */}
              {useTopography &&
                districtNodes.map(d => (
                  <rect
                    key={`district-zone-${d.id}`}
                    x={d.x - 86}
                    y={d.y - 86}
                    width={172}
                    height={172}
                    fill={d.color ?? '#444'}
                    opacity={0.12}
                  />
                ))}

              {/* District labels — placed at the district node centre. */}
              {useTopography &&
                districtNodes.map(d => (
                  <text
                    key={`district-label-${d.id}`}
                    x={d.x}
                    y={d.y - 56}
                    className="city-map-district-label"
                    textAnchor="middle"
                  >
                    {d.name}
                  </text>
                ))}

              {/* Edges: current → each visible exit. */}
              {current &&
                exits.map(exit => (
                  <line
                    key={`edge-${exit.id}`}
                    className="city-map-edge"
                    x1={current.x}
                    y1={current.y}
                    x2={exit.x}
                    y2={exit.y}
                  />
                ))}

              {/* Distant nodes (visible but not direct exits) — dimmer dots. */}
              {distant.map(node => (
                <g key={`distant-${node.id}`} className="city-map-node distant">
                  <rect
                    x={node.x - 7}
                    y={node.y - 7}
                    width={14}
                    height={14}
                    fill={node.color ?? '#555'}
                    opacity={0.55}
                  />
                </g>
              ))}

              {/* Exit nodes — full-strength. */}
              {exits.map(node => (
                <g key={`exit-${node.id}`} className="city-map-node">
                  <rect
                    className="city-map-node-glow"
                    x={node.x - 28}
                    y={node.y - 28}
                    width={56}
                    height={56}
                  />
                  <rect
                    x={node.x - 11}
                    y={node.y - 11}
                    width={22}
                    height={22}
                    fill={node.color ?? '#888'}
                  />
                </g>
              ))}

              {/* Current node — largest, glowing. */}
              {current && (
                <g className="city-map-node current">
                  <rect
                    className="city-map-node-glow"
                    x={current.x - 46}
                    y={current.y - 46}
                    width={92}
                    height={92}
                  />
                  <rect
                    x={current.x - 16}
                    y={current.y - 16}
                    width={32}
                    height={32}
                    fill={current.color ?? '#d4a868'}
                  />
                </g>
              )}
            </svg>

            <div className="city-map-labels">
              {projectedNodes
                .filter(node => node.kind !== 'district')
                .map(node => (
                  <button
                    key={node.id}
                    type="button"
                    className={[
                      'city-map-label',
                      node.is_current ? 'current' : '',
                      !node.is_current && !node.is_exit ? 'distant' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{
                      left: `${(node.x / CANVAS_W) * 100}%`,
                      top: `${(node.y / CANVAS_H) * 100}%`,
                    }}
                    disabled={busy || node.is_current}
                    onClick={() => {
                      if (!node.is_current) {
                        onTravel({id: node.id, name: node.name});
                        onClose();
                      }
                    }}
                    title={
                      node.is_current
                        ? `${node.name} (you are here)`
                        : node.is_exit
                          ? `Travel to ${node.name}`
                          : `${node.name} — try to travel`
                    }
                  >
                    <span>{node.name}</span>
                  </button>
                ))}
            </div>
          </div>

          <aside className="city-map-panel">
            <section>
              <p className="city-map-panel-title">Reachable now</p>
              {exits.length === 0 ? (
                <p className="city-map-empty">No direct exits — try a known place below.</p>
              ) : (
                <div className="city-map-exit-list">
                  {exits.map(exit => (
                    <button
                      type="button"
                      key={exit.id}
                      disabled={busy}
                      onClick={() => {
                        onTravel({id: exit.id, name: exit.name});
                        onClose();
                      }}
                    >
                      <Navigation size={14} />
                      <span>{exit.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
            {/* Spec 139 v2 — Anywhere fallback. Lists every known location
                on the map so the player can always travel to somewhere
                they have seen before, even if the current node has no
                labelled exits. The broker still gets the move request and
                may refuse with a narrated reason. */}
            <section>
              <p className="city-map-panel-title">Known places</p>
              <div className="city-map-exit-list">
                {projectedNodes
                  .filter(n => !n.is_current && n.kind !== 'district')
                  .slice(0, 12)
                  .map(node => (
                    <button
                      type="button"
                      key={`anywhere-${node.id}`}
                      disabled={busy}
                      onClick={() => {
                        onTravel({id: node.id, name: node.name});
                        onClose();
                      }}
                    >
                      <Navigation size={14} />
                      <span>{node.name}</span>
                    </button>
                  ))}
                {projectedNodes.filter(n => !n.is_current && n.kind !== 'district').length === 0 && (
                  <p className="city-map-empty">No other places are on the map yet.</p>
                )}
              </div>
            </section>
            <section>
              <p className="city-map-panel-title">Here now</p>
              {nearby.length === 0 ? (
                <p className="city-map-empty">No visible NPCs nearby.</p>
              ) : (
                <ul className="city-map-npc-list">
                  {nearby.slice(0, 8).map(npc => {
                    const band = (npc.relationship?.band ?? null) as
                      | RelationshipBand
                      | null;
                    const bandLabel = relationshipBandLabel(band, presenceT);
                    const statuses = npc.statuses ?? [];
                    return (
                      <li key={npc.id} className="city-map-npc-row">
                        <span className="city-map-npc-name">{npc.name}</span>
                        {band && (
                          <span
                            className={`city-map-npc-band city-map-band-${band}`}
                            aria-label={bandLabel}
                            title={
                              typeof npc.relationship?.count === 'number'
                                ? `${bandLabel} (${npc.relationship.count})`
                                : bandLabel
                            }
                          >
                            {bandLabel}
                          </span>
                        )}
                        {statuses.length > 0 && (
                          <span
                            className="city-map-npc-status"
                            title={statuses
                              .map(s => `${s.kind}: ${s.value}`)
                              .join(', ')}
                          >
                            {statuses[0]!.kind}
                            {statuses.length > 1
                              ? ` +${statuses.length - 1}`
                              : ''}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </section>
    </div>
  );
}

interface ProjectedNode {
  id: number;
  name: string;
  kind: string;
  location_kind: string | null;
  color: string | null;
  topology_parent_id: number | null;
  is_current: boolean;
  is_exit: boolean;
  x: number;
  y: number;
}

// Fallback when no map_position data has reached the client yet (offline
// bootstrap, or a cartridge that hasn't authored topography). Mirrors the
// pre-0097 radial layout: current at centre, exits placed around the rim.
function buildRadialFallback(
  currentLocation: LocationNode,
  locations: LocationNode[],
): ProjectedNode[] {
  const seen = new Set<number>();
  const center: ProjectedNode = {
    id: currentLocation.id,
    name: currentLocation.name,
    kind: 'location',
    location_kind: null,
    color: null,
    topology_parent_id: null,
    is_current: true,
    is_exit: false,
    x: CANVAS_W / 2,
    y: CANVAS_H / 2,
  };
  seen.add(center.id);
  const exits = locations
    .filter(location => {
      if (!location?.id || seen.has(location.id)) return false;
      seen.add(location.id);
      return true;
    })
    .slice(0, 10);
  const radiusX = exits.length > 6 ? 250 : 220;
  const radiusY = exits.length > 6 ? 135 : 120;
  const mapped = exits.map((location, index): ProjectedNode => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, exits.length);
    return {
      id: location.id,
      name: location.name,
      kind: 'location',
      location_kind: null,
      color: null,
      topology_parent_id: null,
      is_current: false,
      is_exit: true,
      x: CANVAS_W / 2 + Math.cos(angle) * radiusX,
      y: CANVAS_H / 2 + Math.sin(angle) * radiusY,
    };
  });
  return [center, ...mapped];
}
