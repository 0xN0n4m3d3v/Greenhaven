import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createApp} from '../src/server/app.js';

describe('Cartridge Forge server', () => {
  it('runs the project to export API loop', async () => {
    process.env.CARTRIDGE_FORGE_PROJECTS = await mkdtemp(
      path.join(os.tmpdir(), 'forge-api-projects-'),
    );
    process.env.CARTRIDGE_AGENT_PACKS = await mkdtemp(path.join(os.tmpdir(), 'forge-api-packs-'));
    const app = createApp();

    const project = await json(
      await app.request('/api/projects', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({slug: 'api-loop'}),
      }),
    );
    expect(project.ok).toBe(true);

    const record = await json(
      await app.request('/api/projects/api-loop/records', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          kind: 'location',
          slug: 'api-loop-corner',
          name: 'API Loop Corner',
          summary: 'A playable test location with enough hooks.',
          tags: ['location', 'forge'],
        }),
      }),
    );
    expect(record.record.slug).toBe('api-loop-corner');

    await app.request('/api/projects/api-loop/visuals', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        name: 'api-loop-corner-visual',
        subjectKind: 'location',
        entitySlug: 'api-loop-corner',
      }),
    });
    await app.request('/api/projects/api-loop/visuals/api-loop-corner-visual/manifest', {
      method: 'POST',
    });
    const attach = await json(
      await app.request('/api/projects/api-loop/visuals/api-loop-corner-visual/attach', {
        method: 'POST',
      }),
    );
    expect(attach.attached).toBeGreaterThan(0);

    const validate = await json(
      await app.request('/api/projects/api-loop/validate', {method: 'POST'}),
    );
    expect(validate.ok).toBe(true);

    const exported = await json(
      await app.request('/api/projects/api-loop/export', {method: 'POST'}),
    );
    expect(exported.ok).toBe(true);
    expect(exported.path).toContain('api-loop');

    const source = await json(
      await app.request('/api/projects/api-loop/sources', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          source_id: 'src:forge:test',
          title: 'Forge Test Source',
          license: 'internal',
          robots_status: 'internal',
          notes: 'Regression source.',
        }),
      }),
    );
    expect(source.source.source_id).toBe('src:forge:test');

    const workflows = await json(await app.request('/api/projects/api-loop/workflows'));
    expect(workflows.workflows[0].workflow_slug).toBe('default-export');

    const run = await json(
      await app.request('/api/projects/api-loop/workflows/default-export/run', {
        method: 'POST',
      }),
    );
    expect(run.succeeded).toBe(true);
    expect(run.logs).toHaveLength(5);
    expect(run.execution.execution_status).toBe('success');
    expect(run.logs.every((row: Record<string, any>) => row.execution_status)).toBe(true);

    const executions = await json(await app.request('/api/projects/api-loop/executions'));
    expect(executions.executions[0].execution_id).toBe(run.execution.execution_id);

    const executionLog = await json(
      await app.request(`/api/projects/api-loop/executions/${run.execution.execution_id}`),
    );
    expect(executionLog.logs.map((row: Record<string, any>) => row.node_type)).toEqual([
      'source.audit',
      'validate.project',
      'visual.manifest',
      'visual.attach',
      'export.agent_pack',
    ]);
  });

  it('supports canvas graph links and quest generation from an NPC', async () => {
    process.env.CARTRIDGE_FORGE_PROJECTS = await mkdtemp(
      path.join(os.tmpdir(), 'forge-canvas-projects-'),
    );
    process.env.CARTRIDGE_AGENT_PACKS = await mkdtemp(path.join(os.tmpdir(), 'forge-canvas-packs-'));
    const app = createApp();

    await json(
      await app.request('/api/projects', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({slug: 'canvas-loop'}),
      }),
    );

    await json(
      await app.request('/api/projects/canvas-loop/records', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          kind: 'location',
          slug: 'forge-tavern',
          name: 'Forge Tavern',
          summary: 'A test power center.',
          tags: ['location'],
        }),
      }),
    );
    const npc = await json(
      await app.request('/api/projects/canvas-loop/records', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          kind: 'person',
          slug: 'klapaucius',
          name: 'Klapaucius',
          summary: 'A quest giver robot.',
          tags: ['person'],
          payload: {
            species: 'robot',
            home_slug: 'forge-tavern',
            speech_style: 'precise mechanical bargaining',
          },
        }),
      }),
    );
    expect(npc.record.slug).toBe('klapaucius');

    const quest = await json(
      await app.request('/api/projects/canvas-loop/records/klapaucius/create-quest', {
        method: 'POST',
      }),
    );
    expect(quest.quest.slug).toBe('klapaucius-quest');
    expect(quest.quest.payload.giver_slug).toBe('klapaucius');
    expect(quest.quest.payload.prepared_entity_slugs).toContain('klapaucius');
    expect(quest.anchor.links).toContainEqual({rel: 'generated_quest', target: 'klapaucius-quest'});

    await json(
      await app.request('/api/projects/canvas-loop/records/forge-tavern/link', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({rel: 'resident', target: 'klapaucius'}),
      }),
    );

    const graph = await json(await app.request('/api/projects/canvas-loop/graph'));
    expect(graph.graph.nodes.map((node: Record<string, any>) => node.id)).toContain('klapaucius-quest');
    expect(graph.graph.edges).toContainEqual(
      expect.objectContaining({from: 'klapaucius', to: 'klapaucius-quest'}),
    );
    expect(graph.graph.edges).toContainEqual(
      expect.objectContaining({
        from: 'klapaucius-quest',
        to: 'klapaucius',
        rel: 'prepared_entity',
      }),
    );

    const graphValidation = await json(
      await app.request('/api/projects/canvas-loop/graph/validate', {method: 'POST'}),
    );
    expect(graphValidation.ok).toBe(true);

    const removed = await json(
      await app.request('/api/projects/canvas-loop/records/forge-tavern/link', {
        method: 'DELETE',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({rel: 'resident', target: 'klapaucius'}),
      }),
    );
    expect(removed.removed).toBe(1);
    expect(removed.record.links ?? []).not.toContainEqual({
      rel: 'resident',
      target: 'klapaucius',
    });
  });

  it('validation-gates Grinhaven SQL export API', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'forge-sql-api-projects-'),
    );
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const app = createApp();

    await json(
      await app.request('/api/projects', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({slug: 'sql-api-gate'}),
      }),
    );

    await json(
      await app.request('/api/projects/sql-api-gate/records', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          kind: 'location',
          slug: 'broken-api-location',
          name: 'Broken API Location',
          summary: 'A deliberately invalid location for API SQL gate coverage.',
          tags: ['location'],
          payload: {},
        }),
      }),
    );

    const blocked = await app.request('/api/projects/sql-api-gate/export-grinhaven-sql', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(400);
    const blockedBody = (await blocked.json()) as Record<string, any>;
    expect(blockedBody.ok).toBe(false);
    expect(blockedBody.errors.map((issue: Record<string, any>) => issue.field)).toContain(
      'payload.exits',
    );

    const forced = await json(
      await app.request('/api/projects/sql-api-gate/export-grinhaven-sql', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({force: true, outFile: path.join(root, 'forced.sql')}),
      }),
    );
    expect(forced.ok).toBe(true);
    expect(forced.forced).toBe(true);
    expect(forced.validationErrors.map((issue: Record<string, any>) => issue.field)).toContain(
      'payload.exits',
    );
    expect(forced.records).toBe(1);
  });
});

async function json(response: Response): Promise<Record<string, any>> {
  expect(response.ok).toBe(true);
  return (await response.json()) as Record<string, any>;
}
