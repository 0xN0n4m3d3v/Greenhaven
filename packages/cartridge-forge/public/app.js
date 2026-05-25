import {CartridgeCanvas} from './canvas.js';

const kinds = [
  'activity',
  'dialogue',
  'event',
  'faction',
  'item',
  'location',
  'person',
  'quest',
  'relationship',
  'scene',
  'world_fact',
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
  building: 'Здание',
  generic: 'Общее',
};

const statusLabels = {
  draft: 'черновик',
  agent_reviewed: 'проверено агентом',
  human_reviewed: 'проверено человеком',
  rejected: 'отклонено',
  success: 'успех',
  failed: 'ошибка',
  skipped: 'пропущено',
  internal: 'внутренний',
  allowed: 'разрешено',
  disallowed: 'запрещено',
  not_checked: 'не проверено',
};

const levelLabels = {
  ok: 'успех',
  error: 'ошибка',
  warning: 'внимание',
};

const assetRoleLabels = {
  npc_sticker: 'стикер NPC',
  portrait: 'портрет',
  location_view: 'вид локации',
  building_view: 'вид здания',
  scene_plate: 'плашка сцены',
  item_icon: 'иконка предмета',
  mood_stamp: 'метка настроения',
  generic_sticker: 'общий стикер',
};

const state = {
  projects: [],
  activeSlug: null,
  project: null,
  sources: [],
  records: [],
  graph: {nodes: [], edges: [], issues: []},
  visuals: [],
  workflows: [],
  executions: [],
  selectedRecordSlug: null,
  selectedVisualName: null,
  graphFocusId: null,
  entitySearch: '',
  searchIndex: new Map(),
  busy: false,
  canvasMode: 'select',
  renderingInspector: false,
  autosaveTimer: null,
  autosaveSaving: false,
};

const dockLayoutVersion = 'canvas-first-v4';

const el = {
  projectForm: document.querySelector('#project-form'),
  projectSlug: document.querySelector('#project-slug'),
  projectList: document.querySelector('#project-list'),
  sourceForm: document.querySelector('#source-form'),
  sourceId: document.querySelector('#source-id'),
  sourceTitle: document.querySelector('#source-title'),
  sourceList: document.querySelector('#source-list'),
  activeProject: document.querySelector('#active-project'),
  projectTitle: document.querySelector('#project-title'),
  refreshBtn: document.querySelector('#refresh-btn'),
  importCurrentBtn: document.querySelector('#import-current-btn'),
  runWorkflowBtn: document.querySelector('#run-workflow-btn'),
  validateBtn: document.querySelector('#validate-btn'),
  exportBtn: document.querySelector('#export-btn'),
  exportSqlBtn: document.querySelector('#export-sql-btn'),
  kindFilter: document.querySelector('#kind-filter'),
  recordKind: document.querySelector('#record-kind'),
  recordForm: document.querySelector('#record-form'),
  recordSlug: document.querySelector('#record-slug'),
  recordName: document.querySelector('#record-name'),
  recordList: document.querySelector('#record-list'),
  recordCount: document.querySelector('#record-count'),
  graphCount: document.querySelector('#graph-count'),
  graphList: document.querySelector('#graph-list'),
  entitySearch: document.querySelector('#entity-search'),
  clearFocusBtn: document.querySelector('#clear-focus-btn'),
  validateGraphBtn: document.querySelector('#validate-graph-btn'),
  canvasStage: document.querySelector('#canvas-stage'),
  canvasGrid: document.querySelector('#canvas-grid'),
  canvasEdges: document.querySelector('#canvas-edges'),
  canvasNodes: document.querySelector('#canvas-nodes'),
  selectionToolbox: document.querySelector('#selection-toolbox'),
  contextMenu: document.querySelector('#context-menu'),
  canvasSelectBtn: document.querySelector('#canvas-select-btn'),
  canvasHandBtn: document.querySelector('#canvas-hand-btn'),
  canvasLinkBtn: document.querySelector('#canvas-link-btn'),
  fitCanvasBtn: document.querySelector('#fit-canvas-btn'),
  linkRel: document.querySelector('#link-rel'),
  statusLog: document.querySelector('#status-log'),
  executionList: document.querySelector('#execution-list'),
  inspectorSubtitle: document.querySelector('#inspector-subtitle'),
  aiFillBtn: document.querySelector('#ai-fill-btn'),
  inspectorKind: document.querySelector('#inspector-kind'),
  inspectorOperation: document.querySelector('#inspector-operation'),
  inspectorSlug: document.querySelector('#inspector-slug'),
  inspectorRecordId: document.querySelector('#inspector-record-id'),
  inspectorSourceLanguage: document.querySelector('#inspector-source-language'),
  inspectorName: document.querySelector('#inspector-name'),
  summaryInput: document.querySelector('#summary-input'),
  tagsInput: document.querySelector('#tags-input'),
  connectionPanel: document.querySelector('#connection-panel'),
  connectionRel: document.querySelector('#connection-rel'),
  connectionTarget: document.querySelector('#connection-target'),
  connectionAddBtn: document.querySelector('#connection-add-btn'),
  structuredFields: document.querySelector('#structured-fields'),
  payloadInput: document.querySelector('#payload-input'),
  linksInput: document.querySelector('#links-input'),
  provenanceInput: document.querySelector('#provenance-input'),
  qualityInput: document.querySelector('#quality-input'),
  autosaveStatus: document.querySelector('#autosave-status'),
  saveRecordBtn: document.querySelector('#save-record-btn'),
  newQuestBtn: document.querySelector('#new-quest-btn'),
  newVisualBtn: document.querySelector('#new-visual-btn'),
  attachVisualBtn: document.querySelector('#attach-visual-btn'),
  visualList: document.querySelector('#visual-list'),
  visualCount: document.querySelector('#visual-count'),
};

for (const kind of kinds) {
  el.kindFilter.append(option(kind, kindLabel(kind)));
  el.recordKind.append(option(kind, kindLabel(kind)));
  el.inspectorKind.append(option(kind, kindLabel(kind)));
}
el.recordKind.value = 'location';

const canvas = new CartridgeCanvas({
  stage: el.canvasStage,
  grid: el.canvasGrid,
  edgeLayer: el.canvasEdges,
  nodeLayer: el.canvasNodes,
  toolbox: el.selectionToolbox,
  onSelect: id => {
    if (id.startsWith('visual:')) {
      selectVisualByName(id.slice('visual:'.length));
      return;
    }
    selectRecord(id);
  },
  onFocus: id => {
    if (id.startsWith('visual:')) {
      selectVisualByName(id.slice('visual:'.length), {refocus: true});
      return;
    }
    focusRecord(id);
  },
  onLink: (from, to) => run('связать узлы полотна', () => linkCanvasNodes(from, to)),
  onQuest: id => run('создать квест', () => createQuestFromRecord(id)),
  onVisual: id => run('создать визуал', () => createVisualPack(id)),
  onContextMenu: context => openContextMenu(context),
});

const contextMenuHandlers = new Map();

el.projectForm.addEventListener('submit', async event => {
  event.preventDefault();
  await run('создать проект', async () => {
    const slug = el.projectSlug.value.trim();
    await api('/api/projects', {method: 'POST', body: {slug}});
    el.projectSlug.value = '';
    await loadProjects(slug);
  });
});

el.projectList.addEventListener('click', async event => {
  const item = event.target.closest('[data-project]');
  if (!item) return;
  await selectProject(item.dataset.project);
  collapseDock('projects');
});

el.recordList.addEventListener('click', event => {
  const item = event.target.closest('[data-record]');
  if (item) selectRecord(item.dataset.record);
});

el.graphList.addEventListener('click', event => {
  const item = event.target.closest('[data-graph-node]');
  if (!item) return;
  if (item.dataset.graphNode.startsWith('visual:')) selectVisualByName(item.dataset.graphNode.slice('visual:'.length));
  else selectRecord(item.dataset.graphNode);
});

el.visualList.addEventListener('click', event => {
  const item = event.target.closest('[data-visual]');
  if (!item) return;
  selectVisualByName(item.dataset.visual);
});

