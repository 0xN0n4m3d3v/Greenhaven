/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-9 regression tests — the gameplay log writer must serialise
// concurrent appends (no torn JSON lines, no interleaving inside a
// target file) and rotate files by size before re-opening.

// config() requires AUTH_SECRET. The unit tests don't load .env;
// set it here before any test calls into sanitizeValue() which
// resolves the gameplay-log-max-string config value.
process.env.AUTH_SECRET ??=
  'gameplay-log-test-auth-secret-32-bytes-minimum';

import {mkdtemp, readdir, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  GameplayLogWriter,
  appendGameplayLogWith,
  gameplayLogInternals,
} from '../../gameplayLog.js';
import {createTelemetry} from '../../telemetry/Telemetry.js';

let workDir = '';

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'greenhaven-gameplay-log-'));
});

afterEach(async () => {
  if (workDir) {
    await rm(workDir, {recursive: true, force: true});
    workDir = '';
  }
});

async function readJsonLines(file: string): Promise<unknown[]> {
  const contents = await readFile(file, 'utf8');
  if (!contents) return [];
  const lines = contents.split('\n').filter(line => line.length > 0);
  return lines.map(line => JSON.parse(line));
}

describe('GameplayLogWriter — DEEP-9 concurrency', () => {
  it('serialises 1000 concurrent appends without torn or interleaved JSON', async () => {
    const writer = new GameplayLogWriter();
    try {
      const bigStack = 'x'.repeat(8 * 1024);
      const appends: Promise<void>[] = [];
      const count = 1000;
      for (let i = 0; i < count; i++) {
        appends.push(
          appendGameplayLogWith(
            writer,
            {
              type: 'concurrent.test',
              sessionId: 'session-1',
              playerId: 42,
              turnId: `turn-${i}`,
              data: {index: i, stack: bigStack},
            },
            workDir,
          ),
        );
      }
      await Promise.all(appends);
      await writer.flush();
    } finally {
      await writer.close();
    }

    const allRows = await readJsonLines(path.join(workDir, 'all.jsonl'));
    expect(allRows).toHaveLength(1000);
    const indexes = new Set(
      allRows.map(row => (row as {data: {index: number}}).data.index),
    );
    expect(indexes.size).toBe(1000);

    const sessionRows = await readJsonLines(
      path.join(workDir, 'session-session-1.jsonl'),
    );
    const playerRows = await readJsonLines(
      path.join(workDir, 'player-42.jsonl'),
    );
    expect(sessionRows).toHaveLength(1000);
    expect(playerRows).toHaveLength(1000);
  });

  it('rotates files once the size threshold is exceeded', async () => {
    let frozenNow = 1_700_000_000_000;
    const writer = new GameplayLogWriter({
      rotationSizeBytes: 400,
      rotationMaxAgeMs: 60 * 60 * 1000,
      now: () => frozenNow,
    });
    try {
      for (let i = 0; i < 25; i++) {
        await appendGameplayLogWith(
          writer,
          {
            type: 'rotate.test',
            sessionId: 'rotate-session',
            playerId: 7,
            data: {index: i, padding: 'p'.repeat(80)},
          },
          workDir,
        );
        frozenNow += 1;
      }
      await writer.flush();
    } finally {
      await writer.close();
    }

    const files = (await readdir(workDir)).sort();
    const rotated = files.filter(f => /^all\.jsonl\./.test(f));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    const liveSize = (await stat(path.join(workDir, 'all.jsonl'))).size;
    expect(liveSize).toBeLessThanOrEqual(800);
    const totalAppends = 25;
    const totalLines = (
      await Promise.all(
        ['all.jsonl', ...rotated].map(name =>
          readJsonLines(path.join(workDir, name)),
        ),
      )
    ).reduce((acc, rows) => acc + rows.length, 0);
    expect(totalLines).toBe(totalAppends);
  });

  it('rotates when the per-file age exceeds the configured max', async () => {
    let frozenNow = 2_000_000_000_000;
    const writer = new GameplayLogWriter({
      rotationSizeBytes: 5_000_000,
      rotationMaxAgeMs: 500,
      now: () => frozenNow,
    });
    try {
      await appendGameplayLogWith(
        writer,
        {type: 'age.first', sessionId: 'age-session'},
        workDir,
      );
      frozenNow += 1_000;
      await appendGameplayLogWith(
        writer,
        {type: 'age.second', sessionId: 'age-session'},
        workDir,
      );
      await writer.flush();
    } finally {
      await writer.close();
    }

    const files = (await readdir(workDir)).sort();
    const rotated = files.filter(f => /^all\.jsonl\./.test(f));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    const liveRows = await readJsonLines(path.join(workDir, 'all.jsonl'));
    expect(liveRows).toHaveLength(1);
    expect((liveRows[0] as {type: string}).type).toBe('age.second');
  });

  it('resumes against an existing file by stat-ing its size', async () => {
    const writer = new GameplayLogWriter({rotationSizeBytes: 200});
    try {
      await appendGameplayLogWith(
        writer,
        {type: 'resume.warmup', sessionId: 'resume'},
        workDir,
      );
      await writer.flush();
    } finally {
      await writer.close();
    }

    const warmSize = (await stat(path.join(workDir, 'all.jsonl'))).size;
    expect(warmSize).toBeGreaterThan(0);

    const second = new GameplayLogWriter({rotationSizeBytes: warmSize + 1});
    try {
      await appendGameplayLogWith(
        second,
        {type: 'resume.tail', sessionId: 'resume'},
        workDir,
      );
      await second.flush();
    } finally {
      await second.close();
    }

    const files = (await readdir(workDir)).sort();
    const rotated = files.filter(f => /^all\.jsonl\./.test(f));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps existing envelope shape, sensitive-key redaction, and truncation', async () => {
    const writer = new GameplayLogWriter();
    try {
      await appendGameplayLogWith(
        writer,
        {
          type: 'envelope.test',
          sessionId: 'envelope-session',
          playerId: 9,
          turnId: 'turn-1',
          data: {
            password: 'do-not-log',
            token: 'do-not-log',
            api_key: 'do-not-log',
            visible: 'ok',
          },
          error: new Error('boom'),
        },
        workDir,
      );
      await writer.flush();
    } finally {
      await writer.close();
    }

    const rows = await readJsonLines(path.join(workDir, 'all.jsonl'));
    expect(rows).toHaveLength(1);
    const row = rows[0] as {
      ts: string;
      type: string;
      traceId: string | null;
      data: Record<string, unknown>;
      error: {name: string; message: string};
    };
    expect(row.type).toBe('envelope.test');
    expect(row.traceId).toBe('turn-1');
    expect(row.data.password).toBe('[redacted]');
    expect(row.data.token).toBe('[redacted]');
    expect(row.data.api_key).toBe('[redacted]');
    expect(row.data.visible).toBe('ok');
    expect(row.error.message).toBe('boom');
  });
});

