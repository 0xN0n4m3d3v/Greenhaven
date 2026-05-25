import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoPackages = path.resolve(packageRoot, '..');
const repoRoot = path.resolve(repoPackages, '..');
const webServerRoot = path.join(repoPackages, 'web-server');
const webUiRoot = path.join(repoPackages, 'web-ui');
const defaultWorldRoot = path.join(repoRoot, 'GreenhavenWorld');
const DEFAULT_WORLD_DIR = 'GreenhavenNoir';
const CARTRIDGE_MODE = (
  process.env.GREENHAVEN_DESKTOP_CARTRIDGE_MODE || 'default'
).trim().toLowerCase();
const CUSTOM_WORLD_PATH = process.env.GREENHAVEN_DESKTOP_WORLD_PATH ?? '';
const CUSTOM_WORLDS_MANIFEST =
  process.env.GREENHAVEN_DESKTOP_WORLDS_MANIFEST ?? '';

function slugFromWorldDir(worldDir) {
  const out = [];
  let prev = '';
  for (const char of String(worldDir || '').trim()) {
    if (/[\p{Letter}\p{Number}]/u.test(char)) {
      if (/[A-Z]/.test(char) && prev && (/[a-z]/.test(prev) || /\d/.test(prev))) {
        out.push('-');
      }
      out.push(char.toLowerCase());
      prev = char;
    } else if (out.length > 0 && out[out.length - 1] !== '-') {
      out.push('-');
      prev = char;
    }
  }
  return out.join('').replace(/^-+|-+$/g, '') || 'greenhaven-world';
}

function titleFromWorldDir(worldDir) {
  const out = [];
  let prev = '';
  for (const char of String(worldDir || '').trim()) {
    if (/[\p{Letter}\p{Number}]/u.test(char)) {
      if (/[A-Z]/.test(char) && prev && (/[a-z]/.test(prev) || /\d/.test(prev))) {
        out.push(' ');
      }
      out.push(char);
      prev = char;
    } else if (out.length > 0 && out[out.length - 1] !== ' ') {
      out.push(' ');
      prev = char;
    }
  }
  return out.join('').trim().replace(/\s+/g, ' ') || 'Greenhaven World';
}

function transformerScriptFor(vaultRoot) {
  return path.join(
    vaultRoot,
    '.greenhaven-agent-manual',
    'skills',
    'greenhaven-human-world-transformer',
    'scripts',
    'compile_vault_to_forge.py',
  );
}

async function copyDir(from, to) {
  await mkdir(path.dirname(to), {recursive: true});
  await cp(from, to, {recursive: true, force: true});
}

async function copyFile(from, to) {
  await mkdir(path.dirname(to), {recursive: true});
  await writeFile(to, await readFile(from));
}

async function pathExists(value) {
  try {
    await readdir(value);
    return true;
  } catch {
    return false;
  }
}

