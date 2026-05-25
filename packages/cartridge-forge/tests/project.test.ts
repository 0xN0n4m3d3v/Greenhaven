import {access, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {exportPack} from '../src/exporters/exportPack.js';
import {exportGrinhavenSql} from '../src/exporters/exportGrinhavenSql.js';
import {exportValidatedGrinhavenSql} from '../src/exporters/exportGrinhavenSqlValidated.js';
import {importGrinhavenMigration, parseEntities} from '../src/importers/grinhavenMigration.js';
import {addRecord, initProject, loadProject, makeRecord, replaceRecord} from '../src/core/projectStore.js';
import {repairReadableSummaries} from '../src/core/recordRepair.js';
import {validateProject} from '../src/validators/validateProject.js';

describe('Cartridge Forge MVP', () => {
  it('validates and exports a minimal location pack', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-projects-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('test-pack');
    const loaded = await loadProject(project.project_slug);
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'location',
        slug: 'ale-eats-test-corner',
        name: 'Ale & Eats Test Corner',
        summary: 'A small playable tavern corner for tests.',
        tags: ['location', 'tavern'],
        payload: {
          location_kind: 'room',
          parent_slug: 'ale-eats',
          power_center_role: 'tavern',
          exits: ['ale-eats'],
          narrator_brief: 'A compact corner with clear hooks.',
          mood_axes: {warmth: 1, danger: 0, intimacy: 0, pressure: 1},
          default_hooks: ['notice', 'mug', 'visitor'],
        },
      }),
    );

    const reloaded = await loadProject(project.project_slug);
    const issues = await validateProject(reloaded);
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);

    const outRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-packs-'));
    const out = await exportPack(reloaded, outRoot);
    expect(out).toContain('test-pack');
  });

  it('round-trips duplicate source slugs by entity type', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-roundtrip-projects-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const fixture = path.join(root, 'duplicate-source-slugs.sql');
    await writeFile(
      fixture,
      [
        'INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES',
        "(1, 'faction', 'Copper Court', NULL, '{\"cartridge_id\":\"grinhaven-full\",\"source_slug\":\"copper-court\"}'::jsonb, ARRAY['faction']),",
        "(2, 'location', 'Copper Court', NULL, '{\"cartridge_id\":\"grinhaven-full\",\"source_slug\":\"copper-court\"}'::jsonb, ARRAY['location']),",
        "(3, 'person', 'Court Clerk', NULL, '{\"cartridge_id\":\"grinhaven-full\",\"source_slug\":\"court-clerk\",\"source\":{\"faction\":\"copper-court\"},\"home_id\":2}'::jsonb, ARRAY['person'])",
        'ON CONFLICT (id) DO UPDATE SET updated_at = now();',
        '',
      ].join('\n'),
      'utf8',
    );

    await importGrinhavenMigration({
      projectSlug: 'duplicate-source-slugs',
      migrationPath: fixture,
    });
    const loaded = await loadProject('duplicate-source-slugs');
    expect(new Set(loaded.records.map(record => record.slug)).size).toBe(3);
    expect(loaded.records.map(record => record.slug).sort()).toEqual([
      'court-clerk',
      'faction-copper-court',
      'location-copper-court',
    ]);
    const clerk = loaded.records.find(record => record.slug === 'court-clerk');
    expect(clerk?.payload.faction_slug).toBe('faction-copper-court');
    expect(clerk?.payload.home_slug).toBe('location-copper-court');

    const outSql = path.join(root, 'roundtrip.sql');
    await exportGrinhavenSql(loaded, outSql);
    const exportedEntities = parseEntities(await readFile(outSql, 'utf8'));
    expect(exportedEntities.map(entity => entity.id).sort()).toEqual([1, 2, 3]);
    expect(new Set(exportedEntities.map(entity => entity.id)).size).toBe(3);
  });

  it('imports role-object summaries as readable text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-readable-summary-projects-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const fixture = path.join(root, 'role-summary.sql');
    await writeFile(
      fixture,
      [
        'INSERT INTO entities (id, kind, display_name, summary, profile, tags) VALUES',
        "(" +
          [
            '1',
            "'person'",
            "'Acolyte Hennen'",
            "'{\"primary\":\"Kitchen anchor\",\"pending_reverse\":\"service note\"}'",
            "'{\"cartridge_id\":\"grinhaven-full\",\"source_slug\":\"acolyte-hennen\",\"source\":{\"personality_seed\":\"Quiet kitchen acolyte with twenty-two years of local memory.\",\"npc_role_in_cartridge\":{\"primary\":\"Kitchen anchor\"}},\"home_id\":2}'::jsonb",
            "ARRAY['person']",
          ].join(', ') +
          ')',
        'ON CONFLICT (id) DO UPDATE SET updated_at = now();',
        '',
      ].join('\n'),
      'utf8',
    );

    await importGrinhavenMigration({
      projectSlug: 'role-summary',
      migrationPath: fixture,
    });
    const loaded = await loadProject('role-summary');
    const hennen = loaded.records.find(record => record.slug === 'acolyte-hennen');
    expect(hennen?.summary).toContain('Quiet kitchen acolyte');
    expect(hennen?.summary.startsWith('{')).toBe(false);
    expect(hennen?.payload.imported_summary_object).toEqual({
      primary: 'Kitchen anchor',
      pending_reverse: 'service note',
    });
    expect(hennen?.payload.npc_role_in_cartridge).toEqual({primary: 'Kitchen anchor'});
  });

  it('replaces imported NPC records in their original JSONL file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-replace-record-projects-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('replace-record');
    const loaded = await loadProject(project.project_slug);
    const original = makeRecord({
      kind: 'person',
      slug: 'acolyte-hennen',
      name: 'Acolyte Hennen',
      summary: 'Old summary.',
    });
    await addRecord(loaded.root, original);

    await replaceRecord(loaded.root, original, {
      ...original,
      canonical_name: 'Hennen',
      summary: 'Edited summary.',
    });

    const files = await readdir(path.join(loaded.root, 'records'));
    expect(files).toContain('npcs.jsonl');
    expect(files).not.toContain('persons.jsonl');
    const reloaded = await loadProject(project.project_slug);
    expect(reloaded.records.filter(record => record.slug === 'acolyte-hennen')).toHaveLength(1);
    expect(reloaded.records.find(record => record.slug === 'acolyte-hennen')?.summary).toBe(
      'Edited summary.',
    );
  });

  it('repairs service summaries for any record kind', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-repair-summary-projects-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('repair-summary');
    const loaded = await loadProject(project.project_slug);
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'item',
        slug: 'sealed-ledger',
        name: 'Sealed Ledger',
        summary: '{"primary":"Service role object that should not be shown raw","pending_reverse":"debug note"...',
        payload: {
          use_contract: 'A sealed ledger that can be inspected, traded, or handed to a quest giver.',
        },
      }),
    );
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'location',
        slug: 'quiet-room',
        name: 'Quiet Room',
        summary: '{"primary":"Location service role","secondary":"secondary service role"}',
        payload: {
          db_profile_json: JSON.stringify({narrator_brief: 'A quiet room with clear exits and one playable hook.'}),
        },
      }),
    );

    const report = await repairReadableSummaries('repair-summary');
    expect(report.repaired).toBe(2);
    expect(report.storage.removedDuplicates).toBe(0);
    const reloaded = await loadProject(project.project_slug);
    expect(reloaded.records.find(record => record.slug === 'sealed-ledger')?.summary).toBe(
      'A sealed ledger that can be inspected, traded, or handed to a quest giver.',
    );
    expect(reloaded.records.find(record => record.slug === 'quiet-room')?.summary).toBe(
      'A quiet room with clear exits and one playable hook.',
    );
    expect(
      reloaded.records.find(record => record.slug === 'quiet-room')?.payload.imported_summary_object,
    ).toEqual({primary: 'Location service role', secondary: 'secondary service role'});
  });

  it('repairs generic JSON summaries into readable record text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-generic-summary-projects-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('generic-summary');
    const loaded = await loadProject(project.project_slug);
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'person',
        slug: 'first-witch',
        name: 'The First Witch',
        summary: '{"build":"slight movement","hands":"weathered and precise"}',
        payload: {
          db_profile_json: JSON.stringify({
            source: {
              npc_concept: 'The First Witch is the Coven institutional anchor.',
              appearance: {build: 'slight movement'},
            },
          }),
        },
      }),
    );
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'relationship',
        slug: 'nyx-ardwen',
        name: 'Nyx / Ardwen',
        summary: '{"summary":"Nyx and Ardwen maintain a formal institutional relationship."}',
      }),
    );

    const report = await repairReadableSummaries('generic-summary');
    expect(report.repaired).toBe(2);
    const reloaded = await loadProject(project.project_slug);
    expect(reloaded.records.find(record => record.slug === 'first-witch')?.summary).toBe(
      'The First Witch is the Coven institutional anchor.',
    );
    expect(reloaded.records.find(record => record.slug === 'nyx-ardwen')?.summary).toBe(
      'Nyx and Ardwen maintain a formal institutional relationship.',
    );
  });

  it('stores activity records in activities.jsonl', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-activity-file-projects-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('activity-file');
    const loaded = await loadProject(project.project_slug);
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'activity',
        slug: 'market-bargain',
        name: 'Market Bargain',
        summary: 'A bargaining activity.',
      }),
    );

    const files = await readdir(path.join(loaded.root, 'records'));
    expect(files).toContain('activities.jsonl');
    expect(files).not.toContain('activitys.jsonl');
  });

  it('deduplicates records left in non-canonical files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-dedupe-projects-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('dedupe-records');
    const loaded = await loadProject(project.project_slug);
    const good = makeRecord({
      kind: 'person',
      slug: 'acolyte-hennen',
      name: 'Acolyte Hennen',
      summary: 'Readable Hennen summary.',
      payload: {imported_summary_object: {primary: 'Kitchen anchor'}},
    });
    const stale = {
      ...good,
      summary: '{"primary":"Raw service summary","pending_reverse":"debug"}',
      payload: {},
    };
    await writeFile(path.join(loaded.root, 'records', 'npcs.jsonl'), `${JSON.stringify(good)}\n`, 'utf8');
    await writeFile(path.join(loaded.root, 'records', 'persons.jsonl'), `${JSON.stringify(stale)}\n`, 'utf8');

    const report = await repairReadableSummaries('dedupe-records');
    expect(report.storage.removedDuplicates).toBe(1);
    const reloaded = await loadProject(project.project_slug);
    expect(reloaded.records.filter(record => record.slug === 'acolyte-hennen')).toHaveLength(1);
    expect(reloaded.records[0]?.summary).toBe('Readable Hennen summary.');
    expect((await readFile(path.join(loaded.root, 'records', 'persons.jsonl'), 'utf8'))).toBe('');
  });

  it('emits forge SQL that protects runtime profile fields via gh_forge_merge_entity_profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-m2-protected-fields-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('m2-protected-fields');
    const loaded = await loadProject(project.project_slug);
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'location',
        slug: 'm2-protected-corner',
        name: 'M-2 Protected Corner',
        summary: 'A small spot used to lock the M-2 merge helper into forge output.',
        tags: ['location'],
        payload: {
          location_kind: 'room',
          parent_slug: 'ale-eats',
          power_center_role: 'tavern',
          exits: ['ale-eats'],
          narrator_brief: 'Compact corner used by the M-2 regression test.',
          mood_axes: {warmth: 1, danger: 0, intimacy: 0, pressure: 0},
          default_hooks: ['notice'],
        },
      }),
    );
    const reloaded = await loadProject(project.project_slug);
    const outSql = path.join(root, 'm2.sql');
    await exportGrinhavenSql(reloaded, outSql);
    const text = await readFile(outSql, 'utf8');
    expect(text).toContain(
      'profile = gh_forge_merge_entity_profile(entities.profile, EXCLUDED.profile)',
    );
    expect(text).not.toContain('profile = EXCLUDED.profile,');
  });

  it('forge SQL writes ARCH-19 normalized columns alongside profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-arch19-phase2a-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('arch19-phase2a');
    const loaded = await loadProject(project.project_slug);
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'location',
        slug: 'arch19-phase2a-corner',
        name: 'ARCH-19 Phase 2A Corner',
        summary: 'Used to lock the dual-write into forge output.',
        tags: ['location'],
        payload: {
          location_kind: 'room',
          parent_slug: 'ale-eats',
          power_center_role: 'tavern',
          exits: ['ale-eats'],
          narrator_brief: 'Compact corner used by the ARCH-19 dual-write test.',
          mood_axes: {warmth: 1, danger: 0, intimacy: 0, pressure: 0},
          default_hooks: ['notice'],
        },
      }),
    );
    const reloaded = await loadProject(project.project_slug);
    reloaded.project.starting_location_slug = 'arch19-phase2a-corner';
    const outSql = path.join(root, 'arch19-phase2a.sql');
    await exportGrinhavenSql(reloaded, outSql);
    const text = await readFile(outSql, 'utf8');
    expect(text).toContain(
      'INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id, dynamic_origin) VALUES',
    );
    // ARCH-19 Phase 4 prereq: the post-INSERT UPDATE no longer reads
    // the retired `child.profile->>'topology_parent_id'` JSONB key.
    // This fixture only has one location with an unresolved
    // `parent_slug`, so the generated child→parent map is empty and
    // the exporter falls back to the explanatory comment. Both shapes
    // are valid; what matters is the absence of the legacy probe.
    expect(text).not.toContain(
      "safe_to_bigint(child.profile->>'topology_parent_id')",
    );
    expect(text).toMatch(
      /(UPDATE entities child[\s\S]+?FROM \(VALUES.+\) AS edge\(child_id, parent_id\)|-- No topology edges to project\.)/,
    );
    // ON CONFLICT must not touch the normalized columns; M-2/ARCH-19
    // rule says conflict updates preserve existing values.
    expect(text).not.toContain('cartridge_id = EXCLUDED.cartridge_id');
    expect(text).not.toContain('topology_parent_id = EXCLUDED.topology_parent_id');
    expect(text).not.toContain('dynamic_origin = EXCLUDED.dynamic_origin');
    expect(text).toContain("('starting_location_id',");
    expect(text).toContain('Start location exported by Cartridge Forge.');
    expect(text).toContain('"local_density_summary"');
    expect(text).toContain('"transitive_density_summary"');
    expect(text).not.toContain("SELECT rebuild_local_density('grinhaven-full');");
  });

  it('forge SQL omits retired ARCH-19 JSONB keys from emitted profiles', async () => {
    // ARCH-19 Phase 4 prereq: `cartridge_id`, `topology_parent_id`, and
    // `origin` are gone from the emitted `profile` JSONB. They still
    // ride the entity INSERT through the dedicated `cartridge_id` and
    // `dynamic_origin` columns + the post-INSERT topology map. The
    // retired keys MUST NOT appear inside any per-entity JSON payload
    // emitted by the exporter, otherwise the soak-gated Phase 4 drop
    // migration would have nothing to retire.
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-arch19-phase4-prereq-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('arch19-phase4-prereq');
    const loaded = await loadProject(project.project_slug);
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'location',
        slug: 'arch19-prereq-parent',
        name: 'ARCH-19 Phase 4 Prereq Parent',
        summary: 'Parent district used as topology root.',
        tags: ['location', 'district'],
        payload: {
          location_kind: 'district',
          narrator_brief: 'Parent district for the prereq topology test.',
          mood_axes: {warmth: 0, danger: 0, intimacy: 0, pressure: 0},
          default_hooks: ['watch'],
        },
      }),
    );
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'location',
        slug: 'arch19-prereq-child',
        name: 'ARCH-19 Phase 4 Prereq Child',
        summary: 'Child room linked to the prereq parent district.',
        tags: ['location'],
        payload: {
          location_kind: 'room',
          parent_slug: 'arch19-prereq-parent',
          narrator_brief: 'Child room linked to the prereq parent.',
          mood_axes: {warmth: 1, danger: 0, intimacy: 0, pressure: 0},
          default_hooks: ['notice'],
        },
      }),
    );
    const reloaded = await loadProject(project.project_slug);
    const outSql = path.join(root, 'arch19-phase4-prereq.sql');
    await exportGrinhavenSql(reloaded, outSql);
    const text = await readFile(outSql, 'utf8');

    // Each entity INSERT row encodes its profile as a single
    // single-quoted JSON literal followed by `::jsonb`. Pull every
    // such literal out of the entity VALUES block and assert the
    // retired keys never appear inside any of them. We slice from the
    // first INSERT row to the next blank-line / next-statement break.
    const insertIdx = text.indexOf(
      'INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id, dynamic_origin) VALUES',
    );
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    const onConflictIdx = text.indexOf('ON CONFLICT (id) DO UPDATE SET', insertIdx);
    const entityBlock = text.slice(insertIdx, onConflictIdx);
    const jsonLiterals = [...entityBlock.matchAll(/'(\{[^']*(?:''[^']*)*\})'::jsonb/g)].map(m => m[1]);
    expect(jsonLiterals.length).toBeGreaterThan(0);
    for (const literal of jsonLiterals) {
      const unescaped = literal.replace(/''/g, "'");
      const parsed = JSON.parse(unescaped);
      expect(parsed).not.toHaveProperty('cartridge_id');
      expect(parsed).not.toHaveProperty('topology_parent_id');
      expect(parsed).not.toHaveProperty('origin');
    }

    // Normalized columns still populated. The cartridge_id column
    // carries the target cartridge id (default 'grinhaven-full' in
    // `initProject`), NOT the project slug. We assert it appears
    // somewhere in the entity VALUES line as a SQL string literal.
    expect(text).toContain(
      'INSERT INTO entities (id, kind, display_name, summary, profile, tags, cartridge_id, dynamic_origin) VALUES',
    );
    expect(entityBlock).toMatch(/, 'grinhaven-full', /);
    // Generated child→parent topology map: both parent + child appear.
    expect(text).toMatch(/FROM \(VALUES \([0-9]+, [0-9]+\)\) AS edge\(child_id, parent_id\)/);
    expect(text).toContain('JOIN entities parent ON parent.id = edge.parent_id');
    expect(text).not.toContain(
      "safe_to_bigint(child.profile->>'topology_parent_id')",
    );
  });

  it('normalizes author-facing runtime field types for SQL constraints', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-runtime-type-normalize-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('runtime-type-normalize');
    const loaded = await loadProject(project.project_slug);
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'location',
        slug: 'runtime-test-room',
        name: 'Runtime Test Room',
        summary: 'A room used by the runtime field type regression test.',
        tags: ['location'],
        payload: {
          location_kind: 'room',
          exits: ['runtime-test-room'],
          narrator_brief: 'A compact room used by tests.',
          mood_axes: {warmth: 0, danger: 0, intimacy: 0, pressure: 0},
          default_hooks: ['notice', 'door', 'ledger'],
        },
      }),
    );
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'scene',
        slug: 'runtime-test-scene',
        name: 'Runtime Test Scene',
        summary: 'A scene used by the runtime field type regression test.',
        tags: ['scene'],
        payload: {
          location_slug: 'runtime-test-room',
          participant_slugs: [],
          state_fields: [
            {key: 'scene_seen', type: 'boolean', default: false, scope: 'session'},
            {key: 'clue_count', type: 'integer', default: 0, scope: 'session'},
            {key: 'scene_note', type: 'text', default: '', scope: 'session'},
          ],
        },
      }),
    );
    const reloaded = await loadProject(project.project_slug);
    const outSql = path.join(root, 'runtime-types.sql');
    await exportGrinhavenSql(reloaded, outSql);
    const text = await readFile(outSql, 'utf8');
    expect(text).toContain("'scene_seen', 'bool'");
    expect(text).toContain("'clue_count', 'int'");
    expect(text).toContain("'scene_note', 'string'");
    expect(text).not.toContain("'scene_seen', 'boolean'");
  });

  it('validated forge SQL export refuses invalid projects unless forced', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-sql-validation-gate-'));
    process.env.CARTRIDGE_FORGE_PROJECTS = root;
    const project = await initProject('sql-validation-gate');
    const loaded = await loadProject(project.project_slug);
    await addRecord(
      loaded.root,
      makeRecord({
        kind: 'location',
        slug: 'broken-location',
        name: 'Broken Location',
        summary: 'A deliberately invalid location for SQL validation gate coverage.',
        tags: ['location'],
        payload: {},
      }),
    );
    const reloaded = await loadProject(project.project_slug);
    const blockedSql = path.join(root, 'blocked.sql');
    const blocked = await exportValidatedGrinhavenSql(reloaded, blockedSql);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.errors.map(issue => issue.field)).toContain('payload.exits');
    }
    await expect(access(blockedSql)).rejects.toThrow();

    const forcedSql = path.join(root, 'forced.sql');
    const forced = await exportValidatedGrinhavenSql(reloaded, forcedSql, {force: true});
    expect(forced.ok).toBe(true);
    if (forced.ok) {
      expect(forced.forced).toBe(true);
      expect(forced.validationErrors?.map(issue => issue.field)).toContain('payload.exits');
    }
    await expect(access(forcedSql)).resolves.toBeUndefined();
  });
});
