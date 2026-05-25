import type {IngestRecord, ValidationIssue} from './types.js';
import {
  buildAdjacencyList,
  getLeafNodes,
  getRootNodes,
  type IConnections,
} from '../n8n-adapted/graph-utils.js';
import type {VisualPackSummary} from '../visual/packStore.js';

export interface EntityGraphNode {
  id: string;
  slug: string;
  kind: IngestRecord['kind'] | 'visual_pack';
  label: string;
  summary: string;
}

export interface EntityGraphEdge {
  from: string;
  to: string;
  rel: string;
  note?: string;
}

export interface EntityGraph {
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
  roots: string[];
  leaves: string[];
  issues: ValidationIssue[];
}

export function buildEntityGraph(
  records: IngestRecord[],
  visuals: VisualPackSummary[] = [],
): EntityGraph {
  const nodes = new Map<string, EntityGraphNode>();
  const edges: EntityGraphEdge[] = [];
  const issues: ValidationIssue[] = [];

  for (const record of records) {
    nodes.set(record.slug, {
      id: record.slug,
      slug: record.slug,
      kind: record.kind,
      label: record.canonical_name,
      summary: record.summary,
    });
  }

  for (const record of records) {
    for (const link of record.links ?? []) {
      pushEdge(edges, record.slug, link.target, link.rel, link.note);
    }
    collectPayloadEdges(record, edges);
  }

  for (const visual of visuals) {
    const visualId = `visual:${visual.name}`;
    nodes.set(visualId, {
      id: visualId,
      slug: visual.name,
      kind: 'visual_pack',
      label: visual.name,
      summary: `${visual.subject_kind} / ${visual.asset_role}`,
    });
    if (visual.entity_slug) {
      pushEdge(edges, visual.entity_slug, visualId, 'visual_pack');
    } else {
      issues.push({
        level: 'warning',
        file: `visual-packs/${visual.name}`,
        field: 'entity_slug',
        message: 'visual pack is not linked to an entity',
      });
    }
  }

  const knownIds = new Set(nodes.keys());
  for (const edge of edges) {
    if (!knownIds.has(edge.from)) {
      issues.push({
        level: 'warning',
        file: 'entity-graph',
        field: edge.rel,
        message: `edge source is outside this pack: ${edge.from}`,
      });
    }
    if (!knownIds.has(edge.to) && !edge.to.startsWith('external:')) {
      issues.push({
        level: 'warning',
        file: 'entity-graph',
        field: edge.rel,
        message: `edge target is outside this pack: ${edge.to}`,
      });
    }
  }

  for (const record of records) {
    graphGameplayIssues(record, edges, visuals, issues);
  }

  const adjacency = buildAdjacencyList(toConnections([...knownIds], edges));
  return {
    nodes: [...nodes.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.slug.localeCompare(b.slug)),
    edges: uniqueEdges(edges),
    roots: [...getRootNodes(knownIds, adjacency)].sort(),
    leaves: [...getLeafNodes(knownIds, adjacency)].sort(),
    issues,
  };
}

export function locationTree(graph: EntityGraph, locationSlug: string): EntityGraph {
  const seen = new Set<string>([locationSlug]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (seen.has(edge.from) && !seen.has(edge.to)) {
        seen.add(edge.to);
        changed = true;
      }
    }
  }
  return {
    nodes: graph.nodes.filter(node => seen.has(node.id)),
    edges: graph.edges.filter(edge => seen.has(edge.from) && seen.has(edge.to)),
    roots: graph.roots.filter(root => seen.has(root)),
    leaves: graph.leaves.filter(leaf => seen.has(leaf)),
    issues: graph.issues.filter(issue => !issue.message.includes(locationSlug) || seen.has(locationSlug)),
  };
}

function collectPayloadEdges(record: IngestRecord, edges: EntityGraphEdge[]) {
  const payload = record.payload;
  const slug = record.slug;

  addStringEdge(edges, payload.parent_slug, slug, 'contains');
  addArrayEdges(edges, slug, payload.exits, 'exit');
  addArrayEdges(edges, slug, payload.scene_slugs, 'scene');
  addArrayEdges(edges, slug, payload.resident_npc_slugs, 'resident');
  addArrayEdges(edges, slug, payload.placed_item_slugs, 'placed_item');
  addArrayEdges(edges, slug, payload.event_slugs, 'event');
  addArrayEdges(edges, slug, payload.activity_slugs, 'activity');
  addArrayEdges(edges, slug, payload.quest_slugs, 'quest_hook');

  addStringEdge(edges, payload.location_slug, slug, 'location');
  addStringEdge(edges, payload.home_slug, slug, 'home');
  addStringEdge(edges, payload.scene_slug, slug, 'scene_anchor');
  addStringEdge(edges, payload.holder_slug, slug, 'holder');
  addStringEdge(edges, payload.faction_slug, slug, 'faction');

  addArrayEdges(edges, slug, payload.participant_slugs, 'participant');
  addArrayEdges(edges, slug, payload.item_slugs, 'scene_item');
  addArrayEdges(edges, slug, payload.participants, 'participant');

  addStringEdge(edges, payload.giver_slug, slug, 'quest_giver');
  addStringEdge(edges, payload.source_item_slug, slug, 'quest_source_item');
  addStringEdge(edges, payload.source_scene_slug, slug, 'quest_source_scene');
  addStringEdge(edges, payload.source_event_slug, slug, 'quest_source_event');
  addStringEdge(edges, payload.start_location_slug, slug, 'quest_start');
  addArrayEdges(edges, slug, payload.prepared_entity_slugs, 'prepared_entity');
  addArrayEdges(edges, slug, payload.stage_location_slugs, 'stage_location');
  addNestedStageEdges(edges, slug, payload.stages);
  addVisualAssetEdges(edges, slug, payload.visual_assets);
}

