import type {ExecutionStatus} from '../n8n-adapted/execution-status.js';

export interface ForgeWorkflow {
  schema_version: 'greenhaven.forge_workflow.v1';
  workflow_slug: string;
  title?: string;
  nodes: ForgeWorkflowNode[];
  edges: ForgeWorkflowEdge[];
}

export interface ForgeWorkflowNode {
  id: string;
  type: string;
  version?: string;
  inputs?: string[];
  config?: Record<string, unknown>;
  layout?: {x?: number; y?: number};
}

export interface ForgeWorkflowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface ForgeExecutionSummary {
  execution_id: string;
  workflow_slug: string;
  status: 'success' | 'failed';
  execution_status: ExecutionStatus;
  started_at: string;
  ended_at: string;
  node_count: number;
  error_count: number;
  warning_count: number;
  artifact_paths: string[];
}

export interface ForgeNodeExecutionLog {
  execution_id: string;
  workflow_slug: string;
  node_id: string;
  node_type: string;
  status: 'success' | 'failed' | 'skipped';
  execution_status: ExecutionStatus;
  started_at: string;
  ended_at: string;
  summary: string;
  errors: string[];
  warnings: string[];
  artifacts: string[];
  metrics?: Record<string, number>;
}
