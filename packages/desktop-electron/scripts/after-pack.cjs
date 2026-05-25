/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');

async function healthCheckPgdata(pgdataDir, label) {
  const {PGlite} = await import('@electric-sql/pglite');
  const db = new PGlite(pgdataDir);
  await db.waitReady;
  try {
    const result = await db.query('SELECT COUNT(*)::int AS n FROM entities');
    const count = Number(result.rows[0]?.n ?? 0);
    if (!Number.isFinite(count) || count <= 0) {
      throw new Error(`entities count is not positive: ${count}`);
    }
    return count;
  } finally {
    await db.close();
  }
}

async function copyDirectory(source, target) {
  await fs.rm(target, {recursive: true, force: true});
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.cp(source, target, {recursive: true});
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

module.exports = async function afterPack(context) {
  const sourceDataTemplate = path.join(
    packageRoot,
    'web-server',
    'default-cartridge',
    'data-template',
  );
  const targetDataTemplate = path.join(
    context.appOutDir,
    'resources',
    'web-server',
    'default-cartridge',
    'data-template',
  );
  const sourcePgdata = path.join(sourceDataTemplate, 'pgdata');
  const targetPgdata = path.join(targetDataTemplate, 'pgdata');
  const sourceReport = path.join(
    sourceDataTemplate,
    'default-cartridge-precompile-result.json',
  );

  if (!(await exists(sourceReport)) || !(await exists(sourcePgdata))) {
    console.log(
      '[greenhaven afterPack] default-cartridge data-template absent; packaged build has no bundled world',
    );
    return;
  }

  const sourceCount = await healthCheckPgdata(sourcePgdata, 'source');
  await copyDirectory(sourceDataTemplate, targetDataTemplate);
  const targetCount = await healthCheckPgdata(targetPgdata, 'target');
  if (sourceCount !== targetCount) {
    throw new Error(
      `default data-template count drift: source=${sourceCount} target=${targetCount}`,
    );
  }
  console.log(
    `[greenhaven afterPack] default-cartridge data-template copied and verified (${targetCount} entities)`,
  );
};