el.kindFilter.addEventListener('change', renderRecords);
el.refreshBtn.addEventListener('click', () => run('обновить', () => refreshActive()));
el.importCurrentBtn.addEventListener('click', () => run('импорт grinhaven-full', importCurrentCartridge));
el.runWorkflowBtn.addEventListener('click', () => run('запустить пайплайн', runDefaultWorkflow));
el.validateBtn.addEventListener('click', () => run('проверить', validateActive));
el.exportBtn.addEventListener('click', () => run('экспорт', exportActive));
el.exportSqlBtn.addEventListener('click', () => run('sql в игру', exportSqlActive));
el.validateGraphBtn.addEventListener('click', () => run('проверить граф', validateGraph));
el.entitySearch.addEventListener('input', event => {
  state.entitySearch = event.target.value;
  state.graphFocusId = null;
  renderWorkspace();
});
el.entitySearch.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    selectFirstSearchMatch();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    clearGraphFocus();
  }
});
el.clearFocusBtn.addEventListener('click', clearGraphFocus);
el.canvasSelectBtn.addEventListener('click', () => setCanvasMode('select'));
el.canvasHandBtn.addEventListener('click', () => setCanvasMode('hand'));
el.canvasLinkBtn.addEventListener('click', () => setCanvasMode('link'));
el.fitCanvasBtn.addEventListener('click', () => canvas.fit());
el.aiFillBtn.addEventListener('click', () => run('ии-заполнение', aiFillRecord));
el.saveRecordBtn.addEventListener('click', () => run('сохранить запись', saveRecord));
el.newQuestBtn.addEventListener('click', () => run('создать квест', () => createQuestFromRecord()));
el.newVisualBtn.addEventListener('click', () => run('создать визуал', createVisualPack));
el.attachVisualBtn.addEventListener('click', () => run('прикрепить визуал', attachVisualPack));
el.connectionAddBtn.addEventListener('click', () => run('связать сущности', addConnectionFromPanel));
document.addEventListener('input', event => {
  if (isInspectorField(event.target)) scheduleAutosave();
});
document.addEventListener('change', event => {
  if (isInspectorField(event.target)) scheduleAutosave();
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-add-structured-field]');
  if (!button) return;
  event.preventDefault();
  addStructuredField(button.dataset.addStructuredField);
});
document.addEventListener('click', event => {
  const target = event.target.closest('[data-open-record]');
  if (!target) return;
  event.preventDefault();
  selectRecord(target.dataset.openRecord);
  expandDock('inspector');
});
el.contextMenu.addEventListener('click', event => {
  const item = event.target.closest('[data-context-action]');
  if (!item || item.disabled) return;
  const handler = contextMenuHandlers.get(item.dataset.contextAction);
  closeContextMenu();
  if (handler) run(handler.label, handler.run);
});

document.addEventListener('click', event => {
  if (el.contextMenu.hidden || event.target.closest('#context-menu')) return;
  closeContextMenu();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!el.contextMenu.hidden) {
    closeContextMenu();
    return;
  }
  if (state.graphFocusId || state.entitySearch) {
    event.preventDefault();
    clearGraphFocus();
  }
});
window.addEventListener('resize', closeContextMenu);
el.canvasStage.addEventListener('wheel', closeContextMenu, {passive: true});

el.sourceForm.addEventListener('submit', async event => {
  event.preventDefault();
  await run('добавить источник', addSourceRecord);
});

el.recordForm.addEventListener('submit', async event => {
  event.preventDefault();
  await run('добавить запись', async () => {
    requireProject();
    const slug = el.recordSlug.value.trim();
    const name = el.recordName.value.trim() || titleFromSlug(slug);
    const kind = el.recordKind.value;
    await api(`/api/projects/${state.activeSlug}/records`, {
      method: 'POST',
      body: {
        kind,
        slug,
        name,
        summary: `${name}.`,
        tags: [kind, 'forge-draft'],
      },
    });
    el.recordSlug.value = '';
    el.recordName.value = '';
    await refreshActive();
    selectRecord(slug);
  });
});

bindDockNodes();
await loadProjects();

async function loadProjects(preferredSlug = null) {
  const data = await api('/api/projects');
  state.projects = data.projects;
  renderProjects();
  const next =
    preferredSlug ??
    state.activeSlug ??
    state.projects[0]?.slug ??
    null;
  if (next) await selectProject(next);
  else {
    renderWorkspace();
    log('ok', 'Готово. Создайте проект, чтобы начать.');
  }
}

async function selectProject(slug) {
  state.activeSlug = slug;
  state.selectedRecordSlug = null;
  state.selectedVisualName = null;
  state.graphFocusId = null;
  state.entitySearch = '';
  state.searchIndex = new Map();
  await refreshActive();
}

async function refreshActive() {
  if (!state.activeSlug) return;
  closeContextMenu();
  const data = await api(`/api/projects/${state.activeSlug}`);
  const graph = await api(`/api/projects/${state.activeSlug}/graph`);
  state.project = data.project;
  state.sources = data.sources;
  state.records = data.records;
  state.graph = graph.graph;
  state.visuals = data.visuals;
  state.workflows = data.workflows ?? [];
  state.executions = data.executions ?? [];
  state.searchIndex = new Map();
  normalizeGraphFocus();
  renderProjects();
  renderWorkspace();
}

function renderProjects() {
  if (state.projects.length === 0) {
    el.projectList.innerHTML = '<div class="empty">Проектов Forge пока нет.</div>';
    return;
  }
  el.projectList.innerHTML = state.projects
    .map(project => {
      const active = project.slug === state.activeSlug ? ' active' : '';
      return `
        <div class="project-item${active}" data-project="${escapeHtml(project.slug)}">
          <div class="item-title">
            <span>${escapeHtml(project.slug)}</span>
            <span class="pill">${project.counts.records}</span>
          </div>
          <div class="item-meta">${ruCount(project.counts.sources, 'источник', 'источника', 'источников')} / ${ruCount(project.counts.visuals, 'визуал', 'визуала', 'визуалов')} / ${ruCount(project.counts.executions ?? 0, 'запуск', 'запуска', 'запусков')}</div>
        </div>
      `;
    })
    .join('');
}

function renderWorkspace() {
  const slug = state.project?.project_slug ?? null;
  el.activeProject.textContent = slug ? `Активный проект / ${slug}` : 'Проект не выбран';
  el.projectTitle.textContent = slug ? state.project.pack_slug : 'Рабочее пространство';
  el.recordCount.textContent = ruCount(state.records.length, 'запись', 'записи', 'записей');
  el.visualCount.textContent = ruCount(state.visuals.length, 'набор', 'набора', 'наборов');
  const graphErrors = state.graph.issues.filter(issue => issue.level === 'error').length;
  const graphWarnings = state.graph.issues.length - graphErrors;
  const displayGraph = visibleGraph();
  const focusNode = state.graphFocusId ? graphNodeById(state.graphFocusId) : null;
  const searchActive = normalizedSearchTerms().length > 0;
  const issueText =
    graphErrors > 0
      ? `${ruCount(graphErrors, 'ошибка', 'ошибки', 'ошибок')} / ${ruCount(graphWarnings, 'предупреждение', 'предупреждения', 'предупреждений')}`
      : ruCount(graphWarnings, 'предупреждение', 'предупреждения', 'предупреждений');
  const scopeText = focusNode
    ? `Фокус: ${focusNode.label}`
    : searchActive
      ? `Поиск: ${state.entitySearch.trim()}`
      : 'Весь граф';
  el.graphCount.textContent = `${scopeText} / ${ruCount(displayGraph.nodes.length, 'узел', 'узла', 'узлов')} / ${ruCount(displayGraph.edges.length, 'связь', 'связи', 'связей')} из ${state.graph.nodes.length} / ${state.graph.edges.length} / ${issueText}`;
  el.entitySearch.value = state.entitySearch;
  el.clearFocusBtn.hidden = !state.graphFocusId && !searchActive;
  document.querySelector('.flow-node.source').textContent = `Источники ${state.sources.length}`;
  document.querySelector('.flow-node.records').textContent = `Сущности ${state.records.length}`;
  document.querySelector('.flow-node.visuals').textContent = `Визуалы ${state.visuals.length}`;
  canvas.setProject(slug);
  canvas.setGraph(displayGraph, selectedGraphId(), {
    compactLayout: Boolean(state.graphFocusId || searchActive),
    centerId: state.graphFocusId ?? firstSearchMatchId(displayGraph) ?? selectedGraphId(),
  });
  renderRecords();
  renderGraphList(displayGraph);
  renderSources();
  renderExecutions();
  renderInspector();
  renderVisuals();
}

function renderSources() {
  if (!state.activeSlug) {
    el.sourceList.innerHTML = '<div class="empty">Выберите проект.</div>';
    return;
  }
  if (state.sources.length === 0) {
    el.sourceList.innerHTML = '<div class="empty">Источников нет.</div>';
    return;
  }
  el.sourceList.innerHTML = state.sources
    .map(source => `
      <div class="source-item">
        <div class="item-title">
          <span>${escapeHtml(source.title)}</span>
          <span class="pill">${escapeHtml(statusLabel(source.robots_status))}</span>
        </div>
        <div class="item-meta">${escapeHtml(source.source_id)} / ${escapeHtml(source.license)}</div>
      </div>
    `)
    .join('');
}

function renderExecutions() {
  if (!state.activeSlug) {
    el.executionList.innerHTML = '<div class="empty">Проект не выбран.</div>';
    return;
  }
  if (state.executions.length === 0) {
    el.executionList.innerHTML = '<div class="empty">Запусков рабочих процессов пока нет.</div>';
    return;
  }
  el.executionList.innerHTML = state.executions
    .map(execution => `
      <div class="execution-item ${execution.status === 'failed' ? 'error' : 'ok'}">
        <div class="item-title">
          <span>${escapeHtml(execution.workflow_slug)}</span>
          <span class="pill">${escapeHtml(statusLabel(execution.status))}</span>
        </div>
        <div class="item-meta">${escapeHtml(execution.execution_id)} / ${ruCount(execution.error_count, 'ошибка', 'ошибки', 'ошибок')} / ${ruCount(execution.warning_count, 'предупреждение', 'предупреждения', 'предупреждений')}</div>
      </div>
    `)
    .join('');
}

