import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeCartridgeEntityPredicate,
  activeCartridgeId,
} from '../cartridgeScope.js';
import {
  classifyEntityQuality,
  type ContentQualityEntity,
} from '../contentQuality.js';
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

interface EntityRow extends ContentQualityEntity {
  id: number;
  i18n: Record<string, unknown> | null;
}

interface KindStats {
  total: number;
  demoReady: number;
  placeholder: number;
  sparse: number;
  hidden: number;
  missingSummary: number;
  withI18n: number;
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
      await mkdtemp(path.join(base, 'greenhaven-content-readiness-')),
    );
  }

  const { runMigrations } = await import('../migrate.js');
  const { query, closeDb } = await import('../db.js');
  await runMigrations();
  const cartridgeId = await activeCartridgeId();
  const rows = await query<EntityRow>(
    `SELECT id, kind, display_name, summary, profile, tags, i18n
       FROM entities
      WHERE ${activeCartridgeEntityPredicate('entities', '$1')}
      ORDER BY kind, id`,
    [cartridgeId],
  );
  const report = buildReport(rows.rows, cartridgeId);
  if (args.write) {
    const outDir = config().contentReportDir ?? path.resolve(REPO_ROOT, 'docs');
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.resolve(outDir, 'greenhaven-demo-content-readiness-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.resolve(outDir, 'greenhaven-demo-content-readiness-report.md'),
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

function buildReport(rows: EntityRow[], cartridgeId: string) {
  const byKind: Record<string, KindStats> = {};
  const reasonCounts: Record<string, number> = {};
  const placeholderSamples: Array<{
    id: number;
    kind: string;
    name: string;
    reasons: string[];
  }> = [];
  const sparseSamples: Array<{
    id: number;
    kind: string;
    name: string;
    reasons: string[];
  }> = [];
  const invalidExitSamples: Array<{
    locationId: number;
    locationName: string;
    missingExitIds: number[];
  }> = [];
  const idSet = new Set(rows.map((row) => Number(row.id)));

  for (const row of rows) {
    const stat = (byKind[row.kind] ??= {
      total: 0,
      demoReady: 0,
      placeholder: 0,
      sparse: 0,
      hidden: 0,
      missingSummary: 0,
      withI18n: 0,
    });
    stat.total += 1;
    const quality = classifyEntityQuality(row);
    if (quality.demoReady) stat.demoReady += 1;
    if (quality.placeholder) stat.placeholder += 1;
    if (quality.sparse) stat.sparse += 1;
    if (!row.summary?.trim()) stat.missingSummary += 1;
    if (row.i18n && Object.keys(row.i18n).length > 0) stat.withI18n += 1;
    if (row.profile?.['hidden_until_stage'] != null) stat.hidden += 1;
    for (const reason of quality.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
    if (quality.placeholder && placeholderSamples.length < 80) {
      placeholderSamples.push({
        id: row.id,
        kind: row.kind,
        name: row.display_name,
        reasons: quality.reasons,
      });
    } else if (quality.sparse && sparseSamples.length < 80) {
      sparseSamples.push({
        id: row.id,
        kind: row.kind,
        name: row.display_name,
        reasons: quality.reasons,
      });
    }

    if (row.kind === 'location' || row.kind === 'district') {
      const exits = readIdArray(row.profile?.['exits']);
      const missing = exits.filter((id) => !idSet.has(id));
      if (missing.length > 0 && invalidExitSamples.length < 50) {
        invalidExitSamples.push({
          locationId: row.id,
          locationName: row.display_name,
          missingExitIds: missing,
        });
      }
    }
  }

  const totals = {
    entities: rows.length,
    demoReady: Object.values(byKind).reduce(
      (sum, item) => sum + item.demoReady,
      0,
    ),
    placeholder: Object.values(byKind).reduce(
      (sum, item) => sum + item.placeholder,
      0,
    ),
    sparse: Object.values(byKind).reduce((sum, item) => sum + item.sparse, 0),
    hidden: Object.values(byKind).reduce((sum, item) => sum + item.hidden, 0),
  };
  return {
    ok: true,
    schema: 'greenhaven.demo_content_readiness.v1',
    generatedAt: new Date().toISOString(),
    cartridgeId,
    totals,
    completionPercent:
      totals.entities > 0
        ? Math.round((totals.demoReady / totals.entities) * 1000) / 10
        : 0,
    byKind,
    reasonCounts: Object.fromEntries(
      Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]),
    ),
    placeholderSamples,
    sparseSamples,
    invalidExitSamples,
    demoGuidance: [
      'Runtime filters now hide high-confidence placeholder/template entities from navigation, nearby NPC lists, @-mentions, entity search, and prompt catalogues.',
      'Sparse entities are reported but not hidden automatically: they may still be useful if authored through runtime fields or instructions.',
      'Fix placeholderSamples first, then sparseSamples for person/location/quest kinds that appear in the starting region.',
    ],
  };
}

function renderMarkdown(report: ReturnType<typeof buildReport>): string {
  const lines: string[] = [
    '# Greenhaven Demo Content Readiness',
    '',
    `Generated: ${report.generatedAt}`,
    `Cartridge: ${report.cartridgeId}`,
    '',
    `Overall demo-ready completion: **${report.completionPercent}%**`,
    '',
    '## Totals',
    '',
    `- Entities: ${report.totals.entities}`,
    `- Demo-ready: ${report.totals.demoReady}`,
    `- Placeholders hidden by runtime filter: ${report.totals.placeholder}`,
    `- Sparse but still visible: ${report.totals.sparse}`,
    `- Hidden by quest/stage: ${report.totals.hidden}`,
    '',
    '## By Kind',
    '',
    '| Kind | Total | Demo-ready | Placeholder | Sparse | Hidden | Missing summary | i18n |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [kind, stat] of Object.entries(report.byKind)) {
    lines.push(
      `| ${kind} | ${stat.total} | ${stat.demoReady} | ${stat.placeholder} | ${stat.sparse} | ${stat.hidden} | ${stat.missingSummary} | ${stat.withI18n} |`,
    );
  }
  lines.push('', '## Top Reasons', '');
  for (const [reason, count] of Object.entries(report.reasonCounts).slice(
    0,
    30,
  )) {
    lines.push(`- ${reason}: ${count}`);
  }
  lines.push('', '## Placeholder Samples', '');
  for (const sample of report.placeholderSamples.slice(0, 40)) {
    lines.push(
      `- ${sample.kind} ${sample.id} ${sample.name}: ${sample.reasons.join(', ')}`,
    );
  }
  lines.push('', '## Sparse Samples', '');
  for (const sample of report.sparseSamples.slice(0, 40)) {
    lines.push(
      `- ${sample.kind} ${sample.id} ${sample.name}: ${sample.reasons.join(', ')}`,
    );
  }
  lines.push('', '## Invalid Exit Samples', '');
  if (report.invalidExitSamples.length === 0) {
    lines.push('- none');
  } else {
    for (const sample of report.invalidExitSamples) {
      lines.push(
        `- ${sample.locationId} ${sample.locationName}: missing ${sample.missingExitIds.join(', ')}`,
      );
    }
  }
  lines.push('', '## Demo Guidance', '');
  for (const item of report.demoGuidance) lines.push(`- ${item}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv: string[]): {
  fixtureMode: 'temp' | 'existing';
  write: boolean;
} {
  const out: { fixtureMode: 'temp' | 'existing'; write: boolean } = {
    fixtureMode: 'existing',
    write: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--write') {
      out.write = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for ${arg}`);
    }
    i += 1;
    if (arg === '--fixture-mode') {
      if (value !== 'temp' && value !== 'existing') {
        throw new Error('--fixture-mode must be temp or existing');
      }
      out.fixtureMode = value;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return out;
}

function readIdArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readExitId)
    .filter((item) => Number.isInteger(item) && item > 0);
}

function readExitId(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Number((value as Record<string, unknown>)['id']);
  }
  return Number(value);
}
