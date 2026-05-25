/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-REL-1 (2026-05-17) — Bonds / relationship-strings surface.
//
// Renders the player's current relationship graph as a compact list
// of NPC bonds plus a simple radial visual. Server is canon: data
// flows through `useStringsGraph` which calls
// `GET /api/player/:id/strings/graph` and refreshes on the
// normalized `system:event` channel when payload.type ===
// 'string:changed'. No leaf-component fetch, no localStorage, no
// client-authored mutations. No mock graph fallback either —
// missing endpoint / network failure renders the real error state.

import {HeartHandshake} from 'lucide-react';
import {useMemo} from 'react';
import {
  hueForKind,
  useStringsGraph,
  type StringEdge,
  type StringNode,
  type StringsGraph,
} from '../../hooks/useStringsGraph';

interface Props {
  playerId: number;
  language: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

interface EdgeViewModel {
  npc: StringNode;
  toward: StringEdge | null;
  fromHero: StringEdge | null;
}

/**
 * Group edges by the NPC partner so the list shows one card per
 * person with both directions (player→npc, npc→player) collapsed
 * onto the same row. The hero node is excluded from the partner
 * list — it never bonds with itself.
 */
function buildEdgeViewModels(graph: StringsGraph): EdgeViewModel[] {
  const nodesById = new Map<number, StringNode>();
  for (const node of graph.nodes) nodesById.set(node.id, node);
  const heroId = graph.playerId;
  const byPartner = new Map<number, EdgeViewModel>();
  for (const edge of graph.edges) {
    const partnerId = edge.from === heroId ? edge.to : edge.from;
    if (partnerId === heroId) continue;
    const partner = nodesById.get(partnerId);
    if (!partner) continue;
    let vm = byPartner.get(partnerId);
    if (!vm) {
      vm = {npc: partner, toward: null, fromHero: null};
      byPartner.set(partnerId, vm);
    }
    if (edge.from === heroId) vm.fromHero = edge;
    else vm.toward = edge;
  }
  return [...byPartner.values()].sort((a, b) => {
    const aTop = Math.max(
      a.toward?.intensity ?? 0,
      a.fromHero?.intensity ?? 0,
    );
    const bTop = Math.max(
      b.toward?.intensity ?? 0,
      b.fromHero?.intensity ?? 0,
    );
    if (aTop !== bTop) return bTop - aTop;
    return a.npc.name.localeCompare(b.npc.name);
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function valenceClass(valence: string): string {
  if (valence === 'positive') return 'bonds-edge--positive';
  if (valence === 'negative') return 'bonds-edge--negative';
  return 'bonds-edge--ambivalent';
}

function EdgeChip({edge, t}: {edge: StringEdge; t: Props['t']}) {
  const hue = hueForKind(edge.kind);
  const pct = Math.round(clamp01(edge.intensity) * 100);
  const kindLabel = (() => {
    const k = t(`ui.surface.bonds.kind.${edge.kind}`);
    return k === `ui.surface.bonds.kind.${edge.kind}` ? edge.kind : k;
  })();
  return (
    <span
      className={`bonds-edge ${valenceClass(edge.valence)}`}
      style={{
        // CSS custom property used by the stylesheet so each edge
        // pill tints toward the kind hue without per-kind classes.
        ['--bonds-edge-hue' as const]: hue,
      } as React.CSSProperties}
      title={edge.summary ?? kindLabel}
    >
      <span className="bonds-edge-kind">{kindLabel}</span>
      <span className="bonds-edge-meter" aria-hidden="true">
        <span
          className="bonds-edge-meter-fill"
          style={{width: `${pct}%`}}
        />
      </span>
      <span className="bonds-edge-intensity">{pct}%</span>
    </span>
  );
}

function BondRow({vm, t}: {vm: EdgeViewModel; t: Props['t']}) {
  const fromHero = vm.fromHero;
  const toward = vm.toward;
  return (
    <li className="bonds-row" data-npc-id={vm.npc.id}>
      <header className="bonds-row-header">
        <h3 className="bonds-row-name">{vm.npc.name}</h3>
      </header>
      <div className="bonds-row-edges">
        <div className="bonds-row-direction">
          <span className="bonds-row-direction-label">
            {t('ui.surface.bonds.direction.from_you')}
          </span>
          {fromHero ? (
            <EdgeChip edge={fromHero} t={t} />
          ) : (
            <span className="bonds-edge bonds-edge--empty">
              {t('ui.surface.bonds.direction.empty')}
            </span>
          )}
        </div>
        <div className="bonds-row-direction">
          <span className="bonds-row-direction-label">
            {t('ui.surface.bonds.direction.toward_you')}
          </span>
          {toward ? (
            <EdgeChip edge={toward} t={t} />
          ) : (
            <span className="bonds-edge bonds-edge--empty">
              {t('ui.surface.bonds.direction.empty')}
            </span>
          )}
        </div>
      </div>
      {(fromHero?.summary || toward?.summary) && (
        <p className="bonds-row-summary">
          {fromHero?.summary || toward?.summary}
        </p>
      )}
    </li>
  );
}

/**
 * Simple radial layout: hero at center, each NPC partner positioned
 * on a ring around it. Visual only — the list above is the
 * authoritative interaction surface. Reduced-motion safe (no
 * animation), keyboard-inert (aria-hidden), scales with viewport.
 */
function BondGraph({
  graph,
  partners,
}: {
  graph: StringsGraph;
  partners: EdgeViewModel[];
}) {
  const size = 320;
  const center = size / 2;
  const radius = size * 0.36;
  const items = partners.slice(0, 10);
  if (items.length === 0) return null;
  return (
    <svg
      className="bonds-graph"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-hidden="true"
    >
      {items.map((vm, index) => {
        const angle = (index / items.length) * Math.PI * 2 - Math.PI / 2;
        const cx = center + Math.cos(angle) * radius;
        const cy = center + Math.sin(angle) * radius;
        const edge = vm.toward ?? vm.fromHero;
        const hue = edge ? hueForKind(edge.kind) : 220;
        const intensity = edge ? clamp01(edge.intensity) : 0.2;
        return (
          <g key={vm.npc.id}>
            <line
              x1={center}
              y1={center}
              x2={cx}
              y2={cy}
              className="bonds-graph-edge"
              style={{
                stroke: `hsl(${hue}, 60%, 55%)`,
                strokeOpacity: 0.25 + intensity * 0.6,
                strokeWidth: 1 + intensity * 2,
              }}
            />
            <rect
              x={cx - (10 + intensity * 6)}
              y={cy - (10 + intensity * 6)}
              width={(10 + intensity * 6) * 2}
              height={(10 + intensity * 6) * 2}
              className="bonds-graph-node"
              style={{fill: `hsl(${hue}, 50%, 45%)`}}
            />
          </g>
        );
      })}
      <rect
        x={center - 16}
        y={center - 16}
        width={32}
        height={32}
        className="bonds-graph-hero"
        aria-label={graph.playerId.toString()}
      />
    </svg>
  );
}

export function RelationshipsSurface({playerId, t}: Props) {
  void playerId; // language flows through useTranslation; playerId guides hook.
  const view = useStringsGraph(playerId || null);
  const partners = useMemo(() => buildEdgeViewModels(view.graph), [view.graph]);
  if (view.status === 'idle' || view.status === 'loading') {
    return (
      <div className="bonds-surface bonds-surface--state">
        <p>{t('ui.surface.bonds.loading')}</p>
      </div>
    );
  }
  if (view.status === 'forbidden') {
    return (
      <div className="bonds-surface bonds-surface--state">
        <p>{t('ui.surface.bonds.forbidden')}</p>
      </div>
    );
  }
  if (view.status === 'error') {
    return (
      <div className="bonds-surface bonds-surface--state">
        <p>{t('ui.surface.bonds.error')}</p>
        <button
          type="button"
          className="bonds-surface-retry"
          onClick={view.refresh}
        >
          {t('ui.surface.bonds.retry')}
        </button>
      </div>
    );
  }
  if (view.status === 'empty' || partners.length === 0) {
    return (
      <div className="bonds-surface bonds-surface--state">
        <HeartHandshake size={28} aria-hidden="true" />
        <p>{t('ui.surface.bonds.empty')}</p>
      </div>
    );
  }
  return (
    <div className="bonds-surface">
      <BondGraph graph={view.graph} partners={partners} />
      <ol className="bonds-list">
        {partners.map(vm => (
          <BondRow key={vm.npc.id} vm={vm} t={t} />
        ))}
      </ol>
    </div>
  );
}