function renderRecords() {
  const filter = el.kindFilter.value;
  const visibleRecordIds = new Set(visibleGraph().nodes.filter(node => !node.id.startsWith('visual:')).map(node => node.id));
  const searchTerms = normalizedSearchTerms();
  const records = state.records
    .filter(record => !filter || record.kind === filter)
    .filter(record => !state.graphFocusId || visibleRecordIds.has(record.slug))
    .filter(record => searchTerms.length === 0 || recordMatchesSearch(record, searchTerms))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.slug.localeCompare(b.slug));
  if (records.length === 0) {
    el.recordList.innerHTML = '<div class="empty">Под этот фильтр сущностей ничего не найдено.</div>';
    return;
  }
  el.recordList.innerHTML = records
    .map(record => {
      const active = record.slug === state.selectedRecordSlug ? ' active' : '';
      return `
        <div class="record-item${active}" data-record="${escapeHtml(record.slug)}">
          <div class="item-title">
            <span>${escapeHtml(record.canonical_name)}</span>
            <span class="pill">${escapeHtml(kindLabel(record.kind))}</span>
          </div>
          <div class="item-meta">${escapeHtml(record.slug)} / ${escapeHtml(statusLabel(record.quality.review_status))}</div>
          <div class="record-summary">${escapeHtml(previewText(record.summary, 220))}</div>
        </div>
      `;
    })
    .join('');
}

function renderGraphList(graph = visibleGraph()) {
  if (!state.activeSlug) {
    el.graphList.innerHTML = '<div class="empty">Проект не выбран.</div>';
    return;
  }
  if (graph.nodes.length === 0) {
    el.graphList.innerHTML = '<div class="empty">Узлов графа пока нет.</div>';
    return;
  }
  el.graphList.innerHTML = graph.nodes
    .slice(0, 24)
    .map(node => {
      const active = node.id === selectedGraphId() ? ' active' : '';
      return `
        <div class="graph-item${active}" data-graph-node="${escapeHtml(node.id)}">
          <div class="item-title">
            <span>${escapeHtml(node.label)}</span>
            <span class="pill">${escapeHtml(kindLabel(node.kind))}</span>
          </div>
          <div class="item-meta">${escapeHtml(node.slug)}</div>
        </div>
      `;
    })
    .join('');
}

function selectRecord(slug, options = {}) {
  if (!recordBySlug(slug)) return;
  const refocus = options.refocus ?? shouldRefocusGraphId(slug);
  state.selectedRecordSlug = slug;
  state.selectedVisualName = null;
  if (refocus) {
    state.graphFocusId = slug;
    state.entitySearch = '';
  }
  renderWorkspace();
}

function focusRecord(slug) {
  selectRecord(slug, {refocus: true});
}

function selectedRecord() {
  return state.records.find(record => record.slug === state.selectedRecordSlug) ?? null;
}

function recordBySlug(slug) {
  return state.records.find(record => record.slug === slug) ?? null;
}

function selectedGraphId() {
  return state.selectedVisualName ? `visual:${state.selectedVisualName}` : state.selectedRecordSlug;
}

function graphNodeById(id) {
  return state.graph.nodes.find(node => node.id === id) ?? null;
}

function shouldRefocusGraphId(id) {
  if (!state.graphFocusId) return true;
  return !visibleGraphContains(id);
}

function visibleGraphContains(id) {
  return visibleGraph().nodes.some(node => node.id === id);
}

function normalizeGraphFocus() {
  if (state.graphFocusId && !graphNodeById(state.graphFocusId)) {
    state.graphFocusId = null;
  }
}

function clearGraphFocus() {
  state.graphFocusId = null;
  state.entitySearch = '';
  renderWorkspace();
}

function selectFirstSearchMatch() {
  const terms = normalizedSearchTerms();
  const match =
    state.graph.nodes.find(node => terms.length > 0 && nodeMatchesSearch(node, terms)) ??
    visibleGraph().nodes[0];
  if (!match) return;
  if (match.id.startsWith('visual:')) selectVisualByName(match.id.slice('visual:'.length));
  else selectRecord(match.id);
}

function firstSearchMatchId(graph) {
  const terms = normalizedSearchTerms();
  if (terms.length === 0) return null;
  return graph.nodes.find(node => nodeMatchesSearch(node, terms))?.id ?? graph.nodes[0]?.id ?? null;
}

function visibleGraph() {
  const graph = state.graph ?? {nodes: [], edges: [], issues: [], roots: [], leaves: []};
  normalizeGraphFocus();
  if (state.graphFocusId) return relatedGraph(graph, state.graphFocusId);
  const searchTerms = normalizedSearchTerms();
  if (searchTerms.length > 0) return searchGraph(graph, searchTerms);
  return graph;
}

function relatedGraph(graph, centerId) {
  const seen = new Set([centerId]);
  for (const edge of graph.edges) {
    if (edge.from === centerId || edge.to === centerId) {
      seen.add(edge.from);
      seen.add(edge.to);
    }
  }
  return sliceGraph(graph, seen);
}

function searchGraph(graph, terms) {
  const matches = new Set();
  for (const node of graph.nodes) {
    if (nodeMatchesSearch(node, terms)) matches.add(node.id);
  }
  const seen = new Set(matches);
  for (const edge of graph.edges) {
    if (matches.has(edge.from) || matches.has(edge.to)) {
      seen.add(edge.from);
      seen.add(edge.to);
    }
  }
  return sliceGraph(graph, seen);
}

function sliceGraph(graph, ids) {
  return {
    nodes: graph.nodes.filter(node => ids.has(node.id)),
    edges: graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)),
    roots: graph.roots?.filter(root => ids.has(root)) ?? [],
    leaves: graph.leaves?.filter(leaf => ids.has(leaf)) ?? [],
    issues: graph.issues ?? [],
  };
}

function normalizedSearchTerms() {
  return state.entitySearch
    .trim()
    .toLocaleLowerCase('ru-RU')
    .split(/\s+/)
    .filter(Boolean);
}

function nodeMatchesSearch(node, terms) {
  const text = graphNodeSearchText(node);
  return terms.every(term => text.includes(term));
}

function recordMatchesSearch(record, terms) {
  return terms.every(term => recordSearchText(record).includes(term));
}

function graphNodeSearchText(node) {
  if (state.searchIndex.has(node.id)) return state.searchIndex.get(node.id);
  const record = recordBySlug(node.id);
  const text = record
    ? recordSearchText(record)
    : [
        node.id,
        node.slug,
        node.kind,
        kindLabel(node.kind),
        node.label,
        node.summary,
      ]
        .join(' ')
        .toLocaleLowerCase('ru-RU');
  state.searchIndex.set(node.id, text);
  return text;
}

function recordSearchText(record) {
  const key = `record:${record.slug}`;
  if (state.searchIndex.has(key)) return state.searchIndex.get(key);
  const text = [
    record.slug,
    record.record_id,
    record.kind,
    kindLabel(record.kind),
    record.canonical_name,
    record.summary,
    ...(record.tags ?? []),
    stringifySearchValue(record.payload),
    stringifySearchValue(record.links),
  ]
    .join(' ')
    .toLocaleLowerCase('ru-RU');
  state.searchIndex.set(key, text);
  return text;
}

function stringifySearchValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifySearchValue).join(' ');
  if (!isPlainObject(value)) return '';
  return Object.entries(value)
    .map(([key, item]) => `${key} ${stringifySearchValue(item)}`)
    .join(' ');
}

function renderInspector() {
  const record = selectedRecord();
  const disabled = !record;
  el.aiFillBtn.disabled = disabled || state.busy;
  el.saveRecordBtn.disabled = disabled || state.busy;
  el.newQuestBtn.disabled = disabled || record?.kind === 'quest' || state.busy;
  el.newVisualBtn.disabled = disabled || state.busy;
  state.renderingInspector = true;
  if (!record) {
    el.inspectorSubtitle.textContent = 'Выберите запись';
    el.inspectorKind.value = 'location';
    el.inspectorOperation.value = 'append';
    el.inspectorSlug.value = '';
    el.inspectorRecordId.value = '';
    el.inspectorSourceLanguage.value = '';
    el.inspectorName.value = '';
    el.summaryInput.value = '';
    el.tagsInput.value = '';
    el.payloadInput.value = '';
    el.linksInput.value = '';
    el.provenanceInput.value = '';
    el.qualityInput.value = '';
    el.structuredFields.innerHTML = '<div class="empty">Выберите запись.</div>';
    el.connectionPanel.innerHTML = '<div class="empty">Выберите запись.</div>';
    el.connectionTarget.innerHTML = '';
    el.connectionAddBtn.disabled = true;
    for (const field of inspectorFields()) field.disabled = true;
    setAutosaveStatus('Выберите запись');
    state.renderingInspector = false;
    return;
  }
  el.inspectorSubtitle.textContent = `${record.kind} / ${record.slug}`;
  el.inspectorKind.value = record.kind;
  el.inspectorOperation.value = record.operation;
  el.inspectorSlug.value = record.slug;
  el.inspectorRecordId.value = record.record_id;
  el.inspectorSourceLanguage.value = record.source_language;
  el.inspectorName.value = record.canonical_name;
  el.summaryInput.value = record.summary;
  el.tagsInput.value = record.tags.join(', ');
  el.payloadInput.value = JSON.stringify(record.payload, null, 2);
  el.linksInput.value = JSON.stringify(record.links ?? [], null, 2);
  el.provenanceInput.value = JSON.stringify(record.provenance ?? [], null, 2);
  el.qualityInput.value = JSON.stringify(record.quality ?? {}, null, 2);
  renderConnectionPanel(record);
  renderStructuredFields(record);
  for (const field of inspectorFields()) field.disabled = disabled;
  el.connectionAddBtn.disabled = disabled;
  setAutosaveStatus('Автосохранение готово');
  state.renderingInspector = false;
}

