import {
  app,
  Menu,
  dialog,
} from 'electron';
import type {BrowserWindow} from 'electron';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {
  buildDiagnosticsPaths,
  ensureDataFolders,
  isPortableDataMode,
  resolveDesktopDataRoot,
  type DesktopDiagnosticsPaths,
} from './desktopPaths.js';
import {
  loadLocalEnv,
  loadOrCreateAuthSecret,
} from './desktopConfig.js';
import {configDirForDataRoot, installConfigIpc} from './desktopConfigIpc.js';
import {
  createDesktopDiagnostics,
  installLocalCrashReporter,
} from './desktopDiagnostics.js';
import {installFilePickerIpc} from './desktopFilePickerIpc.js';
import {installFileLogger} from './desktopLogging.js';
import {createDesktopTelemetryRecorder} from './desktopTelemetry.js';
import {createMainWindow} from './desktopWindow.js';

type StartedGreenhavenServer = {
  url: string;
  close(callback?: (err?: Error) => void): void;
};

type GreenhavenServerModule = {
  startGreenhavenServer(options: {
    hostname?: string;
    port?: number;
    staticDir?: string | null;
  }): Promise<StartedGreenhavenServer>;
  stopGreenhavenServer(server: StartedGreenhavenServer): Promise<void>;
};

const APP_NAME = 'GreenHaven';
const DESKTOP_TRACE_ID = `desktop-launch-${Date.now()}`;

let mainWindow: BrowserWindow | null = null;
let backend: StartedGreenhavenServer | null = null;
let backendModule: GreenhavenServerModule | null = null;
let desktopLogPath: string | null = null;
let diagnosticsPaths: DesktopDiagnosticsPaths | null = null;

const recordDesktopTelemetry = createDesktopTelemetryRecorder({
  traceId: DESKTOP_TRACE_ID,
  appVersion: app.getVersion(),
});

const {
  installDiagnosticsIpc,
  startDesktopNetLog,
  stopDesktopNetLog,
} = createDesktopDiagnostics({
  getDiagnosticsPaths: () => diagnosticsPaths,
  getServerUrl: () => backend?.url,
  recordTelemetry: recordDesktopTelemetry,
});

function resolveAppDataRoot(): string {
  return resolveDesktopDataRoot({userDataPath: app.getPath('userData')});
}

function resolveConfigDir(): string {
  return configDirForDataRoot(resolveAppDataRoot());
}

function resourcePath(...segments: string[]): string {
  if (app.isPackaged) {
    const externalResourcePath = path.join(process.resourcesPath, ...segments);
    if (existsSync(externalResourcePath)) return externalResourcePath;
  }
  const appPath = app.getAppPath();
  const packedPath = path.join(appPath, ...segments);
  if (appPath.endsWith('.asar')) {
    const unpackedPath = path.join(`${appPath}.unpacked`, ...segments);
    if (existsSync(unpackedPath)) return unpackedPath;
  }
  return packedPath;
}

async function fileTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fileHashOrNull(filePath: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function safeRelativeAssetPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (path.isAbsolute(raw)) return null;
  if (/^[a-zA-Z]+:[\\/]/.test(raw)) return null;
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return null;
  const normalized = path.normalize(raw);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return null;
  }
  return normalized;
}

