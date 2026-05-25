import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, '..', '..');
export const repoRoot = path.resolve(packageRoot, '..', '..');
export const docsSchemaPath = path.join(
  repoRoot,
  'docs',
  'cartridge',
  'schemas',
  'greenhaven-cartridge-ingest-record.v1.schema.json',
);

export function projectsRoot(): string {
  return process.env.CARTRIDGE_FORGE_PROJECTS
    ? path.resolve(process.env.CARTRIDGE_FORGE_PROJECTS)
    : path.join(packageRoot, 'forge-projects');
}

export function projectRoot(slug: string): string {
  return path.join(projectsRoot(), slug);
}

export function agentPacksRoot(): string {
  return process.env.CARTRIDGE_AGENT_PACKS
    ? path.resolve(process.env.CARTRIDGE_AGENT_PACKS)
    : path.join(repoRoot, 'agent-packs');
}