function renderVisuals() {
  const record = selectedRecord();
  const visible = record
    ? state.visuals.filter(visual => !visual.entity_slug || visual.entity_slug === record.slug)
    : state.visuals;
  el.attachVisualBtn.disabled = !state.activeSlug || !state.selectedVisualName || state.busy;
  if (visible.length === 0) {
    el.visualList.innerHTML = '<div class="empty">Здесь нет связанных визуальных наборов.</div>';
    return;
  }
  el.visualList.innerHTML = visible
    .map(visual => {
      const active = visual.name === state.selectedVisualName ? ' active' : '';
      return `
        <div class="visual-item${active}" data-visual="${escapeHtml(visual.name)}">
          <div class="item-title">
            <span>${escapeHtml(visual.name)}</span>
            <span class="pill">${visual.sticker_count}</span>
          </div>
          <div class="item-meta">${escapeHtml(kindLabel(visual.subject_kind))} / ${escapeHtml(assetRoleLabel(visual.asset_role))}</div>
        </div>
      `;
    })
    .join('');
}

async function saveRecord(options = {}) {
  const record = selectedRecord();
  if (!record) return;
  const updated = buildRecordFromInspector(record);
  const data = await api(`/api/projects/${state.activeSlug}/records/${record.slug}`, {
    method: 'PUT',
    body: updated,
  });
  await refreshActive();
  selectRecord(data.record.slug);
  if (!options.silent) log('ok', `Сохранено: ${data.record.slug}`);
  setAutosaveStatus(options.silent ? `Автосохранено ${new Date().toLocaleTimeString()}` : 'Сохранено');
}

function buildRecordFromInspector(record) {
  const kind = el.inspectorKind.value;
  const slug = el.inspectorSlug.value.trim();
  const canonicalName = el.inspectorName.value.trim();
  if (!slug) throw new Error('slug обязателен');
  if (!canonicalName) throw new Error('название обязательно');
  const payload = parseJsonField(el.payloadInput, 'payload');
  applyStructuredFields(payload);
  const links = applyStructuredLinks(parseJsonField(el.linksInput, 'links'));
  return {
    ...record,
    kind,
    slug,
    record_id: el.inspectorRecordId.value.trim() || `ghc:${kind}:${slug}`,
    operation: el.inspectorOperation.value,
    source_language: el.inspectorSourceLanguage.value.trim() || 'en',
    canonical_name: canonicalName,
    summary: el.summaryInput.value.trim(),
    tags: splitTags(el.tagsInput.value),
    payload,
    links,
    provenance: parseJsonField(el.provenanceInput, 'provenance'),
    quality: parseJsonField(el.qualityInput, 'quality'),
  };
}

function renderConnectionPanel(record) {
  const outgoing = state.graph.edges.filter(edge => edge.from === record.slug);
  const incoming = state.graph.edges.filter(edge => edge.to === record.slug);
  populateConnectionTargets(record.slug);
  el.connectionPanel.innerHTML = [
    renderConnectionGroup('Исходящие связи', outgoing, 'outgoing'),
    renderConnectionGroup('Обратные связи', incoming, 'incoming'),
  ].join('');
}

function renderConnectionGroup(title, edges, direction) {
  const body =
    edges.length > 0
      ? edges.map(edge => renderConnectionEdge(edge, direction)).join('')
      : '<div class="empty compact-empty">Связей пока нет.</div>';
  return `
    <div class="connection-group">
      <div class="connection-title">
        <span>${escapeHtml(title)}</span>
        <span class="pill">${edges.length}</span>
      </div>
      <div class="connection-list">${body}</div>
    </div>
  `;
}

function renderConnectionEdge(edge, direction) {
  const targetSlug = direction === 'outgoing' ? edge.to : edge.from;
  const target = recordBySlug(targetSlug);
  const title = target?.canonical_name ?? targetSlug;
  const meta = target
    ? `${kindLabel(target.kind)} / ${target.slug}`
    : targetSlug.startsWith('visual:')
      ? 'Визуальный набор'
      : 'Внешняя или отсутствующая запись';
  const open = target
    ? `<button type="button" data-open-record="${escapeHtml(target.slug)}">Открыть</button>`
    : '';
  return `
    <div class="connection-row ${target ? '' : 'missing'}">
      <div>
        <div class="connection-main">
          <span class="pill">${escapeHtml(edge.rel)}</span>
          <strong>${escapeHtml(title)}</strong>
        </div>
        <div class="item-meta">${escapeHtml(meta)}${edge.note ? ` / ${escapeHtml(edge.note)}` : ''}</div>
      </div>
      ${open}
    </div>
  `;
}

function populateConnectionTargets(currentSlug) {
  el.connectionTarget.innerHTML = state.records
    .filter(record => record.slug !== currentSlug)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.canonical_name.localeCompare(b.canonical_name))
    .map(
      record =>
        `<option value="${escapeHtml(record.slug)}">${escapeHtml(kindLabel(record.kind))} / ${escapeHtml(record.canonical_name)}</option>`,
    )
    .join('');
}

async function addConnectionFromPanel() {
  requireProject();
  const record = selectedRecord();
  if (!record) return;
  const rel = el.connectionRel.value;
  const target = el.connectionTarget.value;
  if (!target) throw new Error('цель связи обязательна');
  await api(`/api/projects/${state.activeSlug}/records/${record.slug}/link`, {
    method: 'POST',
    body: {rel, target},
  });
  await refreshActive();
  selectRecord(record.slug);
  log('ok', `Связано: ${record.slug} -> ${target}`);
}

function renderStructuredFields(record) {
  const payload = record.payload ?? {};
  const profile = parseProfilePayload(payload);
  const source = isPlainObject(profile.source) ? profile.source : {};
  const groups = [
    {
      scope: 'payload',
      title: 'Игровые свойства',
      entries: flattenStructuredEntries(payload).filter(entry => entry.path !== 'db_profile_json'),
      allowAdd: true,
    },
    {
      scope: 'profile',
      title: 'Системные свойства cartridge/runtime',
      entries: flattenStructuredEntries(profile).filter(
        entry => entry.path !== 'source' && !entry.path.startsWith('source.'),
      ),
      allowAdd: true,
    },
    {
      scope: 'source',
      title: 'Полный канон из датасета',
      entries: flattenStructuredEntries(source),
      allowAdd: true,
    },
    {
      scope: 'links',
      title: 'Ручные связи',
      entries: (record.links ?? []).flatMap((link, index) =>
        flattenStructuredValue(link, `[${index}]`, 0),
      ),
      allowAdd: true,
    },
  ];

  el.structuredFields.innerHTML = groups.map(renderStructuredGroup).join('');
}

function renderStructuredGroup(group) {
  const body =
    group.entries.length > 0
      ? group.entries
          .map((entry, index) => renderStructuredField(group.scope, entry.path, entry.value, index))
          .join('')
      : '<div class="empty compact-empty">Полей пока нет.</div>';
  return `
    <details class="structured-group" open>
      <summary>
        <span>${escapeHtml(group.title)}</span>
        <span class="pill">${group.entries.length}</span>
      </summary>
      <div class="structured-body">${body}</div>
      ${
        group.allowAdd
          ? `
            <div class="structured-add">
              <input data-new-field-key="${escapeHtml(group.scope)}" placeholder="new_field" autocomplete="off" />
              <button type="button" data-add-structured-field="${escapeHtml(group.scope)}">Добавить поле</button>
            </div>
          `
          : ''
      }
    </details>
  `;
}