async function cartridgeSourceAssetsChanged(
  packagedSourceRoot: string,
  targetSourceRoot: string,
  packagedForgeProject: string,
): Promise<boolean> {
  try {
    const raw = await readFile(
      path.join(packagedForgeProject, 'audit', 'visual-assets.jsonl'),
      'utf8',
    );
    const relPaths = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const relPath = safeRelativeAssetPath(parsed['path']);
      if (relPath) relPaths.add(relPath);
    }
    for (const relPath of relPaths) {
      const packagedHash = await fileHashOrNull(
        path.join(packagedSourceRoot, relPath),
      );
      const targetHash = await fileHashOrNull(
        path.join(targetSourceRoot, relPath),
      );
      if (packagedHash !== targetHash) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function prependPathEnv(key: string, value: string): void {
  const resolved = path.resolve(value);
  const existing = process.env[key];
  const parts = existing
    ? existing.split(path.delimiter).filter((part) => part.trim().length > 0)
    : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [resolved, ...parts]) {
    const normalized = path.resolve(part);
    const normalizedKey = normalized.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    out.push(normalized);
  }
  process.env[key] = out.join(path.delimiter);
}

async function installBundledDefaultCartridgeSource(
  dataRoot: string,
): Promise<{sourceRoot: string; forgeProject: string; installed: boolean}> {
  const packagedSourceRoot = resourcePath(
    'web-server',
    'default-cartridge',
    'source',
  );
  const targetSourceRoot = path.join(
    dataRoot,
    'cartridges',
    'default-greenhaven',
    'source',
  );
  const packagedForgeProject = path.join(
    packagedSourceRoot,
    '.greenhaven-agent-manual',
    'generated',
    'cartridge-forge-project',
  );
  const targetForgeProject = path.join(
    targetSourceRoot,
    '.greenhaven-agent-manual',
    'generated',
    'cartridge-forge-project',
  );
  const manifestRel = path.join('forge.project.json');
  const packagedManifest = await fileTextOrNull(
    path.join(packagedForgeProject, manifestRel),
  );
  if (!packagedManifest) {
    return {
      sourceRoot: targetSourceRoot,
      forgeProject: targetForgeProject,
      installed: false,
    };
  }

  const existingManifest = await fileTextOrNull(
    path.join(targetForgeProject, manifestRel),
  );
  const assetsChanged = await cartridgeSourceAssetsChanged(
    packagedSourceRoot,
    targetSourceRoot,
    packagedForgeProject,
  );
  const needsCopy = existingManifest !== packagedManifest || assetsChanged;
  if (needsCopy) {
    await rm(targetSourceRoot, {recursive: true, force: true});
    await mkdir(path.dirname(targetSourceRoot), {recursive: true});
    await cp(packagedSourceRoot, targetSourceRoot, {
      recursive: true,
      force: true,
    });
  }

  process.env['GREENHAVEN_DEFAULT_FORGE_PROJECT'] ??= targetForgeProject;
  process.env['GREENHAVEN_AUTO_INSTALL_DEFAULT_CARTRIDGE'] ??= '1';
  prependPathEnv('GREENHAVEN_VAULT_ROOTS', targetSourceRoot);

  return {
    sourceRoot: targetSourceRoot,
    forgeProject: targetForgeProject,
    installed: needsCopy,
  };
}

async function directoryIsEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

function safeStampName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

async function copyIfPresent(from: string, to: string): Promise<boolean> {
  if (await directoryIsEmpty(from)) return false;
  await cp(from, to, {recursive: true, force: true});
  return true;
}

async function copyFileIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await mkdir(path.dirname(to), {recursive: true});
    await writeFile(to, await readFile(from));
    return true;
  } catch {
    return false;
  }
}

async function pgliteDataDirHealth(
  pgdataDir: string,
): Promise<{ok: true} | {ok: false; error: string}> {
  if (await directoryIsEmpty(pgdataDir)) {
    return {ok: false, error: 'pgdata directory is empty'};
  }
  let db: PGlite | null = null;
  try {
    db = await PGlite.create(pgdataDir);
    await db.query('SELECT 1 AS ok');
    return {ok: true};
  } catch (err) {
    return {ok: false, error: err instanceof Error ? err.message : String(err)};
  } finally {
    if (db) await db.close().catch(() => undefined);
  }
}

