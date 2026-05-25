export const ExecutionStatusList = [
	'canceled',
	'crashed',
	'error',
	'new',
	'running',
	'success',
	'unknown',
	'waiting',
] as const;

export type ExecutionStatus = (typeof ExecutionStatusList)[number];

export type ForgeNodeStatus = 'success' | 'failed' | 'skipped';

export function forgeNodeStatusToExecutionStatus(status: ForgeNodeStatus): ExecutionStatus {
	if (status === 'success') return 'success';
	if (status === 'skipped') return 'waiting';
	return 'error';
}
