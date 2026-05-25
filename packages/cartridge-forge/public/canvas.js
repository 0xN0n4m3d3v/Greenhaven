const KIND_ORDER = [
  'location',
  'scene',
  'person',
  'item',
  'quest',
  'event',
  'faction',
  'activity',
  'dialogue',
  'relationship',
  'world_fact',
  'visual_pack',
];

const kindLabels = {
  activity: 'Активность',
  dialogue: 'Диалог',
  event: 'Событие',
  faction: 'Фракция',
  item: 'Предмет',
  location: 'Локация',
  person: 'NPC',
  quest: 'Квест',
  relationship: 'Отношение',
  scene: 'Сцена',
  world_fact: 'Факт мира',
  visual_pack: 'Визуал',
};

const relLabels = {
  contains: 'содержит',
  resident: 'житель',
  participant: 'участник',
  placed_item: 'предмет',
  quest_hook: 'зацепка',
  related: 'связано',
  visual_pack: 'визуал',
  generated_quest: 'созданный квест',
  quest_giver: 'квестодатель',
  quest_start: 'старт квеста',
  prepared_entity: 'подготовлено',
  quest_stage_location: 'этап',
  location: 'локация',
  home: 'дом',
  holder: 'владелец',
  scene: 'сцена',
  scene_anchor: 'якорь сцены',
  scene_item: 'предмет сцены',
  exit: 'переход',
  faction: 'фракция',
};

const NODE_FALLBACK_SIZE = {
  width: 236,
  height: 116,
};

const SELECTION_BOUNDS_PADDING = 10;
const COMPACT_LAYOUT_GAP_X = 284;
const COMPACT_LAYOUT_GAP_Y = 156;
const COMPACT_LAYOUT_MAX_COLUMNS = 4;

export class CartridgeCanvas {
  constructor(options) {
    this.stage = options.stage;
    this.grid = options.grid;
    this.edgeLayer = options.edgeLayer;
    this.nodeLayer = options.nodeLayer;
    this.toolbox = options.toolbox;
    this.onSelect = options.onSelect;
    this.onLink = options.onLink;
    this.onQuest = options.onQuest;
    this.onVisual = options.onVisual;
    this.onFocus = options.onFocus;
    this.onContextMenu = options.onContextMenu;
    this.mode = 'select';
    this.graph = {nodes: [], edges: []};
    this.positions = new Map();
    this.viewPositions = null;
    this.viewLayoutKey = null;
    this.viewport = {x: 0, y: 0, scale: 1};
    this.selectedId = null;
    this.pendingLinkFrom = null;
    this.drag = null;
    this.pan = null;
    this.storageKey = 'forge-canvas-layout';

    this.bind();
    this.applyViewport();
  }

  setProject(projectSlug) {
    const nextStorageKey = `forge-canvas-layout:${projectSlug ?? 'none'}`;
    if (nextStorageKey === this.storageKey) return;
    this.storageKey = nextStorageKey;
    this.positions = new Map(Object.entries(readJson(this.storageKey) ?? {}));
    this.viewPositions = null;
    this.viewLayoutKey = null;
  }

  setMode(mode) {
    this.mode = mode;
    this.stage.dataset.mode = mode;
    if (mode !== 'link') this.pendingLinkFrom = null;
    this.render();
  }

  setGraph(graph, selectedId = null, options = {}) {
    const previousViewPositions = this.viewPositions;
    this.graph = graph ?? {nodes: [], edges: []};
    this.selectedId = selectedId;
    this.ensureLayout();
    if (options.compactLayout) {
      const centerId = options.centerId ?? selectedId;
      const layoutKey = compactLayoutKey(this.graph, centerId);
      if (previousViewPositions && this.viewLayoutKey === layoutKey) {
        this.viewPositions = previousViewPositions;
      } else {
        this.viewPositions = this.buildCompactLayout(centerId, previousViewPositions);
      }
      this.viewLayoutKey = layoutKey;
    } else {
      this.viewPositions = null;
      this.viewLayoutKey = null;
    }
    this.render();
  }