async function installBundledDefaultDataTemplate(
  dataRoot: string,
): Promise<{templateRoot: string; copied: boolean}> {
  const templateRoot = resourcePath(
    'web-server',
    'default-cartridge',
    'data-template',
  );
  const templatePgdata = path.join(templateRoot, 'pgdata');
  const targetPgdata = path.join(dataRoot, 'pgdata');
  const targetCartridges = path.join(dataRoot, 'cartridges');
  const templateReportPath = path.join(
    templateRoot,
    'default-cartridge-precompile-result.json',
  );
  const templateReportText = await fileTextOrNull(templateReportPath);
  if (!templateReportText) {
    return {templateRoot, copied: false};
  }
  const templateHash = createHash('sha256')
    .update(templateReportText)
    .digest('hex');
  const stampPath = path.join(dataRoot, 'default-cartridge-template.json');
  const currentStampText = await fileTextOrNull(stampPath);
  let currentTemplateHash = '';
  try {
    const parsed = currentStampText
      ? (JSON.parse(currentStampText) as Record<string, unknown>)
      : null;
    currentTemplateHash =
      typeof parsed?.['templateHash'] === 'string'
        ? parsed['templateHash']
        : '';
  } catch {
    currentTemplateHash = '';
  }

  const hasExistingDb = !(await directoryIsEmpty(targetPgdata));
  if (hasExistingDb && currentTemplateHash === templateHash) {
    const health = await pgliteDataDirHealth(targetPgdata);
    if (health.ok) {
      return {templateRoot, copied: false};
    }
    console.warn(
      `[greenhaven-desktop] local pgdata is unusable; restoring bundled default template: ${health.error}`,
    );
  }

  if (hasExistingDb) {
    const backupRoot = path.join(
      dataRoot,
      'backups',
      `default-cartridge-template-${safeStampName(new Date().toISOString())}`,
    );
    await mkdir(backupRoot, {recursive: true});
    await copyIfPresent(targetPgdata, path.join(backupRoot, 'pgdata'));
    await copyIfPresent(targetCartridges, path.join(backupRoot, 'cartridges'));
    await copyFileIfPresent(stampPath, path.join(backupRoot, 'stamp.json'));
  }

  await rm(targetPgdata, {recursive: true, force: true});
  await rm(targetCartridges, {recursive: true, force: true});
  await cp(templatePgdata, targetPgdata, {recursive: true, force: true});

  const templateCartridges = path.join(templateRoot, 'cartridges');
  try {
    await mkdir(targetCartridges, {recursive: true});
    await cp(templateCartridges, targetCartridges, {
      recursive: true,
      force: true,
    });
  } catch {
    // Some cartridges may have no visual assets yet. The DB is still
    // valid; runtime asset routes will 404 missing cache entries.
  }
  await writeFile(
    stampPath,
    `${JSON.stringify(
      {
        templateHash,
        installedAt: new Date().toISOString(),
        templateRoot,
        report: JSON.parse(templateReportText) as Record<string, unknown>,
      },
      null,
      2,
    )}\n`,
  );

  return {templateRoot, copied: true};
}

async function prepareRuntimeEnv(dataRoot: string): Promise<void> {
  const configDir = path.join(dataRoot, 'config');
  const logDir = path.join(dataRoot, 'logs');

  desktopLogPath = installFileLogger(logDir);
  await loadLocalEnv(configDir);

  const authSecret = process.env['AUTH_SECRET'];
  if (!authSecret || authSecret.length < 32) {
    process.env['AUTH_SECRET'] = await loadOrCreateAuthSecret(configDir);
  }

  // Desktop is a local embedded app. Do not accidentally inherit a global
  // DATABASE_URL and point player data at an external server.
  delete process.env['DATABASE_URL'];
  delete process.env['AUTH_DISABLED'];
}

async function validatePackagedAssets(): Promise<
  Array<{name: string; path: string; ok: boolean; size?: number; error?: string}>