describe('telemetry facade integration', () => {
  it('telemetry.flush waits for gameplay sink writes against the real writer', async () => {
    const writer = new GameplayLogWriter();
    try {
      const t = createTelemetry({
        gameplay: async event => {
          await appendGameplayLogWith(
            writer,
            {
              type: event.name,
              sessionId: event.sessionId ?? null,
              playerId: event.playerId ?? null,
              turnId: event.turnId ?? null,
              traceId: event.traceId ?? null,
              data: event.data,
              error: event.error,
            },
            workDir,
          );
        },
        performance: async () => undefined,
        turn: async () => undefined,
        frontend: async () => undefined,
        desktop: async () => undefined,
      });
      t.record({
        channel: 'gameplay',
        name: 'integration.test',
        sessionId: 'tele-session',
        playerId: 11,
        turnId: 'turn-1',
        data: {note: 'hello'},
      });
      expect(t.pendingCount()).toBe(1);
      await t.flush();
      expect(t.pendingCount()).toBe(0);
    } finally {
      await writer.close();
    }

    const rows = await readJsonLines(path.join(workDir, 'all.jsonl'));
    expect(rows).toHaveLength(1);
    expect((rows[0] as {type: string}).type).toBe('integration.test');
  });
});

describe('gameplayLogInternals', () => {
  it('exposes envelope+target helpers used by tooling', () => {
    const envelope = gameplayLogInternals.normalizeEvent({
      type: 'targets.test',
      sessionId: 'sess',
      playerId: 5,
    });
    const files = gameplayLogInternals.targetFilesFor(envelope, '/tmp/log');
    expect(files.some(f => f.endsWith('all.jsonl'))).toBe(true);
    expect(files.some(f => f.includes('session-sess.jsonl'))).toBe(true);
    expect(files.some(f => f.includes('player-5.jsonl'))).toBe(true);
  });
});