  fit() {
    if (this.graph.nodes.length === 0) return;
    const bounds = this.bounds();
    const rect = this.stage.getBoundingClientRect();
    const scale = Math.max(
      0.42,
      Math.min(1.2, Math.min(rect.width / bounds.w, rect.height / bounds.h) * 0.84),
    );
    this.viewport = {
      scale,
      x: rect.width / 2 - (bounds.x + bounds.w / 2) * scale,
      y: rect.height / 2 - (bounds.y + bounds.h / 2) * scale,
    };
    this.applyViewport();
  }

  select(id, silent = false) {
    this.selectedId = id;
    if (!silent) this.onSelect?.(id);
    this.render();
  }

  startLinkFrom(id) {
    this.pendingLinkFrom = id;
    this.selectedId = id;
    this.setMode('link');
  }

  setNodePosition(id, position) {
    this.positions.set(id, position);
    this.persistPositions();
    this.render();
  }

  bind() {
    this.stage.addEventListener('wheel', event => this.onWheel(event), {passive: false});
    this.stage.addEventListener('pointerdown', event => this.onStagePointerDown(event));
    this.stage.addEventListener('pointermove', event => this.onPointerMove(event));
    this.stage.addEventListener('pointerup', event => this.onPointerUp(event));
    this.stage.addEventListener('pointercancel', () => this.clearPointerState());
    this.stage.addEventListener('contextmenu', event => this.onContextMenuEvent(event));

    this.nodeLayer.addEventListener('pointerdown', event => this.onNodePointerDown(event));
    this.nodeLayer.addEventListener('click', event => this.onNodeClick(event));
    this.nodeLayer.addEventListener('dblclick', event => this.onNodeDoubleClick(event));
    this.toolbox.addEventListener('click', event => {
      const action = event.target.closest('[data-canvas-action]')?.dataset.canvasAction;
      if (!action || !this.selectedId) return;
      if (action === 'quest') this.onQuest?.(this.selectedId);
      if (action === 'visual') this.onVisual?.(this.selectedId);
    });
  }

  onContextMenuEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    const rect = this.stage.getBoundingClientRect();
    const screen = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const context = {
      type: 'canvas',
      client: {x: event.clientX, y: event.clientY},
      screen,
      world: this.screenToWorld(screen),
    };