function safeWorldDir(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/`/g, '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!cleaned || cleaned.startsWith('/') || cleaned.includes(':')) return null;
  if (cleaned === '..' || cleaned.startsWith('../') || cleaned.includes('/../')) {
    return null;
  }
  if (cleaned.includes('/')) return null;
  return cleaned;
}

async function activeWorldDir(vaultRoot) {
  const explicit = safeWorldDir(process.env.GREENHAVEN_DEFAULT_WORLD_DIR);
  if (explicit) return explicit;
  const manifestPath = path.join(vaultRoot, 'WORLD_MANIFEST.md');
  try {
    const text = await readFile(manifestPath, 'utf8');
    const match = text.match(/^##\s+Active World Root\s*([\s\S]*?)(?=^##\s+|$)/im);
    if (match) {
      const block = match[1] ?? '';
      const code = block.match(/```(?:text|md|markdown)?\s*([\s\S]*?)\s*```/i);
      const candidates = [code?.[1], ...block.split(/\r?\n/)];
      for (const candidate of candidates) {
        const dir = safeWorldDir(candidate);
        if (!dir) continue;
        try {
          const entries = await readdir(path.join(vaultRoot, dir));
          if (entries.length >= 0) return dir;
        } catch {
          // Try the next candidate.
        }
      }
    }
  } catch {
    // Fall back below.
  }
  try {
    await readdir(path.join(vaultRoot, DEFAULT_WORLD_DIR));
    return DEFAULT_WORLD_DIR;
  } catch {
    // Try the legacy development root below.
  }
  try {
    await readdir(path.join(vaultRoot, 'GreenHavenWorld'));
    return 'GreenHavenWorld';
  } catch {
    // Try a single visible world folder below.
  }
  try {
    const entries = await readdir(vaultRoot, {withFileTypes: true});
    const worlds = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        await readdir(path.join(vaultRoot, entry.name, 'Locations'));
        worlds.push(entry.name);
      } catch {
        // Not a world folder.
      }
    }
    if (worlds.length === 1) return worlds[0];
  } catch {
    // Fall back below.
  }
  return DEFAULT_WORLD_DIR;
}

async function resolveWorldSelection() {
  if (CARTRIDGE_MODE === 'none') {
    return null;
  }
  if (
    CARTRIDGE_MODE !== 'default' &&
    CARTRIDGE_MODE !== 'custom' &&
    CARTRIDGE_MODE !== 'multi'
  ) {
    throw new Error(
      `unsupported GREENHAVEN_DESKTOP_CARTRIDGE_MODE=${CARTRIDGE_MODE}; expected default, custom, multi, or none`,
    );
  }

  if (CARTRIDGE_MODE === 'default') {
    return {
      vaultRoot: defaultWorldRoot,
      worldDir: await activeWorldDir(defaultWorldRoot),
    };
  }

  const rawPath = CUSTOM_WORLD_PATH.trim();
  if (!rawPath) {
    throw new Error(
      'GREENHAVEN_DESKTOP_CARTRIDGE_MODE=custom requires GREENHAVEN_DESKTOP_WORLD_PATH',
    );
  }
  const resolved = path.resolve(repoRoot, rawPath);
  if (!(await pathExists(resolved))) {
    throw new Error(`custom cartridge path does not exist: ${resolved}`);
  }

  const ownTransformer = transformerScriptFor(resolved);
  if (await fileExists(ownTransformer)) {
    return {
      vaultRoot: resolved,
      worldDir: await activeWorldDir(resolved),
    };
  }

  const parent = path.dirname(resolved);
  const parentTransformer = transformerScriptFor(parent);
  if (await fileExists(parentTransformer)) {
    return {
      vaultRoot: parent,
      worldDir: path.basename(resolved),
    };
  }

  throw new Error(
    `custom cartridge path must be either a vault root with .greenhaven-agent-manual or a world folder inside one: ${resolved}`,
  );
}

async function resolveWorldPath(rawPath) {
  const resolved = path.resolve(repoRoot, String(rawPath || '').trim());
  if (!(await pathExists(resolved))) {
    throw new Error(`cartridge path does not exist: ${resolved}`);
  }

  const ownTransformer = transformerScriptFor(resolved);
  if (await fileExists(ownTransformer)) {
    return {
      vaultRoot: resolved,
      worldDir: await activeWorldDir(resolved),
    };
  }

  const parent = path.dirname(resolved);
  const parentTransformer = transformerScriptFor(parent);
  if (await fileExists(parentTransformer)) {
    return {
      vaultRoot: parent,
      worldDir: path.basename(resolved),
    };
  }

  throw new Error(
    `cartridge path must be either a vault root with .greenhaven-agent-manual or a world folder inside one: ${resolved}`,
  );
}

async function resolveWorldSelections() {
  if (CARTRIDGE_MODE === 'none') return [];
  if (CARTRIDGE_MODE === 'default' || CARTRIDGE_MODE === 'custom') {
    const selected = await resolveWorldSelection();
    if (!selected) return [];
    return [
      {
        ...selected,
        cartridgeId:
          process.env.GREENHAVEN_DESKTOP_CARTRIDGE_ID ||
          slugFromWorldDir(selected.worldDir),
        title: titleFromWorldDir(selected.worldDir),
        isDefault: true,
      },
    ];
  }

  const manifestPath = CUSTOM_WORLDS_MANIFEST.trim();
  if (!manifestPath) {
    throw new Error(
      'GREENHAVEN_DESKTOP_CARTRIDGE_MODE=multi requires GREENHAVEN_DESKTOP_WORLDS_MANIFEST',
    );
  }
  const manifest = JSON.parse(
    (await readFile(path.resolve(repoRoot, manifestPath), 'utf8')).replace(
      /^\uFEFF/,
      '',
    ),
  );
  const rows = Array.isArray(manifest.worlds) ? manifest.worlds : [];
  if (rows.length === 0) {
    throw new Error(`world bundle manifest has no worlds: ${manifestPath}`);
  }
  const defaultKey = String(manifest.default ?? manifest.defaultCartridgeId ?? '');
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const rawPath = typeof row === 'string' ? row : row.path;
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      throw new Error('world bundle entry must provide a non-empty path');
    }
    const selected = await resolveWorldPath(rawPath);
    const id =
      typeof row === 'object' && typeof row.id === 'string' && row.id.trim()
        ? row.id.trim()
        : slugFromWorldDir(selected.worldDir);
    if (seen.has(id)) {
      throw new Error(`duplicate bundled cartridge id: ${id}`);
    }
    seen.add(id);
    const title =
      typeof row === 'object' && typeof row.title === 'string' && row.title.trim()
        ? row.title.trim()
        : titleFromWorldDir(selected.worldDir);
    const isDefault =
      (typeof row === 'object' && row.isDefault === true) ||
      id === defaultKey ||
      selected.worldDir === defaultKey;
    out.push({...selected, cartridgeId: id, title, isDefault});
  }
  if (!out.some((world) => world.isDefault)) {
    out[0].isDefault = true;
  }
  return out;
}

async function fileExists(value) {
  try {
    await readFile(value);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

async function readTargetCartridgeId(forgeProject) {
  const raw = await readFile(path.join(forgeProject, 'forge.project.json'), 'utf8');
  const parsed = JSON.parse(raw);
  return (
    parsed.target_cartridge_id ||
    parsed.cartridge_id ||
    parsed.pack_slug ||
    'greenhaven-world'
  );
}

function safeRelativeAssetPath(value) {
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

async function assertDefaultVisualAssetsPackaged({
  defaultCartridgeSource,
  packagedForgeProject,
  serverTarget,
}) {
  const visualAssetsPath = path.join(
    packagedForgeProject,
    'audit',
    'visual-assets.jsonl',
  );
  const rows = await readJsonl(visualAssetsPath);
  if (rows.length === 0) {
    throw new Error(
      `default cartridge visual asset audit is empty: ${visualAssetsPath}`,
    );
  }

  const cartridgeId = await readTargetCartridgeId(packagedForgeProject);
  const cacheDir = path.join(
    serverTarget,
    'default-cartridge',
    'data-template',
    'cartridges',
    cartridgeId,
    'assets',
  );
  const cachedNames = new Set(await readdir(cacheDir));
  const missing = [];
  for (const row of rows) {
    const relPath = safeRelativeAssetPath(row.path);
    if (!relPath) {
      missing.push(`${row.path ?? '<missing-path>'}: invalid relative path`);
      continue;
    }
    const ext = path.extname(relPath).toLowerCase();
    const sourcePath = path.join(defaultCartridgeSource, relPath);
    let hash;
    try {
      hash = await sha256File(sourcePath);
    } catch (err) {
      missing.push(
        `${relPath}: source missing (${err instanceof Error ? err.message : err})`,
      );
      continue;
    }
    const expected = `${hash}${ext}`;
    if (!cachedNames.has(expected)) {
      missing.push(`${relPath}: cache missing ${expected}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `default cartridge visual assets did not reach precompiled asset cache ${cacheDir}: ` +
        missing.slice(0, 12).join('; ') +
        (missing.length > 12 ? `; ... ${missing.length - 12} more` : ''),
    );
  }
}

