import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeCartridgeEntityPredicate,
  activeCartridgeId,
} from '../cartridgeScope.js';
import {
  clearConfigEnv,
  config,
  rawConfigEnv,
  setConfigEnv,
} from '../config.js';

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

interface LocationRow {
  id: number;
  display_name: string;
  location_kind: string | null;
  source_category: string | null;
  npc_count: number;
  child_location_count: number;
  scene_count: number;
  event_count: number;
  activity_count: number;
  quest_count: number;
  transitive_npc_count: number;
  transitive_scene_count: number;
  transitive_event_count: number;
  transitive_activity_count: number;
  transitive_quest_count: number;
  descendant_location_count: number;
}

interface BadDensityRow {
  location_id: number;
  location_name: string;
  bucket: string;
  bad_id: number;
  actual_kind: string | null;
  actual_name: string | null;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.fixtureMode === 'temp') {
    clearConfigEnv('DATABASE_URL');
    const base =
      rawConfigEnv('GREENHAVEN_DEVTOOLS_TMP') ??
      (process.platform === 'win32' ? 'C:\\tmp' : '/tmp');
    await mkdir(base, { recursive: true });
    setConfigEnv(
      'PGLITE_DATA_DIR',
      await mkdtemp(path.join(base, 'greenhaven-location-linkage-')),
    );
  }

  const { runMigrations } = await import('../migrate.js');
  const { query, closeDb } = await import('../db.js');
  await runMigrations();
  const cartridgeId = await activeCartridgeId();

  const locations = await query<LocationRow>(
    `SELECT id,
            display_name,
            profile->>'location_kind' AS location_kind,
            profile->>'source_category' AS source_category,
            COALESCE((profile->'local_density_summary'->>'npc_count')::int, 0) AS npc_count,
            COALESCE((profile->'local_density_summary'->>'child_location_count')::int, 0) AS child_location_count,
            COALESCE((profile->'local_density_summary'->>'scene_count')::int, 0) AS scene_count,
            COALESCE((profile->'local_density_summary'->>'event_count')::int, 0) AS event_count,
            COALESCE((profile->'local_density_summary'->>'activity_count')::int, 0) AS activity_count,
            COALESCE((profile->'local_density_summary'->>'quest_count')::int, 0) AS quest_count,
            COALESCE((profile->'transitive_density_summary'->>'npc_count')::int, 0) AS transitive_npc_count,
            COALESCE((profile->'transitive_density_summary'->>'scene_count')::int, 0) AS transitive_scene_count,
            COALESCE((profile->'transitive_density_summary'->>'event_count')::int, 0) AS transitive_event_count,
            COALESCE((profile->'transitive_density_summary'->>'activity_count')::int, 0) AS transitive_activity_count,
            COALESCE((profile->'transitive_density_summary'->>'quest_count')::int, 0) AS transitive_quest_count,
            COALESCE((profile->'transitive_density_summary'->>'descendant_location_count')::int, 0) AS descendant_location_count
       FROM entities
      WHERE kind IN ('location', 'district')
        AND ${activeCartridgeEntityPredicate('entities', '$1')}
      ORDER BY id`,
    [cartridgeId],
  );

  const badDensity = await query<BadDensityRow>(
    // M-5: safe_to_bigint filters malformed and bigint-overflow ids
    // to NULL so the audit query continues to surface genuinely
    // wrong-kind ids without aborting on a stray garbage entry.
    // M-6: safe_jsonb_array hardens the inner array shape. The
    // outer object-shape guard stays — safe_jsonb_array is for
    // arrays only, not for arbitrary JSONB shape coercion.
    `SELECT l.id AS location_id,
            l.display_name AS location_name,
            bucket.key AS bucket,
            safe_to_bigint(value) AS bad_id,
            e.kind AS actual_kind,
            e.display_name AS actual_name
       FROM entities l
       CROSS JOIN LATERAL jsonb_each(
         CASE
           WHEN jsonb_typeof(l.profile->'local_density') = 'object'
           THEN l.profile->'local_density'
           ELSE '{}'::jsonb
         END
       ) AS bucket(key, arr)
       CROSS JOIN LATERAL jsonb_array_elements_text(
         safe_jsonb_array(bucket.arr)
       ) AS value
       LEFT JOIN entities e ON e.id = safe_to_bigint(value)
      WHERE l.kind IN ('location','district')
        AND ${activeCartridgeEntityPredicate('l', '$1')}
        AND safe_to_bigint(value) IS NOT NULL
        AND (
          (bucket.key = 'npc_ids' AND e.kind IS DISTINCT FROM 'person')
          OR (bucket.key = 'child_location_ids' AND e.kind NOT IN ('location','district'))
          OR (bucket.key = 'scene_ids' AND e.kind IS DISTINCT FROM 'scene')
          OR (bucket.key = 'event_ids' AND e.kind IS DISTINCT FROM 'event')
          OR (bucket.key = 'activity_ids' AND e.kind IS DISTINCT FROM 'activity')
          OR (bucket.key = 'quest_ids' AND e.kind IS DISTINCT FROM 'quest')
        )
      ORDER BY l.id, bucket.key, bad_id
      LIMIT 200`,
    [cartridgeId],
  );

  const report = buildReport(locations.rows, badDensity.rows, cartridgeId);
  if (args.write) {
    const outDir = config().contentReportDir ?? path.resolve(REPO_ROOT, 'docs');
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.resolve(outDir, 'greenhaven-location-linkage-audit.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.resolve(outDir, 'greenhaven-location-linkage-audit.md'),
      renderMarkdown(report),
      'utf8',
    );
  }
  await closeDb();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (err) {
  process.stdout.write(
    `${JSON.stringify(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

function buildReport(
  locations: LocationRow[],
  badDensity: BadDensityRow[],
  cartridgeId: string,
) {
  const visible = locations.filter(
    (row) => row.source_category !== 'discovered-location-ref',
  );
  const authored = visible.filter(
    (row) =>
      !['discovered', 'hub'].includes(
        String(row.location_kind ?? '').toLowerCase(),
      ),
  );
  const playable = authored.filter(
    (row) =>
      !['district'].includes(String(row.location_kind ?? '').toLowerCase()),
  );
  const emptyPlayable = playable.filter((row) => totalDensity(row) === 0);
  const quietPlayable = playable.filter(
    (row) => totalDensity(row) > 0 && row.npc_count === 0,
  );
  // After 0093 the strict cap is 16, but >8 still flags suspect concentration
  // worth a glance during cartridge work.
  const overloadedNpc = authored.filter((row) => row.npc_count > 8);
  const districts = visible.filter(
    (row) => String(row.location_kind ?? '').toLowerCase() === 'district',
  );
  const emptyDistricts = districts.filter(
    (row) => transitiveTotal(row) === 0 && row.descendant_location_count === 0,
  );
  const denseByTotal = [...authored]
    .sort((a, b) => totalDensity(b) - totalDensity(a))
    .slice(0, 25);
  const denseByTransitive = [...visible]
    .sort((a, b) => transitiveTotal(b) - transitiveTotal(a))
    .slice(0, 25);

  return {
    ok: badDensity.length === 0,
    schema: 'greenhaven.location_linkage_audit.v1',
    generatedAt: new Date().toISOString(),
    cartridgeId,
    totals: {
      locations: locations.length,
      visible: visible.length,
      authored: authored.length,
      playable: playable.length,
      emptyPlayable: emptyPlayable.length,
      quietPlayable: quietPlayable.length,
      overloadedNpc: overloadedNpc.length,
      emptyDistricts: emptyDistricts.length,
      badDensity: badDensity.length,
    },
    emptyPlayable: emptyPlayable.slice(0, 80),
    quietPlayable: quietPlayable.slice(0, 80),
    overloadedNpc,
    emptyDistricts,
    denseByTotal,
    denseByTransitive,
    badDensity,
    guidance: [
      'badDensity must stay zero: local_density buckets must contain only matching entity kinds.',
      'local_density is the strict "lives/happens here" cache (post-0093) — direct ownership only, no power-center duplication.',
      'transitive_density_summary is the recursive roll-up across topology_parent_id descendants — use it when surfacing district reach.',
      'emptyPlayable locations need either authored first-entry prose only, or real scene/activity/NPC/quest links before demo exposure.',
      'overloadedNpc locations (npc_count > 8) usually mean a hub is doubling as a residence; check whether NPCs should live in a child venue instead.',
      'emptyDistricts means a district has no descendants and no direct content — likely a stray topology_parent_id or an unused tag.',
    ],
  };
}

function renderMarkdown(report: ReturnType<typeof buildReport>): string {
  const lines: string[] = [
    '# Greenhaven Location Linkage Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Cartridge: ${report.cartridgeId}`,
    '',
    '## Totals',
    '',
    `- Locations: ${report.totals.locations}`,
    `- Visible locations: ${report.totals.visible}`,
    `- Authored locations: ${report.totals.authored}`,
    `- Playable locations: ${report.totals.playable}`,
    `- Empty playable locations: ${report.totals.emptyPlayable}`,
    `- Quiet playable locations: ${report.totals.quietPlayable}`,
    `- Overloaded NPC locations (>8 direct): ${report.totals.overloadedNpc}`,
    `- Empty districts (no descendants, no content): ${report.totals.emptyDistricts}`,
    `- Bad density entries: ${report.totals.badDensity}`,
    '',
    '## Bad Density Entries',
    '',
  ];
  if (report.badDensity.length === 0) lines.push('- none');
  else {
    for (const row of report.badDensity) {
      lines.push(
        `- ${row.location_id} ${row.location_name} ${row.bucket}: ${row.bad_id} ${row.actual_kind ?? 'missing'} ${row.actual_name ?? ''}`,
      );
    }
  }
  lines.push('', '## Empty Playable Locations', '');
  if (report.emptyPlayable.length === 0) lines.push('- none');
  else {
    for (const row of report.emptyPlayable.slice(0, 40)) {
      lines.push(
        `- ${row.id} ${row.display_name} (${row.location_kind ?? '?'})`,
      );
    }
  }
  lines.push('', '## Quiet Playable Locations', '');
  if (report.quietPlayable.length === 0) lines.push('- none');
  else {
    for (const row of report.quietPlayable.slice(0, 40)) {
      lines.push(
        `- ${row.id} ${row.display_name}: total ${totalDensity(row)}, npc ${row.npc_count}, scenes ${row.scene_count}, activities ${row.activity_count}, quests ${row.quest_count}`,
      );
    }
  }
  lines.push('', '## Overloaded NPC Locations', '');
  if (report.overloadedNpc.length === 0) lines.push('- none');
  else {
    for (const row of report.overloadedNpc) {
      lines.push(
        `- ${row.id} ${row.display_name}: npc ${row.npc_count}, total ${totalDensity(row)}`,
      );
    }
  }
  lines.push('', '## Densest Authored Locations (direct)', '');
  for (const row of report.denseByTotal.slice(0, 20)) {
    lines.push(
      `- ${row.id} ${row.display_name}: total ${totalDensity(row)}; npc ${row.npc_count}, scenes ${row.scene_count}, events ${row.event_count}, activities ${row.activity_count}, quests ${row.quest_count}`,
    );
  }
  lines.push('', '## Densest by Transitive Reach', '');
  for (const row of report.denseByTransitive.slice(0, 20)) {
    lines.push(
      `- ${row.id} ${row.display_name} (${row.location_kind ?? '?'}): transitive total ${transitiveTotal(row)} across ${row.descendant_location_count} descendants; npc ${row.transitive_npc_count}, scenes ${row.transitive_scene_count}, events ${row.transitive_event_count}, activities ${row.transitive_activity_count}, quests ${row.transitive_quest_count}`,
    );
  }
  lines.push('', '## Empty Districts', '');
  if (report.emptyDistricts.length === 0) lines.push('- none');
  else {
    for (const row of report.emptyDistricts) {
      lines.push(`- ${row.id} ${row.display_name}`);
    }
  }
  lines.push('', '## Guidance', '');
  for (const item of report.guidance) lines.push(`- ${item}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function totalDensity(row: LocationRow): number {
  return (
    row.npc_count +
    row.child_location_count +
    row.scene_count +
    row.event_count +
    row.activity_count +
    row.quest_count
  );
}

function transitiveTotal(row: LocationRow): number {
  return (
    row.transitive_npc_count +
    row.transitive_scene_count +
    row.transitive_event_count +
    row.transitive_activity_count +
    row.transitive_quest_count
  );
}

function parseArgs(argv: string[]): {
  fixtureMode: 'temp' | 'existing';
  write: boolean;
} {
  const out: { fixtureMode: 'temp' | 'existing'; write: boolean } = {
    fixtureMode: 'existing',
    write: false,
  };
  for (const arg of argv) {
    if (arg === '--write') out.write = true;
    else if (arg === '--fixture-mode=temp') out.fixtureMode = 'temp';
    else if (arg === '--fixture-mode=existing') out.fixtureMode = 'existing';
  }
  return out;
}