    const edge = event.target.closest?.('.canvas-edge');
    const node = event.target.closest?.('[data-node-id]');
    if (node) {
      context.type = node.dataset.nodeId?.startsWith('visual:') ? 'visual-node' : 'node';
      context.nodeId = node.dataset.nodeId;
      this.select(context.nodeId, true);
    } else if (edge) {
      context.type = 'edge';
      context.edge = {
        from: edge.dataset.edgeFrom,
        to: edge.dataset.edgeTo,
        rel: edge.dataset.edgeRel,
      };
    }
    this.onContextMenu?.(context);
  }

  onWheel(event) {
    event.preventDefault();
    const rect = this.stage.getBoundingClientRect();
    const point = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const before = this.screenToWorld(point);
    const scale = clamp(this.viewport.scale * (event.deltaY > 0 ? 0.9 : 1.1), 0.32, 1.8);
    this.viewport.scale = scale;
    this.viewport.x = point.x - before.x * scale;
    this.viewport.y = point.y - before.y * scale;
    this.applyViewport();
  }

  onStagePointerDown(event) {
    if (event.target.closest('[data-node-id]') || event.target.closest('.selection-toolbox')) {
      return;
    }
    if (this.mode === 'hand' || event.button === 1 || event.altKey || event.target === this.stage) {
      this.pan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewport: {...this.viewport},
      };
      this.stage.setPointerCapture(event.pointerId);
    }
  }

  onNodePointerDown(event) {
    const node = event.target.closest('[data-node-id]');
    if (!node || this.mode !== 'select') return;
    const id = node.dataset.nodeId;
    const position = this.positionFor(id) ?? {x: 0, y: 0};
    this.drag = {
      pointerId: event.pointerId,
      nodeId: id,
      startX: event.clientX,
      startY: event.clientY,
      position: {...position},
    };
    node.setPointerCapture(event.pointerId);
  }

  onNodeClick(event) {
    const node = event.target.closest('[data-node-id]');
    if (!node) return;
    const id = node.dataset.nodeId;
    if (this.mode === 'link') {
      this.clickLinkTarget(id);
      return;
    }
    this.select(id);
  }

  onNodeDoubleClick(event) {
    const node = event.target.closest('[data-node-id]');
    if (!node || this.mode === 'link') return;
    event.preventDefault();
    event.stopPropagation();
    this.onFocus?.(node.dataset.nodeId);
  }

  clickLinkTarget(id) {
    if (!this.pendingLinkFrom) {
      this.pendingLinkFrom = id;
      this.selectedId = id;
      this.render();
      return;
    }
    if (this.pendingLinkFrom !== id) {
      this.onLink?.(this.pendingLinkFrom, id);
    }
    this.pendingLinkFrom = null;
    this.render();
  }

  onPointerMove(event) {
    if (this.drag?.pointerId === event.pointerId) {
      const next = {
        x: this.drag.position.x + (event.clientX - this.drag.startX) / this.viewport.scale,
        y: this.drag.position.y + (event.clientY - this.drag.startY) / this.viewport.scale,
      };
      if (this.viewPositions?.has(this.drag.nodeId)) {
        this.viewPositions.set(this.drag.nodeId, next);
      } else {
        this.positions.set(this.drag.nodeId, next);
        this.persistPositions();
      }
      this.renderEdges();
      this.positionToolbox();
      return;
    }

    if (this.pan?.pointerId === event.pointerId) {
      this.viewport.x = this.pan.viewport.x + event.clientX - this.pan.startX;
      this.viewport.y = this.pan.viewport.y + event.clientY - this.pan.startY;
      this.applyViewport();
    }
  }

  onPointerUp(event) {
    if (this.drag?.pointerId === event.pointerId) this.drag = null;
    if (this.pan?.pointerId === event.pointerId) this.pan = null;
  }

  clearPointerState() {
    this.drag = null;
    this.pan = null;
  }

  ensureLayout() {
    const grouped = new Map();
    for (const node of this.graph.nodes) {
      if (this.positions.has(node.id)) continue;
      const group = grouped.get(node.kind) ?? [];
      group.push(node);
      grouped.set(node.kind, group);
    }

    for (const [kind, nodes] of grouped) {
      const column = KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length;
      nodes.sort((a, b) => a.label.localeCompare(b.label));
      nodes.forEach((node, index) => {
        this.positions.set(node.id, {
          x: 70 + column * 300,
          y: 70 + index * 166,
        });
      });
    }
    this.persistPositions();
  }

  buildCompactLayout(centerId, previousViewPositions = null) {
    const nodes = [...this.graph.nodes];
    if (nodes.length === 0) return new Map();
    const center = nodes.find(node => node.id === centerId) ?? nodes[0];
    const anchor = previousViewPositions?.get(center.id) ?? this.positions.get(center.id) ?? {x: 70, y: 70};
    const ordered = nodes.sort(compareCompactNodeOrder(center.id));
    const columns = Math.min(COMPACT_LAYOUT_MAX_COLUMNS, Math.max(1, ordered.length));
    const positions = new Map();
    ordered.forEach((node, index) => {
      positions.set(node.id, {
        x: anchor.x + (index % columns) * COMPACT_LAYOUT_GAP_X,
        y: anchor.y + Math.floor(index / columns) * COMPACT_LAYOUT_GAP_Y,
      });
    });
    return positions;
  }

  render() {
    this.renderNodes();
    this.renderEdges();
    this.positionToolbox();
  }

  renderNodes() {
    if (this.graph.nodes.length === 0) {
      this.nodeLayer.innerHTML = '<div class="canvas-empty">Создайте записи, чтобы собрать граф мира.</div>';
      this.toolbox.hidden = true;
      return;
    }

    this.nodeLayer.innerHTML = this.graph.nodes
      .map(node => {
        const pos = this.positionFor(node.id) ?? {x: 0, y: 0};
        const selected = node.id === this.selectedId ? ' selected' : '';
        const pending = node.id === this.pendingLinkFrom ? ' pending-link' : '';
        return `
          <article
            class="canvas-node kind-${escapeAttr(node.kind)}${selected}${pending}"
            data-node-id="${escapeAttr(node.id)}"
            style="transform: translate(${pos.x}px, ${pos.y}px)"
          >
            <span class="node-port in" aria-hidden="true"></span>
            <span class="node-port out" aria-hidden="true"></span>
            <div class="node-head">
              <span>${escapeHtml(node.label)}</span>
              <span class="node-kind">${escapeHtml(kindLabel(node.kind))}</span>
            </div>
            <div class="node-slug">${escapeHtml(node.slug)}</div>
            <p>${escapeHtml(node.summary)}</p>
          </article>
        `;
      })
      .join('');
  }

  renderEdges() {
    const width = Math.max(this.bounds().x + this.bounds().w + 480, this.stage.clientWidth);
    const height = Math.max(this.bounds().y + this.bounds().h + 320, this.stage.clientHeight);
    this.edgeLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.edgeLayer.setAttribute('width', String(width));
    this.edgeLayer.setAttribute('height', String(height));
    this.edgeLayer.style.width = `${width}px`;
    this.edgeLayer.style.height = `${height}px`;
    const laneIndexes = new Map();
    const displayEdges = [...this.graph.edges].sort(compareEdgePaintOrder);
    this.edgeLayer.innerHTML = displayEdges
      .map((edge, index) => {
        const route = this.edgeRoute(edge, laneIndexes, index);
        if (!route) return '';
        return `
          <path
            class="canvas-edge"
            data-edge-from="${escapeAttr(edge.from)}"
            data-edge-to="${escapeAttr(edge.to)}"
            data-edge-rel="${escapeAttr(edge.rel)}"
            d="${route.d}"
          />
          <text class="canvas-edge-label" x="${route.label.x}" y="${route.label.y}">${escapeHtml(relLabel(edge.rel))}</text>
        `;
      })
      .join('');
  }

  edgeRoute(edge, laneIndexes, index) {
    const fromBox = this.nodeBox(edge.from);
    const toBox = this.nodeBox(edge.to);
    if (!fromBox || !toBox) return null;

    const fromCenter = {
      x: fromBox.x + fromBox.width / 2,
      y: fromBox.y + fromBox.height / 2,
    };
    const toCenter = {
      x: toBox.x + toBox.width / 2,
      y: toBox.y + toBox.height / 2,
    };
    const forward = toCenter.x >= fromCenter.x;
    const from = {
      x: fromBox.x + (forward ? fromBox.width : 0),
      y: fromCenter.y,
    };
    const to = {
      x: toBox.x + (forward ? 0 : toBox.width),
      y: toCenter.y,
    };
    const key = `${edge.from}\0${edge.to}`;
    const laneIndex = laneIndexes.get(key) ?? 0;
    laneIndexes.set(key, laneIndex + 1);
    const sameRow = Math.abs(from.y - to.y) < 14;
    const lane = sameRow ? edgeLane(laneIndex, index) : edgeLane(laneIndex, index) * 0.45;
    const direction = forward ? 1 : -1;
    const distance = Math.max(80, Math.abs(to.x - from.x));
    const curve = Math.max(70, Math.min(260, distance * 0.36));
    const c1 = {
      x: from.x + curve * direction,
      y: from.y + lane,
    };
    const c2 = {
      x: to.x - curve * direction,
      y: to.y + lane,
    };
    const label = {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2 + lane - 6,
    };
    return {
      d: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`,
      label,
    };
  }

  positionToolbox() {
    const box = this.selectedId ? this.nodeBox(this.selectedId) : null;
    if (!box) {
      this.toolbox.hidden = true;
      return;
    }
    this.toolbox.hidden = false;
    this.toolbox.style.left = `${this.viewport.x + (box.x + box.width / 2) * this.viewport.scale}px`;
    this.toolbox.style.top = `${
      this.viewport.y + (box.y - SELECTION_BOUNDS_PADDING) * this.viewport.scale
    }px`;
  }

  nodeCenter(id) {
    const box = this.nodeBox(id);
    if (!box) return null;
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
  }

  bounds() {
    const boxes = this.graph.nodes
      .map(node => this.nodeBox(node.id))
      .filter(Boolean);
    if (boxes.length === 0) return {x: 0, y: 0, w: 1, h: 1};
    const minX = Math.min(...boxes.map(box => box.x));
    const minY = Math.min(...boxes.map(box => box.y));
    const maxX = Math.max(...boxes.map(box => box.x + box.width));
    const maxY = Math.max(...boxes.map(box => box.y + box.height));
    return {
      x: minX - 80,
      y: minY - 80,
      w: maxX - minX + 160,
      h: maxY - minY + 160,
    };
  }

  screenToWorld(point) {
    return {
      x: (point.x - this.viewport.x) / this.viewport.scale,
      y: (point.y - this.viewport.y) / this.viewport.scale,
    };
  }

  applyViewport() {
    this.grid.style.transform = `translate(${this.viewport.x}px, ${this.viewport.y}px) scale(${this.viewport.scale})`;
    this.positionToolbox();
  }

  nodeBox(id) {
    const pos = this.positionFor(id);
    if (!pos) return null;
    const element = this.nodeLayer.querySelector(`[data-node-id="${cssEscape(id)}"]`);
    return {
      x: pos.x,
      y: pos.y,
      width: element?.offsetWidth || NODE_FALLBACK_SIZE.width,
      height: element?.offsetHeight || NODE_FALLBACK_SIZE.height,
    };
  }

  persistPositions() {
    const out = Object.fromEntries(this.positions);
    localStorage.setItem(this.storageKey, JSON.stringify(out));
  }

  positionFor(id) {
    return this.viewPositions?.get(id) ?? this.positions.get(id);
  }
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function edgeLane(laneIndex, _edgeIndex) {
  const magnitude = 34 + Math.floor(laneIndex / 2) * 28;
  const sign = laneIndex % 2 === 0 ? -1 : 1;
  return magnitude * sign;
}

function compareEdgePaintOrder(left, right) {
  const rank = edgePaintRank(left.rel) - edgePaintRank(right.rel);
  if (rank !== 0) return rank;
  const source = left.from.localeCompare(right.from);
  if (source !== 0) return source;
  const target = left.to.localeCompare(right.to);
  if (target !== 0) return target;
  return left.rel.localeCompare(right.rel);
}

function compareCompactNodeOrder(centerId) {
  return (left, right) => {
    if (left.id === centerId) return -1;
    if (right.id === centerId) return 1;
    const kindRank = kindRankFor(left.kind) - kindRankFor(right.kind);
    if (kindRank !== 0) return kindRank;
    const label = left.label.localeCompare(right.label);
    if (label !== 0) return label;
    return left.id.localeCompare(right.id);
  };
}

function compactLayoutKey(graph, centerId) {
  const nodeIds = graph.nodes.map(node => node.id).sort().join('\0');
  const edgeIds = graph.edges
    .map(edge => `${edge.from}->${edge.to}:${edge.rel}`)
    .sort()
    .join('\0');
  return `${centerId ?? ''}\u0001${nodeIds}\u0001${edgeIds}`;
}

function kindRankFor(kind) {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

function edgePaintRank(rel) {
  if (foregroundEdgeRels.has(rel)) return 2;
  if (rel === 'visual_pack') return 1;
  return 0;
}

const foregroundEdgeRels = new Set([
  'contains',
  'generated_quest',
  'participant',
  'placed_item',
  'quest_hook',
  'related',
  'resident',
]);

function kindLabel(value) {
  return kindLabels[value] ?? value;
}

function relLabel(value) {
  return relLabels[value] ?? value;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll(' ', '-');
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}