function renderStructuredField(scope, key, value, index) {
  const type = structuredValueType(value);
  const label = scope === 'links' ? `link ${key}` : titleFromDataKey(key);
  const reference = typeof value === 'string' ? recordBySlug(value) : null;
  const commonAttrs = [
    `class="inspector-field structured-input${type === 'json' ? ' code-field' : ''}"`,
    `data-structured-scope="${escapeHtml(scope)}"`,
    `data-structured-key="${escapeHtml(key)}"`,
    `data-structured-type="${escapeHtml(type)}"`,
    scope === 'links' ? `data-structured-index="${index}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `
    <label class="structured-field">
      <span>${escapeHtml(label)}</span>
      <div class="structured-control-row">
        ${renderStructuredControl(value, type, commonAttrs)}
        ${
          reference
            ? `<button class="field-open-ref" type="button" data-open-record="${escapeHtml(reference.slug)}">Открыть</button>`
            : ''
        }
      </div>
    </label>
  `;
}

function renderStructuredControl(value, type, attrs) {
  if (type === 'boolean') {
    return `
      <select ${attrs}>
        <option value="true" ${value === true ? 'selected' : ''}>true</option>
        <option value="false" ${value === false ? 'selected' : ''}>false</option>
      </select>
    `;
  }
  if (type === 'number') {
    return `<input ${attrs} type="number" value="${escapeHtml(String(value))}" />`;
  }
  if (type === 'json') {
    const text = JSON.stringify(value, null, 2);
    return `<textarea ${attrs} rows="${structuredRows(text)}" spellcheck="false">${escapeHtml(text)}</textarea>`;
  }
  if (type === 'null') {
    return `<input ${attrs} value="" placeholder="null" />`;
  }
  const text = String(value ?? '');
  if (text.length > 90 || text.includes('\n')) {
    return `<textarea ${attrs} rows="${structuredRows(text)}">${escapeHtml(text)}</textarea>`;
  }
  return `<input ${attrs} value="${escapeHtml(text)}" />`;
}

function applyStructuredFields(payload) {
  const profile = parseProfilePayload(payload);
  const source = isPlainObject(profile.source) ? {...profile.source} : {};
  let profileChanged = false;

  for (const input of document.querySelectorAll('[data-structured-scope]')) {
    const scope = input.dataset.structuredScope;
    const key = input.dataset.structuredKey;
    if (!scope || !key) continue;
    const value = structuredInputValue(input);
    if (scope === 'payload') {
      setStructuredPath(payload, key, value);
    } else if (scope === 'profile') {
      setStructuredPath(profile, key, value);
      profileChanged = true;
    } else if (scope === 'source') {
      setStructuredPath(source, key, value);
      profile.source = source;
      profileChanged = true;
    }
  }

  if (profileChanged) payload.db_profile_json = JSON.stringify(profile);
}

function flattenStructuredEntries(value, prefix = '', depth = 0) {
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [{path: prefix, value}] : [];
    return value.flatMap((child, index) =>
      flattenStructuredValue(child, `${prefix}[${index}]`, depth),
    );
  }
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(...flattenStructuredValue(child, path, depth));
  }
  return out;
}

function flattenStructuredValue(value, path, depth) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{path, value}];
    return value.flatMap((child, index) =>
      flattenStructuredValue(child, `${path}[${index}]`, depth + 1),
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [{path, value}];
    return entries.flatMap(([key, child]) =>
      flattenStructuredValue(child, `${path}.${key}`, depth + 1),
    );
  }
  return [{path, value}];
}

function setStructuredPath(target, path, value) {
  const parts = parseStructuredPath(path);
  if (parts.length === 0) return;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const nextPart = parts[index + 1];
    if (typeof part === 'number') {
      if (!Array.isArray(cursor)) return;
      if (cursor[part] === undefined) cursor[part] = typeof nextPart === 'number' ? [] : {};
      cursor = cursor[part];
      continue;
    }
    if (!isPlainObject(cursor[part]) && !Array.isArray(cursor[part])) {
      cursor[part] = typeof nextPart === 'number' ? [] : {};
    }
    cursor = cursor[part];
  }
  const last = parts[parts.length - 1];
  cursor[last] = value;
}

function parseStructuredPath(path) {
  const tokens = [];
  const pattern = /([^[.\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = pattern.exec(String(path)))) {
    tokens.push(match[1] ?? Number(match[2]));
  }
  return tokens;
}

function applyStructuredLinks(links) {
  const out = cloneJson(links);
  for (const input of document.querySelectorAll('[data-structured-scope="links"]')) {
    const value = structuredInputValue(input);
    setStructuredPath(out, input.dataset.structuredKey, value);
  }
  return out
    .filter(link => isPlainObject(link))
    .map(link => {
      const rel = String(link.rel ?? '').trim();
      const target = String(link.target ?? '').trim();
      return {
        rel,
        target,
        ...(typeof link.note === 'string' && link.note.trim() ? {note: link.note.trim()} : {}),
      };
    })
    .filter(link => link.rel || link.target);
}

function addStructuredField(scope) {
  const record = selectedRecord();
  if (!record) return;
  const input = document.querySelector(`[data-new-field-key="${cssEscape(scope)}"]`);
  const key = input?.value?.trim();
  if (!key && scope !== 'links') {
    setAutosaveStatus('Имя нового поля обязательно', true);
    return;
  }
  try {
    const current = buildRecordFromInspector(record);
    if (scope === 'payload') {
      current.payload[key] ??= '';
      el.payloadInput.value = JSON.stringify(current.payload, null, 2);
    } else if (scope === 'profile' || scope === 'source') {
      const profile = parseProfilePayload(current.payload);
      if (scope === 'profile') profile[key] ??= '';
      else {
        const source = isPlainObject(profile.source) ? {...profile.source} : {};
        source[key] ??= '';
        profile.source = source;
      }
      current.payload.db_profile_json = JSON.stringify(profile);
      el.payloadInput.value = JSON.stringify(current.payload, null, 2);
    } else if (scope === 'links') {
      current.links = [...(current.links ?? []), {rel: 'related', target: '', note: ''}];
      el.linksInput.value = JSON.stringify(current.links, null, 2);
    }
    if (input) input.value = '';
    renderStructuredFields(current);
    scheduleAutosave();
  } catch (error) {
    setAutosaveStatus(error.message, true);
  }
}

function structuredInputValue(input) {
  const type = input.dataset.structuredType;
  if (type === 'json') {
    try {
      return JSON.parse(input.value || 'null');
    } catch (error) {
      throw new Error(`${input.dataset.structuredKey} JSON невалиден: ${error.message}`);
    }
  }
  if (type === 'number') return Number(input.value);
  if (type === 'boolean') return input.value === 'true';
  if (type === 'null' && input.value.trim() === '') return null;
  return input.value;
}

function structuredValueType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value) || isPlainObject(value)) return 'json';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

function parseProfilePayload(payload) {
  const raw = payload.db_profile_json;
  if (isPlainObject(raw)) return {...raw};
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function structuredRows(text) {
  const lines = String(text ?? '').split('\n').length;
  const byLength = Math.ceil(String(text ?? '').length / 90);
  return Math.max(2, Math.min(14, Math.max(lines, byLength)));
}

function titleFromDataKey(key) {
  return String(key)
    .replace(/\./g, ' / ')
    .replace(/\[(\d+)\]/g, ' #$1')
    .replace(/[_-]+/g, ' ')
    .replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonField(input, label) {
  try {
    const fallback = input === el.linksInput || input === el.provenanceInput ? '[]' : '{}';
    return JSON.parse(input.value || fallback);
  } catch (error) {
    throw new Error(`${label} JSON невалиден: ${error.message}`);
  }
}

function splitTags(value) {
  return value
    .split(/[,\n]/)
    .map(tag => tag.trim())
    .filter(Boolean);
}

function scheduleAutosave() {
  if (state.renderingInspector || state.autosaveSaving || !selectedRecord()) return;
  clearTimeout(state.autosaveTimer);
  setAutosaveStatus('Есть несохранённые изменения');
  state.autosaveTimer = setTimeout(() => {
    void autosaveRecord();
  }, 900);
}

async function autosaveRecord() {
  if (!selectedRecord()) return;
  if (state.busy) {
    scheduleAutosave();
    return;
  }
  state.autosaveSaving = true;
  try {
    buildRecordFromInspector(selectedRecord());
    setAutosaveStatus('Сохраняю...');
    await saveRecord({silent: true});
  } catch (error) {
    setAutosaveStatus(error.message, true);
  } finally {
    state.autosaveSaving = false;
  }
}

function setAutosaveStatus(message, error = false) {
  if (!el.autosaveStatus) return;
  el.autosaveStatus.textContent = message;
  el.autosaveStatus.classList.toggle('error', error);
}

function inspectorFields() {
  return document.querySelectorAll('.inspector-field');
}

function isInspectorField(target) {
  return target instanceof Element && target.classList.contains('inspector-field');
}

async function aiFillRecord() {
  const record = selectedRecord();
  if (!record) return;
  const data = await api(`/api/projects/${state.activeSlug}/records/${record.slug}/ai-fill`, {
    method: 'POST',
  });
  await refreshActive();
  selectRecord(data.record.slug);
  log('ok', `ИИ заполнил запись: ${data.record.slug}`);
}

async function createQuestFromRecord(recordSlug = state.selectedRecordSlug) {
  requireProject();
  const record = state.records.find(row => row.slug === recordSlug);
  if (!record || record.kind === 'quest') return;
  const data = await api(`/api/projects/${state.activeSlug}/records/${record.slug}/create-quest`, {
    method: 'POST',
  });
  await refreshActive();
  selectRecord(data.quest.slug);
  log('ok', `Создан квест: ${data.quest.slug}`);
}

async function linkCanvasNodes(from, to) {
  requireProject();
  if (from.startsWith('visual:') || to.startsWith('visual:')) {
    throw new Error('визуальные узлы связываются через визуальные наборы');
  }
  const rel = el.linkRel.value || 'related';
  const relText = el.linkRel.selectedOptions[0]?.textContent ?? rel;
  const data = await api(`/api/projects/${state.activeSlug}/records/${from}/link`, {
    method: 'POST',
    body: {rel, target: to},
  });
  await refreshActive();
  selectRecord(data.record.slug);
  log('ok', `Связано: ${from} -> ${to} как ${relText}`);
}

async function createVisualPack(recordSlug = state.selectedRecordSlug) {
  const record = state.records.find(row => row.slug === recordSlug);
  if (!record) return;
  const name = `${record.slug}-visual`;
  const subjectKind =
    record.kind === 'person' || record.kind === 'location' || record.kind === 'scene' || record.kind === 'item'
      ? record.kind
      : 'generic';
  const data = await api(`/api/projects/${state.activeSlug}/visuals`, {
    method: 'POST',
    body: {name, subjectKind, entitySlug: record.slug},
  });
  await refreshActive();
  state.selectedVisualName = data.pack.name;
  renderVisuals();
  log('ok', `Создан визуальный набор: ${data.pack.name}`);
}

async function attachVisualPack() {
  requireProject();
  const name = state.selectedVisualName;
  if (!name) return;
  await api(`/api/projects/${state.activeSlug}/visuals/${name}/manifest`, {method: 'POST'});
  const data = await api(`/api/projects/${state.activeSlug}/visuals/${name}/attach`, {method: 'POST'});
  await refreshActive();
  log('ok', `Прикреплено: ${ruCount(data.attached, 'визуальная запись', 'визуальные записи', 'визуальных записей')}`);
}

async function addSourceRecord() {
  requireProject();
  const sourceId = el.sourceId.value.trim();
  const title = el.sourceTitle.value.trim();
  await api(`/api/projects/${state.activeSlug}/sources`, {
    method: 'POST',
    body: {
      source_id: sourceId,
      title,
      license: 'internal',
      robots_status: 'internal',
      notes: 'Добавлено из интерфейса Cartridge Forge.',
    },
  });
  el.sourceId.value = '';
  el.sourceTitle.value = '';
  await refreshActive();
  log('ok', `Добавлен источник: ${sourceId}`);
}

async function runDefaultWorkflow() {
  requireProject();
  const workflow = state.workflows[0]?.workflow_slug ?? 'default-export';
  const result = await api(`/api/projects/${state.activeSlug}/workflows/${workflow}/run`, {
    method: 'POST',
  });
  el.statusLog.innerHTML = '';
  for (const node of [...result.logs].reverse()) {
    const level = node.status === 'failed' ? 'error' : node.warnings.length > 0 ? 'warning' : 'ok';
    log(level, `${node.node_id} / ${node.node_type}: ${node.summary}`);
    for (const error of node.errors) log('error', `${node.node_id}: ${error}`);
    for (const warning of node.warnings) log('warning', `${node.node_id}: ${warning}`);
  }
  await refreshActive();
  if (result.succeeded) {
    log('ok', `Пайплайн выполнен: ${result.execution.execution_id}`);
  } else {
    log('error', `Пайплайн упал: ${result.execution.execution_id}`);
  }
}

async function validateActive() {
  requireProject();
  const result = await api(`/api/projects/${state.activeSlug}/validate`, {method: 'POST'});
  el.statusLog.innerHTML = '';
  if (result.ok) {
    log('ok', `Проверка пройдена: ${ruCount(result.counts.records, 'запись', 'записи', 'записей')}`);
  }
  for (const issue of result.errors) log('error', `${issue.file}: ${issue.message}`);
  for (const issue of result.warnings) log('warning', `${issue.file}: ${issue.message}`);
  if (!result.ok) log('error', `Блокирующих ошибок: ${result.errors.length}`);
}

async function validateGraph() {
  requireProject();
  const result = await api(`/api/projects/${state.activeSlug}/graph/validate`, {method: 'POST'});
  state.graph = result.graph;
  canvas.setGraph(state.graph, state.selectedRecordSlug);
  renderGraphList();
  el.statusLog.innerHTML = '';
  if (result.ok) {
    log('ok', `Граф проверен: ${ruCount(state.graph.nodes.length, 'узел', 'узла', 'узлов')}`);
  }
  for (const issue of result.errors) log('error', `${issue.file}: ${issue.message}`);
  for (const issue of result.warnings) log('warning', `${issue.file}: ${issue.message}`);
}

async function exportActive() {
  requireProject();
  const result = await api(`/api/projects/${state.activeSlug}/export`, {method: 'POST'});
  log('ok', `Экспортирован пакет агента: ${result.path}`);
}

async function importCurrentCartridge() {
  const slug = el.projectSlug.value.trim() || 'grinhaven-full-current';
  const result = await api('/api/projects/import-grinhaven-current', {
    method: 'POST',
    body: {slug},
  });
  el.projectSlug.value = '';
  await loadProjects(result.projectSlug);
  log('ok', `Импортирован grinhaven-full: ${result.records} записей`);
}

async function exportSqlActive() {
  requireProject();
  const result = await api(`/api/projects/${state.activeSlug}/export-grinhaven-sql`, {
    method: 'POST',
  });
  log('ok', `SQL-патч для Greenhaven: ${result.path}`);
}

function setCanvasMode(mode) {
  closeContextMenu();
  state.canvasMode = mode;
  canvas.setMode(mode);
  el.canvasSelectBtn.classList.toggle('active', mode === 'select');
  el.canvasHandBtn.classList.toggle('active', mode === 'hand');
  el.canvasLinkBtn.classList.toggle('active', mode === 'link');
}

function openContextMenu(context) {
  if (context.type === 'node' && context.nodeId) selectRecord(context.nodeId, {refocus: false});
  if (context.type === 'visual-node' && context.nodeId) {
    state.selectedRecordSlug = null;
    state.selectedVisualName = context.nodeId.slice('visual:'.length);
    renderRecords();
    renderGraphList();
    renderInspector();
    renderVisuals();
  }

  const menu = contextMenuFor(context);
  renderContextMenu(menu, context.client);
}

function closeContextMenu() {
  if (!el.contextMenu || el.contextMenu.hidden) return;
  el.contextMenu.hidden = true;
  el.contextMenu.innerHTML = '';
  contextMenuHandlers.clear();
}

function contextMenuFor(context) {
  if (!state.activeSlug) {
    return {
      title: 'Forge Canvas',
      subtitle: 'Проект не выбран',
      items: [disabledAction('project-required', 'Сначала создайте или выберите проект')],
    };
  }

  if (context.type === 'edge' && context.edge) return edgeContextMenu(context.edge);
  if (context.type === 'visual-node' && context.nodeId) return visualContextMenu(context.nodeId);
  if (context.type === 'node' && context.nodeId) return nodeContextMenu(context.nodeId, context);
  return canvasContextMenu(context);
}

function canvasContextMenu(context) {
  return {
    title: 'Полотно',
    subtitle: 'Создание сущностей и управление графом',
    items: [
      action('canvas-create-location', 'Создать локацию здесь', 'Новая локация на месте курсора', () =>
        createRecordAt('location', context.world),
      ),
      action('canvas-create-scene', 'Создать сцену здесь', 'Сцена получит базовые поля проекта', () =>
        createRecordAt('scene', context.world),
      ),
      action('canvas-create-person', 'Создать NPC здесь', 'NPC будет привязан к первой локации проекта', () =>
        createRecordAt('person', context.world),
      ),
      action('canvas-create-item', 'Создать предмет здесь', 'Предмет с игровым use_contract', () =>
        createRecordAt('item', context.world),
      ),
      divider(),
      action('canvas-fit', 'Вписать граф', 'Центрировать все узлы', () => canvas.fit(), {
        disabled: state.graph.nodes.length === 0,
      }),
      action('canvas-mode-select', 'Режим выбора', 'Выбор и перетаскивание узлов', () => setCanvasMode('select')),
      action('canvas-mode-hand', 'Режим перемещения', 'Панорамирование полотна', () => setCanvasMode('hand')),
      action('canvas-mode-link', 'Режим связи', 'Кликните два узла для связи', () => setCanvasMode('link')),
      divider(),
      action('canvas-validate-graph', 'Проверить граф', 'Показать структурные ошибки и предупреждения', validateGraph),
      action('canvas-export-sql', 'Экспорт SQL в игру', 'Собрать SQL-патч для Greenhaven', exportSqlActive),
      action('canvas-import-current', 'Импорт grinhaven-full', 'Загрузить текущий полный картридж', importCurrentCartridge),
    ],
  };
}

function nodeContextMenu(nodeId, context) {
  const record = state.records.find(row => row.slug === nodeId);
  if (!record) return canvasContextMenu(context);
  const world = offsetWorld(context.world, 280, 72);
  const items = [
    action('node-open-inspector', 'Открыть в инспекторе', 'Развернуть карточку записи', () => {
      selectRecord(record.slug);
      expandDock('inspector');
    }),
    action('node-ai-fill', 'ИИ-заполнение', 'Догенерировать описание и payload', () => aiFillRecordFor(record.slug)),
    action('node-create-quest', 'Создать квест', 'Квест будет связан с этой записью', () => createQuestFromRecord(record.slug), {
      disabled: record.kind === 'quest',
    }),
    action('node-create-visual', 'Создать визуальный набор', 'Стикеры/иконки для выбранной сущности', () =>
      createVisualPack(record.slug),
    ),
    action('node-start-link', 'Начать связь отсюда', 'Следующий клик по узлу создаст связь', () => startLinkFromNode(record.slug)),
    action('node-focus-local', 'Показать связи вокруг этой карточки', 'Пересобрать компактный граф от выбранной сущности', () =>
      focusRecord(record.slug),
    ),
    divider(),
    ...childActionsForRecord(record, world),
    divider(),
    action('node-duplicate-draft', 'Дублировать как черновик', 'Копия без ручных связей рядом с узлом', () =>
      duplicateRecord(record.slug, world),
    ),
  ];
  return {
    title: record.canonical_name || record.slug,
    subtitle: `${kindLabel(record.kind)} / ${record.slug}`,
    items,
  };
}

function childActionsForRecord(record, world) {
  if (record.kind === 'location') {
    return [
      action('node-child-scene', 'Добавить сцену внутри', 'Сцена получит location_slug этой локации', () =>
        createRecordAt('scene', world, {
          slugBase: `${record.slug}-scene`,
          name: `Сцена ${record.canonical_name}`,
          payloadPatch: {location_slug: record.slug},
        }),
      ),
      action('node-child-person', 'Поселить NPC здесь', 'NPC получит home_slug этой локации', () =>
        createRecordAt('person', offsetWorld(world, 0, 170), {
          slugBase: `${record.slug}-npc`,
          name: `NPC ${record.canonical_name}`,
          payloadPatch: {home_slug: record.slug},
        }),
      ),
      action('node-child-item', 'Положить предмет здесь', 'Предмет получит location_slug этой локации', () =>
        createRecordAt('item', offsetWorld(world, 0, 340), {
          slugBase: `${record.slug}-item`,
          name: `Предмет ${record.canonical_name}`,
          payloadPatch: {holder_slug: null, location_slug: record.slug},
        }),
      ),
    ];
  }

  if (record.kind === 'scene') {
    const locationSlug = record.payload?.location_slug ?? firstLocationSlug();
    return [
      action('node-scene-person', 'Добавить участника сцены', 'NPC получит scene_slug и home_slug', () =>
        createRecordAt('person', world, {
          slugBase: `${record.slug}-participant`,
          name: `Участник ${record.canonical_name}`,
          payloadPatch: {
            home_slug: locationSlug,
            scene_slug: record.slug,
          },
        }),
      ),
      action('node-scene-item', 'Добавить предмет сцены', 'Предмет будет виден в этой сцене', () =>
        createRecordAt('item', offsetWorld(world, 0, 170), {
          slugBase: `${record.slug}-item`,
          name: `Предмет ${record.canonical_name}`,
          payloadPatch: {
            location_slug: locationSlug,
            scene_slug: record.slug,
          },
        }),
      ),
    ];
  }

  if (record.kind === 'person') {
    return [
      action('node-person-item', 'Дать предмет NPC', 'Предмет получит holder_slug этого NPC', () =>
        createRecordAt('item', world, {
          slugBase: `${record.slug}-item`,
          name: `Предмет ${record.canonical_name}`,
          payloadPatch: {
            holder_slug: record.slug,
            location_slug: record.payload?.home_slug ?? firstLocationSlug(),
          },
        }),
      ),
    ];
  }

  if (record.kind === 'item') {
    return [
      action('node-item-quest', 'Сделать квест из предмета', 'Предмет станет quest_source_item', () =>
        createRecordAt('quest', world, {
          slugBase: `${record.slug}-quest`,
          name: `Квест ${record.canonical_name}`,
          payloadPatch: {
            source_item_slug: record.slug,
            giver_slug: firstPersonSlug() ?? `${record.slug}-giver`,
            start_location_slug: record.payload?.location_slug ?? firstLocationSlug() ?? `${record.slug}-start`,
            prepared_entity_slugs: [record.slug, firstPersonSlug(), firstLocationSlug()].filter(Boolean),
          },
        }),
      ),
    ];
  }

  return [disabledAction('node-no-child-actions', 'Нет специальных дочерних действий')];
}

function visualContextMenu(nodeId) {
  const name = nodeId.slice('visual:'.length);
  const visual = state.visuals.find(row => row.name === name);
  return {
    title: visual?.name ?? name,
    subtitle: visual
      ? `${kindLabel(visual.subject_kind)} / ${assetRoleLabel(visual.asset_role)}`
      : 'Визуальный набор',
    items: [
      action('visual-select', 'Выбрать визуальный набор', 'Показать его в панели визуалов', () => selectVisualByName(name)),
      action('visual-open-entity', 'Открыть связанную запись', 'Перейти к сущности набора', () => {
        if (visual?.entity_slug) selectRecord(visual.entity_slug);
      }, {
        disabled: !visual?.entity_slug,
      }),
      divider(),
      action('visual-rebuild-manifest', 'Пересобрать manifest', 'Обновить описание файлов набора', () =>
        rebuildVisualManifest(name),
      ),
      action('visual-attach', 'Прикрепить к записи', 'Записать visual_assets в сущность', () => attachVisualByName(name)),
    ],
  };
}

function edgeContextMenu(edge) {
  const from = state.records.find(row => row.slug === edge.from);
  const to = state.records.find(row => row.slug === edge.to);
  return {
    title: `${edge.from} -> ${edge.to}`,
    subtitle: `Связь / ${edge.rel}`,
    items: [
      action('edge-open-source', 'Открыть источник', from?.canonical_name ?? edge.from, () => selectRecord(edge.from), {
        disabled: !from,
      }),
      action('edge-open-target', 'Открыть цель', to?.canonical_name ?? edge.to, () => selectRecord(edge.to), {
        disabled: !to,
      }),
      action('edge-create-reverse', 'Создать обратную связь', `${edge.to} -> ${edge.from}`, () => createReverseLink(edge), {
        disabled: edge.from.startsWith('visual:') || edge.to.startsWith('visual:'),
      }),
      divider(),
      action(
        'edge-remove-link',
        'Удалить ручную связь',
        'Удаляет только связь из links, не payload/visual',
        () => removeEdgeLink(edge),
        {
          danger: true,
          disabled: edge.from.startsWith('visual:') || edge.to.startsWith('visual:'),
        },
      ),
    ],
  };
}

function renderContextMenu(menu, client) {
  if (el.contextMenu.parentElement !== document.body) document.body.appendChild(el.contextMenu);
  contextMenuHandlers.clear();
  const entries = [];
  for (const item of menu.items) {
    if (item.type === 'divider') {
      entries.push('<div class="context-menu-divider" role="separator"></div>');
      continue;
    }
    if (!item.disabled && item.run) contextMenuHandlers.set(item.id, item);
    const classes = [
      'context-menu-entry',
      item.danger ? 'danger' : '',
      item.disabled ? 'disabled' : '',
    ]
      .filter(Boolean)
      .join(' ');
    entries.push(`
      <button
        class="${classes}"
        type="button"
        role="menuitem"
        data-context-action="${escapeHtml(item.id)}"
        ${item.disabled ? 'disabled' : ''}
      >
        <span>${escapeHtml(item.label)}</span>
        ${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ''}
      </button>
    `);
  }

  el.contextMenu.innerHTML = `
    <div class="context-menu-head">
      <strong>${escapeHtml(menu.title)}</strong>
      <small>${escapeHtml(menu.subtitle ?? '')}</small>
    </div>
    ${entries.join('')}
  `;
  el.contextMenu.hidden = false;

  const menuRect = el.contextMenu.getBoundingClientRect();
  const left = clamp(client.x, 8, Math.max(8, window.innerWidth - menuRect.width - 8));
  const top = clamp(client.y, 8, Math.max(8, window.innerHeight - menuRect.height - 8));
  el.contextMenu.style.left = `${left}px`;
  el.contextMenu.style.top = `${top}px`;
}

function action(id, label, hint, run, options = {}) {
  return {
    type: 'action',
    id,
    label,
    hint,
    run,
    danger: Boolean(options.danger),
    disabled: Boolean(options.disabled),
  };
}

function disabledAction(id, label) {
  return action(id, label, '', () => {}, {disabled: true});
}

function divider() {
  return {type: 'divider'};
}

async function createRecordAt(kind, worldPoint, options = {}) {
  requireProject();
  const index = state.records.filter(record => record.kind === kind).length + 1;
  const slug = uniqueSlug(options.slugBase ?? `${kind}-${index}`);
  const name = options.name ?? `${kindLabel(kind)} ${index}`;
  const data = await api(`/api/projects/${state.activeSlug}/records`, {
    method: 'POST',
    body: {
      kind,
      slug,
      name,
      summary: options.summary ?? `${name}.`,
      tags: options.tags ?? [kind, 'forge-draft', 'canvas-created'],
      ...(options.payload ? {payload: options.payload} : {}),
    },
  });

  let record = data.record;
  if (options.payloadPatch) {
    const updated = await api(`/api/projects/${state.activeSlug}/records/${record.slug}`, {
      method: 'PUT',
      body: {
        ...record,
        payload: {...record.payload, ...options.payloadPatch},
      },
    });
    record = updated.record;
  }

  await refreshActive();
  canvas.setNodePosition(record.slug, roundWorldPoint(worldPoint));
  selectRecord(record.slug);
  log('ok', `Создано на полотне: ${record.slug}`);
}

async function duplicateRecord(recordSlug, worldPoint) {
  const record = state.records.find(row => row.slug === recordSlug);
  if (!record) return;
  const payload = cloneJson(record.payload);
  payload.copied_from_slug = record.slug;
  await createRecordAt(record.kind, worldPoint, {
    slugBase: `${record.slug}-copy`,
    name: `${record.canonical_name} копия`,
    summary: record.summary,
    tags: uniqueList([...record.tags, 'forge-draft', 'copy']),
    payload,
  });
}

async function aiFillRecordFor(recordSlug) {
  selectRecord(recordSlug);
  await aiFillRecord();
}

function startLinkFromNode(recordSlug) {
  selectRecord(recordSlug);
  canvas.startLinkFrom(recordSlug);
  state.canvasMode = 'link';
  el.canvasSelectBtn.classList.remove('active');
  el.canvasHandBtn.classList.remove('active');
  el.canvasLinkBtn.classList.add('active');
  log('ok', `Выбран источник связи: ${recordSlug}`);
}

function selectVisualByName(name, options = {}) {
  const graphId = `visual:${name}`;
  const refocus = options.refocus ?? shouldRefocusGraphId(graphId);
  state.selectedRecordSlug = null;
  state.selectedVisualName = name;
  if (refocus) {
    state.graphFocusId = graphId;
    state.entitySearch = '';
  }
  renderWorkspace();
  expandDock('visuals');
}

async function rebuildVisualManifest(name) {
  requireProject();
  await api(`/api/projects/${state.activeSlug}/visuals/${name}/manifest`, {method: 'POST'});
  await refreshActive();
  state.selectedVisualName = name;
  renderVisuals();
  log('ok', `Manifest пересобран: ${name}`);
}

async function attachVisualByName(name) {
  requireProject();
  state.selectedVisualName = name;
  await attachVisualPack();
}

async function createReverseLink(edge) {
  requireProject();
  if (edge.from.startsWith('visual:') || edge.to.startsWith('visual:')) {
    throw new Error('визуальные связи создаются через visual pack');
  }
  await api(`/api/projects/${state.activeSlug}/records/${edge.to}/link`, {
    method: 'POST',
    body: {rel: edge.rel, target: edge.from},
  });
  await refreshActive();
  selectRecord(edge.to);
  log('ok', `Создана обратная связь: ${edge.to} -> ${edge.from}`);
}

async function removeEdgeLink(edge) {
  requireProject();
  if (edge.from.startsWith('visual:') || edge.to.startsWith('visual:')) {
    throw new Error('visual edge удаляется через визуальный набор');
  }
  const result = await api(`/api/projects/${state.activeSlug}/records/${edge.from}/link`, {
    method: 'DELETE',
    body: {rel: edge.rel, target: edge.to},
  });
  await refreshActive();
  if (result.removed > 0) {
    log('ok', `Удалена ручная связь: ${edge.from} -> ${edge.to}`);
  } else {
    log('warning', 'Эта связь собрана из payload/visual, удаляйте поле в инспекторе');
  }
}

function firstLocationSlug() {
  return state.records.find(record => record.kind === 'location')?.slug ?? null;
}

function firstPersonSlug() {
  return state.records.find(record => record.kind === 'person')?.slug ?? null;
}

function uniqueSlug(base) {
  const clean = slugifyLocal(base) || 'record';
  const existing = new Set(state.records.map(record => record.slug));
  if (!existing.has(clean)) return clean;
  for (let index = 2; index < 1000; index += 1) {
    const next = `${clean}-${index}`;
    if (!existing.has(next)) return next;
  }
  return `${clean}-${Date.now()}`;
}

function slugifyLocal(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

function offsetWorld(point, dx = 0, dy = 0) {
  return {
    x: Number(point?.x ?? 0) + dx,
    y: Number(point?.y ?? 0) + dy,
  };
}

function roundWorldPoint(point) {
  return {
    x: Math.round(Number(point?.x ?? 0)),
    y: Math.round(Number(point?.y ?? 0)),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function expandDock(dock) {
  const panel = document.querySelector(`.dock-node[data-dock="${cssEscape(dock)}"]`);
  if (panel) setDockCollapsed(panel, false);
}

async function run(label, fn) {
  if (state.busy) return;
  state.busy = true;
  setBusy(true);
  try {
    await fn();
  } catch (error) {
    log('error', `${label}: ${error.message}`);
  } finally {
    state.busy = false;
    setBusy(false);
  }
}

function setBusy(busy) {
  for (const button of document.querySelectorAll('button')) {
    button.disabled = busy && button.id !== 'refresh-btn';
  }
  renderInspector();
  renderVisuals();
}

async function api(path, options = {}) {
  const init = {method: options.method ?? 'GET', headers: {}};
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) {
    throw new Error(data.error ?? JSON.stringify(data.errors ?? data));
  }
  return data;
}

function requireProject() {
  if (!state.activeSlug) throw new Error('сначала выберите или создайте проект');
}

function log(level, message) {
  const item = document.createElement('div');
  item.className = `log-item ${level}`;
  item.textContent = `[${levelLabel(level)}] ${message}`;
  el.statusLog.prepend(item);
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function kindLabel(value) {
  return kindLabels[value] ?? value;
}

function statusLabel(value) {
  return statusLabels[value] ?? value;
}

function levelLabel(value) {
  return levelLabels[value] ?? value;
}

function assetRoleLabel(value) {
  return assetRoleLabels[value] ?? value;
}

function bindDockNodes() {
  if (localStorage.getItem('forge-dock-layout-version') !== dockLayoutVersion) {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('forge-dock:') || key.startsWith('forge-dock-pos:')) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem('forge-dock-layout-version', dockLayoutVersion);
  }

  for (const panel of document.querySelectorAll('.dock-node[data-dock]')) {
    const stored = localStorage.getItem(dockStorageKey(panel.dataset.dock));
    const collapsed = stored === null ? true : stored === '1';
    setDockCollapsed(panel, collapsed);
    bindDockDrag(panel);
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-dock-toggle]');
    if (!button) return;
    const dock = button.dataset.dockToggle;
    const panel = document.querySelector(`.dock-node[data-dock="${cssEscape(dock)}"]`);
    if (!panel) return;
    setDockCollapsed(panel, !panel.classList.contains('collapsed'));
  });
}

function setDockCollapsed(panel, collapsed) {
  panel.classList.toggle('collapsed', collapsed);
  localStorage.setItem(dockStorageKey(panel.dataset.dock), collapsed ? '1' : '0');
  const button = panel.querySelector(`[data-dock-toggle="${cssEscape(panel.dataset.dock)}"]`);
  if (button) button.textContent = collapsed ? 'Развернуть' : 'Свернуть';
  if (collapsed) clearDockPosition(panel);
  else applyDockPosition(panel);
}

function collapseDock(dock) {
  const panel = document.querySelector(`.dock-node[data-dock="${cssEscape(dock)}"]`);
  if (panel) setDockCollapsed(panel, true);
}

function dockStorageKey(dock) {
  return `forge-dock:${dock}:collapsed`;
}

function dockPositionKey(dock) {
  return `forge-dock-pos:${dock}`;
}

function bindDockDrag(panel) {
  const handle = panel.querySelector('.dock-head, .panel-head');
  if (!handle) return;
  handle.addEventListener('pointerdown', event => {
    if (panel.classList.contains('collapsed')) return;
    if (event.button !== 0) return;
    if (event.target.closest('button, input, select, textarea, a, form')) return;
    const rect = panel.getBoundingClientRect();
    const drag = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    };
    panel.classList.add('dragging');
    handle.setPointerCapture(event.pointerId);

    const move = moveEvent => {
      const next = boundedDockPosition(
        moveEvent.clientX - drag.dx,
        moveEvent.clientY - drag.dy,
        rect.width,
        rect.height,
      );
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    };

    const up = () => {
      panel.classList.remove('dragging');
      storeDockPosition(panel);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function clearDockPosition(panel) {
  panel.style.left = '';
  panel.style.top = '';
  panel.style.right = '';
  panel.style.bottom = '';
}

function applyDockPosition(panel) {
  const stored = readDockPosition(panel.dataset.dock);
  const fallback = defaultDockPosition(panel);
  const rect = panel.getBoundingClientRect();
  const pos = boundedDockPosition(
    stored?.left ?? fallback.left,
    stored?.top ?? fallback.top,
    rect.width || fallback.width,
    rect.height || fallback.height,
  );
  panel.style.left = `${pos.left}px`;
  panel.style.top = `${pos.top}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

function storeDockPosition(panel) {
  const rect = panel.getBoundingClientRect();
  localStorage.setItem(
    dockPositionKey(panel.dataset.dock),
    JSON.stringify({left: Math.round(rect.left), top: Math.round(rect.top)}),
  );
}

function readDockPosition(dock) {
  try {
    const value = JSON.parse(localStorage.getItem(dockPositionKey(dock)) ?? 'null');
    if (Number.isFinite(value?.left) && Number.isFinite(value?.top)) return value;
  } catch {
    // Ignore corrupt browser state and fall back to the rail position.
  }
  return null;
}

function defaultDockPosition(panel) {
  const dock = panel.dataset.dock;
  const width = dock === 'projects' || dock === 'records' ? 334 : dock === 'log' ? 430 : 390;
  const height =
    dock === 'projects' ? 620 : dock === 'records' ? 380 : dock === 'log' ? 280 : 420;
  const rightRail = window.innerWidth - width - 66;
  const positions = {
    projects: {left: 66, top: 14, width, height},
    records: {left: 66, top: 76, width, height},
    log: {left: 66, top: Math.max(138, window.innerHeight - height - 14), width, height},
    inspector: {left: rightRail, top: 14, width, height},
    visuals: {
      left: rightRail,
      top: Math.max(76, window.innerHeight - 230),
      width,
      height: 210,
    },
  };
  return positions[dock] ?? {left: 66, top: 14, width, height};
}

function boundedDockPosition(left, top, width, height) {
  return {
    left: clampNumber(left, 8, Math.max(8, window.innerWidth - width - 8)),
    top: clampNumber(top, 8, Math.max(8, window.innerHeight - height - 8)),
  };
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}

function ruCount(count, one, few, many) {
  const abs = Math.abs(Number(count));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  const noun = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${count} ${noun}`;
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function previewText(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value ?? '').replace(/["\\]/g, '\\$&');
}
