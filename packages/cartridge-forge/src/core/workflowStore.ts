import path from 'node:path';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {readJsonl, writeJsonl} from './jsonl.js';
import type {
  ForgeExecutionSummary,
  ForgeNodeExecutionLog,
  ForgeWorkflow,
} from './workflowTypes.js';
import {validateForgeWorkflowGraph} from '../n8n-adapted/graph-utils.js';

export const defaultWorkflowSlug = 'default-export';

export function workflowsRoot(projectRoot: string): string {
  return path.join(projectRoot, 'workflows');
}

export function executionsRoot(projectRoot: string): string {
  return path.join(projectRoot, 'executions');
}

export function workflowPath(projectRoot: string, workflowSlug: string): string {
  return path.join(workflowsRoot(projectRoot), `${workflowSlug}.json`);
}

export function executionPath(projectRoot: string, executionId: string): string {
  return path.join(executionsRoot(projectRoot), `${executionId}.jsonl`);
}

export async function ensureDefaultWorkflow(projectRoot: string): Promise<ForgeWorkflow> {
  await mkdir(workflowsRoot(projectRoot), {recursive: true});
  const file = workflowPath(projectRoot, defaultWorkflowSlug);
  const existing = await readFile(file, 'utf8').catch(() => null);
  if (existing) return JSON.parse(existing) as ForgeWorkflow;
  const workflow = defaultWorkflow();
  await saveWorkflow(projectRoot, workflow);
  return workflow;
}

export async function listWorkflows(projectRoot: string): Promise<ForgeWorkflow[]> {
  await ensureDefaultWorkflow(projectRoot);
  const entries = await readdir(workflowsRoot(projectRoot), {withFileTypes: true});
  const workflows: ForgeWorkflow[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const text = await readFile(path.join(workflowsRoot(projectRoot), entry.name), 'utf8');
    workflows.push(JSON.parse(text) as ForgeWorkflow);
  }
  return workflows.sort((a, b) => a.workflow_slug.localeCompare(b.workflow_slug));
}

export async function loadWorkflow(
  projectRoot: string,
  workflowSlug = defaultWorkflowSlug,
): Promise<ForgeWorkflow> {
  if (workflowSlug === defaultWorkflowSlug) await ensureDefaultWorkflow(projectRoot);
  const text = await readFile(workflowPath(projectRoot, workflowSlug), 'utf8');
  return JSON.parse(text) as ForgeWorkflow;
}

export async function saveWorkflow(projectRoot: string, workflow: ForgeWorkflow): Promise<void> {
  validateWorkflowShape(workflow);
  await mkdir(workflowsRoot(projectRoot), {recursive: true});
  await writeFile(
    workflowPath(projectRoot, workflow.workflow_slug),
    JSON.stringify(workflow, null, 2),
    'utf8',
  );
}

export async function saveExecutionLog(
  projectRoot: string,
  executionId: string,
  logs: ForgeNodeExecutionLog[],
): Promise<void> {
  await mkdir(executionsRoot(projectRoot), {recursive: true});
  await writeJsonl(executionPath(projectRoot, executionId), logs);
}

export async function readExecutionLog(
  projectRoot: string,
  executionId: string,
): Promise<ForgeNodeExecutionLog[]> {
  return readJsonl<ForgeNodeExecutionLog>(executionPath(projectRoot, executionId));
}

export async function listExecutions(projectRoot: string): Promise<ForgeExecutionSummary[]> {
  await mkdir(executionsRoot(projectRoot), {recursive: true});
  const entries = await readdir(executionsRoot(projectRoot), {withFileTypes: true});
  const out: ForgeExecutionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const rows = await readJsonl<ForgeNodeExecutionLog>(
      path.join(executionsRoot(projectRoot), entry.name),
    );
    if (rows.length === 0) continue;
    out.push(summarizeExecution(rows));
  }
  return out.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function summarizeExecution(rows: ForgeNodeExecutionLog[]): ForgeExecutionSummary {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const failed = rows.some(row => row.status === 'failed');
  return {
    execution_id: first.execution_id,
    workflow_slug: first.workflow_slug,
    status: failed ? 'failed' : 'success',
    execution_status: failed ? 'error' : 'success',
    started_at: first.started_at,
    ended_at: last.ended_at,
    node_count: rows.length,
    error_count: rows.reduce((sum, row) => sum + row.errors.length, 0),
    warning_count: rows.reduce((sum, row) => sum + row.warnings.length, 0),
    artifact_paths: rows.flatMap(row => row.artifacts),
  };
}

export function defaultWorkflow(): ForgeWorkflow {
  return {
    schema_version: 'greenhaven.forge_workflow.v1',
    workflow_slug: defaultWorkflowSlug,
    title: 'Default Validate, Visualize, Export',
    nodes: [
      {
        id: 'source-audit',
        type: 'source.audit',
        layout: {x: 0, y: 0},
      },
      {
        id: 'validate',
        type: 'validate.project',
        inputs: ['source-audit'],
        layout: {x: 240, y: 0},
      },
      {
        id: 'visual-manifest',
        type: 'visual.manifest',
        inputs: ['validate'],
        layout: {x: 480, y: 0},
      },
      {
        id: 'visual-attach',
        type: 'visual.attach',
        inputs: ['visual-manifest'],
        layout: {x: 720, y: 0},
      },
      {
        id: 'export',
        type: 'export.agent_pack',
        inputs: ['visual-attach'],
        layout: {x: 960, y: 0},
      },
    ],
    edges: [
      {from: 'source-audit', to: 'validate'},
      {from: 'validate', to: 'visual-manifest'},
      {from: 'visual-manifest', to: 'visual-attach'},
      {from: 'visual-attach', to: 'export'},
    ],
  };
}

function validateWorkflowShape(workflow: ForgeWorkflow) {
  if (workflow.schema_version !== 'greenhaven.forge_workflow.v1') {
    throw new Error('workflow schema_version is invalid');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workflow.workflow_slug)) {
    throw new Error('workflow_slug must be kebab-case');
  }
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (!/^[a-zA-Z0-9_-]+$/.test(node.id)) throw new Error(`invalid node id: ${node.id}`);
    if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of workflow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new Error(`workflow edge references missing node: ${edge.from} -> ${edge.to}`);
    }
  }
  const graphErrors = validateForgeWorkflowGraph(workflow);
  if (graphErrors.length > 0) {
    throw new Error(`workflow graph is invalid: ${graphErrors.join('; ')}`);
  }
}