> {
  const defaultCartridgeRoot = resourcePath('web-server', 'default-cartridge');
  const defaultCartridgeSource = path.join(defaultCartridgeRoot, 'source');
  const defaultCartridgeDataTemplate = path.join(
    defaultCartridgeRoot,
    'data-template',
  );
  const precompileReportPath = path.join(
    defaultCartridgeDataTemplate,
    'default-cartridge-precompile-result.json',
  );
  const defaultForgeManifestPath = path.join(
    defaultCartridgeSource,
    '.greenhaven-agent-manual',
    'generated',
    'cartridge-forge-project',
    'forge.project.json',
  );
  const hasDefaultCartridge =
    (await fileTextOrNull(precompileReportPath)) != null ||
    (await fileTextOrNull(defaultForgeManifestPath)) != null;
  let defaultVisibleWorldDir = 'GreenhavenNoir';
  try {
    const report = JSON.parse(await readFile(precompileReportPath, 'utf8')) as {
      visibleWorldRoot?: unknown;
    };
    const visibleWorldRoot =
      typeof report.visibleWorldRoot === 'string' ? report.visibleWorldRoot : '';
    const last = visibleWorldRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop();
    if (last && !last.includes('..') && !last.includes(':')) {
      defaultVisibleWorldDir = last;
    }
  } catch {
    // Keep the historical default until the precompile report exists.
  }
  const checks = [
    {
      name: 'backend_entry',
      path: path.join(app.getAppPath(), 'web-server', 'dist', 'index.js'),
    },
    {
      name: 'backend_migrations',
      path: path.join(app.getAppPath(), 'web-server', 'migrations'),
    },
    {
      // FEAT-ENGINE-BASELINE-3 — runMigrations() boots from this file
      // on every fresh PGlite install. A missing baseline silently
      // produces an empty schema; surface it like the other assets.
      name: 'backend_baseline',
      path: path.join(
        app.getAppPath(),
        'web-server',
        'baseline',
        '0001_engine_baseline.sql',
      ),
    },
    {
      name: 'frontend_index',
      path: resourcePath('web-ui', 'dist', 'index.html'),
    },
  ];
  if (!hasDefaultCartridge) {
    checks.push({
      name: 'default_cartridge_optional',
      path: defaultCartridgeRoot,
    });
  } else {
    checks.push(
    {
      name: 'default_cartridge_forge',
      path: defaultForgeManifestPath,
    },
    {
      name: 'default_cartridge_precompiled_db',
      path: precompileReportPath,
    },
    {
      name: 'default_cartridge_precompiled_pgdata',
      path: path.join(defaultCartridgeDataTemplate, 'pgdata', 'PG_VERSION'),
    },
    {
      name: 'default_cartridge_visible_world',
      path: path.join(defaultCartridgeSource, defaultVisibleWorldDir),
    },
    {
      name: 'default_cartridge_visual_asset_audit',
      path: path.join(
        defaultCartridgeSource,
        '.greenhaven-agent-manual',
        'generated',
        'cartridge-forge-project',
        'audit',
        'visual-assets.jsonl',
      ),
    },
    );
  }
  const results = [];
  for (const check of checks) {
    try {
      const s = await stat(check.path);
      results.push({
        name: check.name,
        path: check.path,
        ok: true,
        size: s.size,
      });
    } catch (err) {
      results.push({
        name: check.name,
        path: check.path,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!hasDefaultCartridge) {
    return results;
  }

  try {
    const report = JSON.parse(
      await readFile(precompileReportPath, 'utf8'),
    ) as Record<string, unknown>;
    const cartridgeId =
      typeof report['cartridgeId'] === 'string'
        ? report['cartridgeId'].trim()
        : '';
    if (!cartridgeId) {
      results.push({
        name: 'default_cartridge_precompiled_cartridge_id',
        path: precompileReportPath,
        ok: false,
        error: 'precompile report has no cartridgeId',
      });
    } else {
      const assetCache = path.join(
        defaultCartridgeDataTemplate,
        'cartridges',
        cartridgeId,
        'assets',
      );
      try {
        const s = await stat(assetCache);
        results.push({
          name: 'default_cartridge_asset_cache',
          path: assetCache,
          ok: true,
          size: s.size,
        });
      } catch (err) {
        results.push({
          name: 'default_cartridge_asset_cache',
          path: assetCache,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const entries = await readdir(assetCache, {withFileTypes: true});
        const count = entries.filter((entry) => entry.isFile()).length;
        results.push({
          name: 'default_cartridge_asset_cache_files',
          path: assetCache,
          ok: count > 0,
          size: count,
          error: count > 0 ? undefined : 'asset cache contains no files',
        });
      } catch (err) {
        results.push({
          name: 'default_cartridge_asset_cache_files',
          path: assetCache,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    results.push({
      name: 'default_cartridge_precompile_report_json',
      path: precompileReportPath,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return results;
}

async function loadBackendModule(): Promise<GreenhavenServerModule> {
  const modulePath = path.join(app.getAppPath(), 'web-server', 'dist', 'index.js');
  return (await import(pathToFileURL(modulePath).href)) as GreenhavenServerModule;
}

async function startBackend(): Promise<StartedGreenhavenServer> {
  const dataRoot = resolveAppDataRoot();
  await ensureDataFolders(dataRoot);
  diagnosticsPaths = buildDiagnosticsPaths(dataRoot);
  await prepareRuntimeEnv(dataRoot);
  const defaultDataTemplate = await installBundledDefaultDataTemplate(dataRoot);
  const defaultCartridge = await installBundledDefaultCartridgeSource(dataRoot);
  installLocalCrashReporter(diagnosticsPaths, APP_NAME);

  process.env['NODE_ENV'] = 'production';
  process.env['GREENHAVEN_DESKTOP'] = '1';
  process.env['GREENHAVEN_DEBUG_ROUTES'] ??= '0';
  process.env['PGLITE_DATA_DIR'] = path.join(dataRoot, 'pgdata');
  process.env['GREENHAVEN_DATA_DIR'] = dataRoot;
  process.env['GREENHAVEN_CONFIG_DIR'] = path.join(dataRoot, 'config');
  process.env['GREENHAVEN_SAVE_DIR'] = path.join(dataRoot, 'saves');
  process.env['GREENHAVEN_LOG_DIR'] = path.join(dataRoot, 'logs');
  process.env['GREENHAVEN_BACKUP_DIR'] = path.join(dataRoot, 'backups');

  const webUiDist = resourcePath('web-ui', 'dist');
  process.env['GREENHAVEN_WEB_UI_DIST'] = webUiDist;

  const assetChecks = await validatePackagedAssets();
  const missing = assetChecks.filter(check => !check.ok);
  if (missing.length > 0) {
    throw new Error(
      `GreenHaven packaged assets missing: ${missing
        .map(check => `${check.name}=${check.error}`)
        .join('; ')}`,
    );
  }

  backendModule = await loadBackendModule();
  const startedAt = Date.now();
  const server = await backendModule.startGreenhavenServer({
    hostname: '127.0.0.1',
    port: 0,
    staticDir: webUiDist,
  });
  await recordDesktopTelemetry(server.url, {
    events: [
      {
        schemaName: 'desktop.backend_started',
        eventName: 'backend_started',
        severity: 'info',
        properties: {
          url: server.url,
          data_mode: isPortableDataMode() ? 'portable' : 'userData',
          asset_checks: assetChecks.map(check => ({
            name: check.name,
            ok: check.ok,
            size: check.size ?? null,
          })),
          default_cartridge: {
            source_root: defaultCartridge.sourceRoot,
            forge_project: defaultCartridge.forgeProject,
            copied_to_data: defaultCartridge.installed,
            precompiled_db_template: defaultDataTemplate.templateRoot,
            precompiled_db_copied: defaultDataTemplate.copied,
          },
        },
      },
    ],
    spans: [
      {
        name: 'desktop.backend_start',
        status: 'ok',
        durationMs: Date.now() - startedAt,
        attributes: {
          static_dir_present: true,
          asset_checks: assetChecks.length,
        },
      },
    ],
    artifacts: desktopLogPath
      ? [
          {
            artifactType: 'desktop_log',
            path: desktopLogPath,
            mimeType: 'text/plain',
            redactionTier: 'tier1_local_debug',
            metadata: {role: 'main_process_log'},
          },
        ]
      : [],
  });
  if (process.env['GREENHAVEN_DESKTOP_NETLOG'] === '1') {
    await startDesktopNetLog('startup_env', server.url);
  }
  return server;
}

async function boot(): Promise<void> {
  app.setName(APP_NAME);
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  await app.whenReady();
  installDiagnosticsIpc();
  installConfigIpc({getConfigDir: resolveConfigDir});
  installFilePickerIpc();
  app.on('child-process-gone', (_event, details) => {
    void recordDesktopTelemetry(backend?.url, {
      events: [
        {
          schemaName: 'desktop.child_process_gone',
          eventName: 'child_process_gone',
          severity: 'warn',
          properties: {
            type: details.type,
            reason: details.reason,
            exit_code: details.exitCode,
            service_name: details.serviceName,
          },
        },
      ],
    });
  });
  // Strip the default Electron application menu (File / Edit / View /
  // Window / Help). Greenhaven is a fullscreen narrative app — those
  // entries are noise. Must run before any BrowserWindow is created
  // so the window is born without a menu, no flicker.
  Menu.setApplicationMenu(null);
  backend = await startBackend();
  // Monotonic launch counter persisted in the selected data root.
  // The renderer can't keep this in localStorage because the backend
  // listens on an ephemeral port (port: 0), so every launch is a
  // different origin and Chromium gives the renderer a fresh empty
  // storage. We pass the counter as a URL query param; the renderer
  // applies modulo by the number of background files it bundles.
  const launchIndex = await nextLaunchCounter(
    diagnosticsPaths?.dataRoot ?? resolveAppDataRoot(),
  );
  const launchUrl = appendQuery(backend.url, 'launch', String(launchIndex));
  mainWindow = await createMainWindow({
    url: launchUrl,
    appName: APP_NAME,
    appPath: app.getAppPath(),
    getServerUrl: () => backend?.url,
    recordTelemetry: recordDesktopTelemetry,
  });
}

async function nextLaunchCounter(dataRoot: string): Promise<number> {
  const file = path.join(dataRoot, 'boot-state.json');
  let prev = -1;
  try {
    const buf = await readFile(file, 'utf8');
    const parsed = JSON.parse(buf) as {launchCounter?: number};
    if (typeof parsed.launchCounter === 'number' && Number.isFinite(parsed.launchCounter)) {
      prev = parsed.launchCounter;
    }
  } catch {
    // First launch or unreadable — start from -1 so we end up at 0.
  }
  const next = prev + 1;
  try {
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, JSON.stringify({launchCounter: next}));
  } catch (err) {
    console.warn('boot-state write failed:', err);
  }
  return next;
}

function appendQuery(rawUrl: string, key: string, value: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

async function shutdown(): Promise<void> {
  await stopDesktopNetLog('app_shutdown');
  if (backend && backendModule) {
    await recordDesktopTelemetry(backend.url, {
      events: [
        {
          schemaName: 'desktop.shutdown',
          eventName: 'shutdown',
          severity: 'info',
          properties: {},
        },
      ],
    });
    await backendModule.stopGreenhavenServer(backend);
  }
  backend = null;
}

app.on('before-quit', event => {
  if (!backend) return;
  event.preventDefault();
  void shutdown().finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  app.quit();
});

void boot().catch(err => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error('[greenhaven-desktop] boot failed:', message);
  void dialog.showErrorBox('GreenHaven failed to start', message);
  app.exit(1);
});
