import path from 'node:path';
import {exportPack} from '../exporters/exportPack.js';
import {validateProject} from '../validators/validateProject.js';
import {attachVisualManifest} from '../visual/attach.js';
import {listPacks, loadPack} from '../visual/packStore.js';
import {readManifest, rebuildManifest} from '../visual/manifest.js';
import {loadProject} from './projectStore.js';
import type {LoadedProject} from './types.js';
import type {ForgeNodeExecutionLog, ForgeWorkflow, ForgeWorkflowNode} from './workflowTypes.js';
import {saveExecutionLog, summarizeExecution} from './workflowStore.js';
import {forgeNodeStatusToExecutionStatus} from '../n8n-adapted/execution-status.js';

export async function runWorkflow(
  projectRoot: string,
  workflow: ForgeWorkflow,
): Promise<{
  execution: ReturnType<typeof summarizeExecution>;
  logs: ForgeNodeExecutionLog[];
}> {
  const executionId = `exec-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const ordered = topologicalNodes(workflow);
  const logs: ForgeNodeExecutionLog[] = [];
  let failed = false;

  for (const node of ordered) {
    if (failed) {
      logs.push(makeLog(executionId, workflow.workflow_slug, node, 'skipped', {
        summary: 'Skipped because an upstream node failed.',
      }));
      continue;
    }
    const startedAt = new Date().toISOString();
    try {
      const loaded = await loadProject(projectRoot);
      const result = await runNode(projectRoot, loaded, node);
      logs.push(
        makeLog(executionId, workflow.workflow_slug, node, 'success', {
          startedAt,
          summary: result.summary,
          errors: result.errors,
          warnings: result.warnings,
          artifacts: result.artifacts,
          metrics: result.metrics,
        }),
      );
      if (result.errors.length > 0) failed = true;
    } catch (error) {
      failed = true;
      logs.push(
        makeLog(executionId, workflow.workflow_slug, node, 'failed', {
          startedAt,
          summary: 'Node failed.',
          errors: [error instanceof Error ? error.message : String(error)],
        }),
      );
    }
  }

  await saveExecutionLog(projectRoot, executionId, logs);
  return {execution: summarizeExecution(logs), logs};
}

async function runNode(
  projectRoot: string,
  loaded: LoadedProject,
  node: ForgeWorkflowNode,
): Promise<{
  summary: string;
  errors: string[];
  warnings: string[];
  artifacts: string[];
  metrics?: Record<string, number>;
}> {
  if (node.type === 'source.audit') {
    const warnings =
      loaded.sources.length <= 1
        ? ['Project has only the default internal source; add provenance before serious import.']
        : [];
    return {
      summary: `${loaded.sources.length} source records available.`,
      errors: [],
      warnings,
      artifacts: [],
      metrics: {sources: loaded.sources.length},
    };
  }

  if (node.type === 'validate.project') {
    const issues = await validateProject(loaded);
    const errors = issues.filter(issue => issue.level === 'error');
    const warnings = issues.filter(issue => issue.level === 'warning');
    return {
      summary: errors.length === 0 ? 'Project validation passed.' : 'Project validation failed.',
      errors: errors.map(issue => `${issue.file}: ${issue.message}`),
      warnings: warnings.map(issue => `${issue.file}: ${issue.message}`),
      artifacts: [],
      metrics: {
        records: loaded.records.length,
        errors: errors.length,
        warnings: warnings.length,
      },
    };
  }

  if (node.type === 'visual.manifest') {
    const root = visualRoot(projectRoot);
    const packs = await listPacks(root);
    let manifests = 0;
    let rows = 0;
    for (const packSummary of packs) {
      const pack = await loadPack(root, packSummary.name);
      rows += await rebuildManifest(root, pack);
      manifests += 1;
    }
    return {
      summary: `Rebuilt ${manifests} visual manifests.`,
      errors: [],
      warnings: [],
      artifacts: [],
      metrics: {visual_packs: manifests, manifest_rows: rows},
    };
  }

  if (node.type === 'visual.attach') {
    const root = visualRoot(projectRoot);
    const packs = await listPacks(root);
    let attached = 0;
    for (const pack of packs) {
      attached += await attachVisualManifest(
        projectRoot,
        loaded.records,
        await readManifest(root, pack.name),
      );
    }
    return {
      summary: `Attached ${attached} visual assets to records.`,
      errors: [],
      warnings: [],
      artifacts: [],
      metrics: {attached_visual_assets: attached},
    };
  }

  if (node.type === 'export.agent_pack') {
    const issues = await validateProject(loaded);
    const errors = issues.filter(issue => issue.level === 'error');
    if (errors.length > 0) {
      return {
        summary: 'Export blocked by validation errors.',
        errors: errors.map(issue => `${issue.file}: ${issue.message}`),
        warnings: [],
        artifacts: [],
      };
    }
    const out = await exportPack(loaded);
    return {
      summary: `Exported agent pack to ${out}.`,
      errors: [],
      warnings: [],
      artifacts: [out],
      metrics: {records: loaded.records.length},
    };
  }

  return {
    summary: `Unknown node type ${node.type}.`,
    errors: [`unknown node type: ${node.type}`],
    warnings: [],
    artifacts: [],
  };
}

function topologicalNodes(workflow: ForgeWorkflow): ForgeWorkflowNode[] {
  const byId = new Map(workflow.nodes.map(node => [node.id, node]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: ForgeWorkflowNode[] = [];

  function visit(node: ForgeWorkflowNode) {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) throw new Error(`workflow cycle at node ${node.id}`);
    visiting.add(node.id);
    for (const input of node.inputs ?? []) {
      const dep = byId.get(input);
      if (!dep) throw new Error(`node ${node.id} references missing input ${input}`);
      visit(dep);
    }
    visiting.delete(node.id);
    visited.add(node.id);
    ordered.push(node);
  }

  for (const node of workflow.nodes) visit(node);
  return ordered;
}

function makeLog(
  executionId: string,
  workflowSlug: string,
  node: ForgeWorkflowNode,
  status: ForgeNodeExecutionLog['status'],
  input: {
    startedAt?: string;
    summary: string;
    errors?: string[];
    warnings?: string[];
    artifacts?: string[];
    metrics?: Record<string, number>;
  },
): ForgeNodeExecutionLog {
  const now = new Date().toISOString();
  return {
    execution_id: executionId,
    workflow_slug: workflowSlug,
    node_id: node.id,
    node_type: node.type,
    status,
    execution_status: forgeNodeStatusToExecutionStatus(status),
    started_at: input.startedAt ?? now,
    ended_at: now,
    summary: input.summary,
    errors: input.errors ?? [],
    warnings: input.warnings ?? [],
    artifacts: input.artifacts ?? [],
    metrics: input.metrics,
  };
}

function visualRoot(projectRoot: string): string {
  return path.join(projectRoot, 'visual-packs');
}