function runProc(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: {...process.env, ...(options.env ?? {})},
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed with exit code ${code}`,
          ),
        );
      }
    });
  });
}

async function main() {
  const serverTarget = path.join(packageRoot, 'web-server');
  const uiTarget = path.join(packageRoot, 'web-ui');
  await rm(serverTarget, {recursive: true, force: true});
  await rm(uiTarget, {recursive: true, force: true});

  await copyDir(path.join(webServerRoot, 'dist'), path.join(serverTarget, 'dist'));
  await copyDir(
    path.join(webServerRoot, 'migrations'),
    path.join(serverTarget, 'migrations'),
  );
  // FEAT-ENGINE-BASELINE-3 — packaged desktop runtime bootstraps from the
  // clean engine baseline at `<server>/baseline/0001_engine_baseline.sql`.
  // Without this directory `runMigrations()` cannot find the baseline on a
  // fresh install and the boot-time DB stays empty.
  await copyDir(
    path.join(webServerRoot, 'baseline'),
    path.join(serverTarget, 'baseline'),
  );
  await copyDir(path.join(webServerRoot, 'prompts'), path.join(serverTarget, 'prompts'));
  // brokerEmptyText.ts resolves `<packageRoot>/locales/<lang>/turn-errors.json`
  // at runtime (see brokerEmptyText.ts:53). Without this directory the
  // first turn fails fast with `missing en/turn-errors.json[broker_empty_fail_open]`
  // before the broker can be invoked. Discovered 2026-05-17 during the
  // N-2 Phase 3 live-traffic audit.
  await copyDir(
    path.join(webServerRoot, 'locales'),
    path.join(serverTarget, 'locales'),
  );
  await copyDir(path.join(webUiRoot, 'dist'), path.join(uiTarget, 'dist'));

  // Ship a curated default cartridge source with the desktop build.
  //
  // Intentionally do NOT copy the whole `.greenhaven-agent-manual`
  // directory: it may contain local keys, backups, old references, and
  // bulky scratch output. Runtime only needs the human Obsidian vault,
  // the human manifest, the generated Forge project, and the
  // precompiled data-template created below.
  const defaultCartridgeRoot = path.join(serverTarget, 'default-cartridge');
  await mkdir(defaultCartridgeRoot, {recursive: true});

  const selectedWorlds = await resolveWorldSelections();
  await writeFile(
    path.join(defaultCartridgeRoot, 'build-manifest.json'),
    `${JSON.stringify(
      {
        mode: CARTRIDGE_MODE,
        customWorldPath:
          CARTRIDGE_MODE === 'custom' ? path.resolve(repoRoot, CUSTOM_WORLD_PATH) : null,
        worldsManifest:
          CARTRIDGE_MODE === 'multi'
            ? path.resolve(repoRoot, CUSTOM_WORLDS_MANIFEST)
            : null,
        defaultCartridgeId:
          selectedWorlds.find((world) => world.isDefault)?.cartridgeId ?? null,
        cartridges: selectedWorlds.map((world) => ({
          id: world.cartridgeId,
          title: world.title,
          worldDir: world.worldDir,
          vaultRoot: world.vaultRoot,
          isDefault: world.isDefault,
        })),
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  if (selectedWorlds.length > 0) {
    const defaultCartridgeSource = path.join(
      serverTarget,
      'default-cartridge',
      'source',
    );
    const dataTemplate = path.join(
      serverTarget,
      'default-cartridge',
      'data-template',
    );
    const reports = [];
    for (let i = 0; i < selectedWorlds.length; i++) {
      const world = selectedWorlds[i];
      const {vaultRoot, worldDir, cartridgeId, title} = world;
      await copyDir(
        path.join(vaultRoot, worldDir),
        path.join(defaultCartridgeSource, worldDir),
      );
      if (i === 0 || world.isDefault) {
        await copyFile(
          path.join(vaultRoot, 'WORLD_MANIFEST.md'),
          path.join(defaultCartridgeSource, 'WORLD_MANIFEST.md'),
        );
      } else if (await fileExists(path.join(vaultRoot, 'WORLD_MANIFEST.md'))) {
        await copyFile(
          path.join(vaultRoot, 'WORLD_MANIFEST.md'),
          path.join(defaultCartridgeSource, `WORLD_MANIFEST.${worldDir}.md`),
        );
      }

      const packagedForgeProject = path.join(
        defaultCartridgeSource,
        '.greenhaven-agent-manual',
        'generated',
        'cartridge-forge-projects',
        cartridgeId,
      );
      await mkdir(path.dirname(packagedForgeProject), {recursive: true});
      await runProc(
        'python',
        [
          transformerScriptFor(vaultRoot),
          '--vault-root',
          vaultRoot,
          '--world-dir',
          worldDir,
          '--out-dir',
          packagedForgeProject,
        ],
        {
          env: {
            GREENHAVEN_FORGE_TARGET_CARTRIDGE_ID: cartridgeId,
            GREENHAVEN_FORGE_PROJECT_SLUG: cartridgeId,
            GREENHAVEN_FORGE_PROJECT_TITLE: title,
            GREENHAVEN_FORGE_SOURCE_TITLE: `${title} Obsidian vault`,
          },
        },
      );

      await runProc(
        'npm',
        [
          '--prefix',
          path.join(repoPackages, 'cartridge-forge'),
          'run',
          'forge',
          '--',
          'validate',
          packagedForgeProject,
        ],
      );

      const portableForgeProject =
        `greenhaven://default-cartridge/source/.greenhaven-agent-manual/generated/cartridge-forge-projects/${cartridgeId}`;
      const reportFile = path.join(
        dataTemplate,
        `default-cartridge-precompile-${cartridgeId}.json`,
      );
      await runProc(
        'npm',
        [
          '--prefix',
          webServerRoot,
          'run',
          'cartridge:default:precompile-db',
          '--',
          '--forge-project',
          packagedForgeProject,
          '--source-root',
          defaultCartridgeSource,
          '--world-dir',
          worldDir,
          '--out-data-dir',
          dataTemplate,
          '--report-file',
          reportFile,
          '--portable-source-root',
          'greenhaven://default-cartridge/source',
          '--portable-forge-project',
          portableForgeProject,
          '--accept-warnings',
          ...(i === 0 ? [] : ['--append']),
        ],
      );
      await assertDefaultVisualAssetsPackaged({
        defaultCartridgeSource,
        packagedForgeProject,
        serverTarget,
      });
      reports.push(JSON.parse(await readFile(reportFile, 'utf8')));

      if (world.isDefault) {
        await rm(
          path.join(
            defaultCartridgeSource,
            '.greenhaven-agent-manual',
            'generated',
            'cartridge-forge-project',
          ),
          {recursive: true, force: true},
        );
        await copyDir(
          packagedForgeProject,
          path.join(
            defaultCartridgeSource,
            '.greenhaven-agent-manual',
            'generated',
            'cartridge-forge-project',
          ),
        );
      }
    }

    const defaultReport =
      reports.find((report) => {
        const id = report?.cartridgeId;
        return selectedWorlds.some((world) => world.isDefault && world.cartridgeId === id);
      }) ?? reports[0];
    await writeFile(
      path.join(dataTemplate, 'default-cartridge-precompile-result.json'),
      `${JSON.stringify(
        {
          ...(defaultReport ?? {}),
          defaultCartridgeId:
            selectedWorlds.find((world) => world.isDefault)?.cartridgeId ?? null,
          cartridges: reports.map((report) => ({
            cartridgeId: report.cartridgeId ?? null,
            passed: Boolean(report.passed),
            blockers: report.blockers ?? [],
            counts: report.counts ?? {},
            forgeProject: report.forgeProject ?? null,
            visibleWorldRoot: report.visibleWorldRoot ?? null,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  const sourcePackageJson = JSON.parse(
    await readFile(path.join(webServerRoot, 'package.json'), 'utf8'),
  );
  const runtimePackageJson = {
    name: sourcePackageJson.name,
    version: sourcePackageJson.version,
    private: true,
    type: 'module',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
  };
  await writeFile(
    path.join(serverTarget, 'package.json'),
    `${JSON.stringify(runtimePackageJson, null, 2)}\n`,
  );
}

await main();