function graphGameplayIssues(
  record: IngestRecord,
  edges: EntityGraphEdge[],
  visuals: VisualPackSummary[],
  issues: ValidationIssue[],
) {
  if (record.kind === 'location') {
    const hasScene = edges.some(edge => edge.from === record.slug && edge.rel === 'scene');
    if (!hasScene) {
      issues.push({
        level: 'warning',
        file: `records/${record.kind}s.jsonl`,
        field: 'payload.scene_slugs',
        message: `location ${record.slug} has no scene children`,
      });
    }
  }
  if (record.kind === 'person') {
    const anchored = Boolean(
      record.payload.home_slug ||
        record.payload.faction_slug ||
        record.payload.scene_slug ||
        edges.some(edge => edge.to === record.slug && ['resident', 'participant'].includes(edge.rel)),
    );
    if (!anchored) {
      issues.push({
        level: 'warning',
        file: 'records/persons.jsonl',
        field: 'payload.home_slug',
        message: `NPC ${record.slug} is not anchored to a location, scene, or faction`,
      });
    }
  }
  if (record.kind === 'item') {
    const anchored = Boolean(record.payload.location_slug || record.payload.holder_slug || record.payload.scene_slug);
    if (!anchored) {
      issues.push({
        level: 'warning',
        file: 'records/items.jsonl',
        field: 'payload.location_slug',
        message: `item ${record.slug} is not anchored to a holder, scene, or location`,
      });
    }
  }
  if (record.kind === 'quest') {
    const prepared = record.payload.prepared_entity_slugs;
    if (!Array.isArray(prepared) || prepared.length === 0) {
      issues.push({
        level: 'warning',
        file: 'records/quests.jsonl',
        field: 'payload.prepared_entity_slugs',
        message: `quest ${record.slug} has no prepared entity links`,
      });
    }
  }
  for (const visual of visuals.filter(visual => visual.entity_slug === record.slug)) {
    if (!visual.has_reference && visual.sticker_count === 0) {
      issues.push({
        level: 'warning',
        file: `visual-packs/${visual.name}`,
        field: 'assets',
        message: `visual pack ${visual.name} is linked to ${record.slug} but has no generated assets`,
      });
    }
  }
}

function addStringEdge(
  edges: EntityGraphEdge[],
  from: unknown,
  to: unknown,
  rel: string,
) {
  if (typeof from === 'string' && from.trim() && typeof to === 'string' && to.trim()) {
    pushEdge(edges, from, to, rel);
  }
}

function addArrayEdges(
  edges: EntityGraphEdge[],
  from: string,
  targets: unknown,
  rel: string,
) {
  if (!Array.isArray(targets)) return;
  for (const target of targets) {
    if (typeof target === 'string' && target.trim()) pushEdge(edges, from, target, rel);
  }
}

function addNestedStageEdges(edges: EntityGraphEdge[], from: string, stages: unknown) {
  if (!Array.isArray(stages)) return;
  for (const stage of stages) {
    if (stage && typeof stage === 'object' && !Array.isArray(stage)) {
      addStringEdge(edges, from, (stage as Record<string, unknown>).location_slug, 'stage_location');
    }
  }
}

function addVisualAssetEdges(edges: EntityGraphEdge[], from: string, assets: unknown) {
  if (!Array.isArray(assets)) return;
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) continue;
    const name = (asset as Record<string, unknown>).pack_name;
    if (typeof name === 'string' && name.trim()) pushEdge(edges, from, `visual:${name}`, 'visual_pack');
  }
}

function pushEdge(edges: EntityGraphEdge[], from: string, to: string, rel: string, note?: string) {
  if (!from || !to || from === to) return;
  edges.push({from, to, rel, note});
}

function uniqueEdges(edges: EntityGraphEdge[]): EntityGraphEdge[] {
  const seen = new Set<string>();
  const out: EntityGraphEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}\0${edge.rel}\0${edge.note ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function toConnections(nodeIds: string[], edges: EntityGraphEdge[]): IConnections {
  const connections: IConnections = {};
  for (const nodeId of nodeIds) connections[nodeId] = {main: [[]]};
  for (const edge of edges) {
    connections[edge.from] ??= {main: [[]]};
    connections[edge.from].main[0] ??= [];
    connections[edge.from].main[0].push({node: edge.to, type: 'main', index: 0});
  }
  return connections;
}
