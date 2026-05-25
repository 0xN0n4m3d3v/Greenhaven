/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// DEEP-9 — single-writer JSONL gameplay log.
//
// The previous implementation called `appendFile(...)` in parallel
// for every target file (all.jsonl, daily, session, player). With
// gameplay events firing concurrently from the turn loop, broker
// tool calls, and the post-turn pipeline, the parallel writes could
// interleave inside a single file (broken JSON lines on read-back)
// and there was no rotation, so a long-running session would grow
// the files without bound.
//
// `GameplayLogWriter` serialises every append through a single
// promise chain, holds one open `WriteStream` per target file with
// `flags: 'a'`, and rotates by size or age before re-opening. The
// default singleton uses 50 MB / 24 h thresholds; tests can
// instantiate the class with custom thresholds and an injectable
// clock against a temp directory.

import {createWriteStream, type WriteStream} from 'node:fs';
import {mkdir, rename, stat} from 'node:fs/promises';
import path from 'node:path';
import {config} from './config.js';

export interface GameplayLogEvent {
  type: string;
  sessionId?: string | null;
  playerId?: number | null;
  turnId?: string | null;
  traceId?: string | null;
  data?: Record<string, unknown>;
  error?: unknown;
}

const DEFAULT_ROTATION_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_ROTATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DEPTH = 8;
let processLoggersInstalled = false;

interface StreamEntry {
  stream: WriteStream;
  openedAt: number;
  bytesWritten: number;
}

export interface GameplayLogWriterOptions {
  rotationSizeBytes?: number;
  rotationMaxAgeMs?: number;
  now?: () => number;
}

export class GameplayLogWriter {
  private readonly streams = new Map<string, StreamEntry>();
  private queue: Promise<void> = Promise.resolve();
  private readonly rotationSizeBytes: number;
  private readonly rotationMaxAgeMs: number;
  private readonly now: () => number;

  constructor(options: GameplayLogWriterOptions = {}) {
    this.rotationSizeBytes =
      options.rotationSizeBytes ?? DEFAULT_ROTATION_SIZE_BYTES;
    this.rotationMaxAgeMs =
      options.rotationMaxAgeMs ?? DEFAULT_ROTATION_MAX_AGE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async append(line: string, files: readonly string[]): Promise<void> {
    const tail = this.queue.then(() => this.writeAll(line, files));
    // Keep the chain alive even if a write rejects so subsequent
    // appends still execute.
    this.queue = tail.catch(() => undefined);
    try {
      await tail;
    } catch (err) {
      // CATCH-WARN-OK: gameplay-log itself is the bottom of the logging stack; telemetry.record() would write its own gameplay-log line and recurse on the same failure.
      console.warn(
        '[gameplay-log] append failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.flush();
    const entries = [...this.streams.values()];
    this.streams.clear();
    for (const entry of entries) {
      await endStream(entry.stream);
    }
  }

  private async writeAll(
    line: string,
    files: readonly string[],
  ): Promise<void> {
    for (const file of files) {
      try {
        await this.write(file, line);
      } catch (err) {
        // CATCH-WARN-OK: gameplay-log itself is the bottom of the logging stack; telemetry.record() would recurse through gameplayLog on the same failure.
        console.warn(
          `[gameplay-log] write to ${file} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private async write(file: string, line: string): Promise<void> {
    const buf = Buffer.from(line, 'utf8');
    let entry = await this.ensureStream(file);
    if (
      entry.bytesWritten + buf.byteLength > this.rotationSizeBytes ||
      this.now() - entry.openedAt > this.rotationMaxAgeMs
    ) {
      await this.rotate(file, entry);
      entry = await this.ensureStream(file);
    }
    await writeChunk(entry.stream, buf);
    entry.bytesWritten += buf.byteLength;
  }

  private async ensureStream(file: string): Promise<StreamEntry> {
    const existing = this.streams.get(file);
    if (existing) return existing;
    await mkdir(path.dirname(file), {recursive: true});
    let priorSize = 0;
    try {
      const st = await stat(file);
      priorSize = Number(st.size ?? 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const stream = createWriteStream(file, {flags: 'a'});
    const entry: StreamEntry = {
      stream,
      openedAt: this.now(),
      bytesWritten: priorSize,
    };
    this.streams.set(file, entry);
    return entry;
  }

  private async rotate(file: string, entry: StreamEntry): Promise<void> {
    this.streams.delete(file);
    await endStream(entry.stream);
    const tsMs = this.now();
    const dateSlug = new Date(tsMs).toISOString().slice(0, 10);
    const rotated = `${file}.${dateSlug}.${tsMs}`;
    try {
      await rename(file, rotated);
    } catch (err) {
      // CATCH-WARN-OK: gameplay-log itself is the bottom of the logging stack; telemetry.record() during rotation would re-enter the same writer.
      console.warn(
        '[gameplay-log] rotate rename failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

function writeChunk(stream: WriteStream, buf: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(buf, err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise<void>(resolve => {
    stream.end(() => resolve());
  });
}

const defaultWriter = new GameplayLogWriter();

export function installGameplayProcessLoggers(): void {
  if (processLoggersInstalled) return;
  processLoggersInstalled = true;
  process.on('uncaughtException', err => {
    // VOID-FF-OK: process-level error sink; appendGameplayLog already swallows its own write rejections via its internal queue.catch chain.
    void appendGameplayLog({
      type: 'process.uncaught_exception',
      error: err,
    });
  });
  process.on('unhandledRejection', reason => {
    // VOID-FF-OK: process-level error sink; appendGameplayLog already swallows its own write rejections via its internal queue.catch chain.
    void appendGameplayLog({
      type: 'process.unhandled_rejection',
      error: reason,
    });
  });
}

export async function appendGameplayLog(
  event: GameplayLogEvent,
): Promise<void> {
  await appendGameplayLogWith(defaultWriter, event, gameplayLogDir());
}

export async function appendGameplayLogWith(
  writer: GameplayLogWriter,
  event: GameplayLogEvent,
  logDir: string,
): Promise<void> {
  const envelope = normalizeEvent(event);
  const line = `${JSON.stringify(envelope)}\n`;
  const files = targetFilesFor(envelope, logDir);
  await writer.append(line, files);
}

export function gameplayLogDir(): string {
  return (
    config().gameplayLogDir ?? path.resolve(process.cwd(), 'logs', 'gameplay')
  );
}

export interface GameplayLogEnvelope {
  ts: string;
  type: string;
  sessionId: string | null;
  playerId: number | null;
  turnId: string | null;
  traceId: string | null;
  data: Record<string, unknown>;
  error: unknown;
}

function targetFilesFor(
  envelope: GameplayLogEnvelope,
  logDir: string,
): string[] {
  const files = [
    path.join(logDir, 'all.jsonl'),
    path.join(logDir, `${dateKey(envelope.ts)}.jsonl`),
  ];
  if (envelope.sessionId) {
    files.push(
      path.join(logDir, `session-${safeFilePart(envelope.sessionId)}.jsonl`),
    );
  }
  if (
    typeof envelope.playerId === 'number' &&
    Number.isFinite(envelope.playerId)
  ) {
    files.push(path.join(logDir, `player-${envelope.playerId}.jsonl`));
  }
  return files;
}

function normalizeEvent(event: GameplayLogEvent): GameplayLogEnvelope {
  return {
    ts: new Date().toISOString(),
    type: event.type,
    sessionId: event.sessionId ?? null,
    playerId:
      typeof event.playerId === 'number' && Number.isFinite(event.playerId)
        ? event.playerId
        : null,
    turnId: event.turnId ?? null,
    traceId: event.traceId ?? event.turnId ?? event.sessionId ?? null,
    data: sanitizeValue(event.data ?? {}, 0) as Record<string, unknown>,
    error: sanitizeError(event.error),
  };
}

function sanitizeError(error: unknown): unknown {
  if (error == null) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return sanitizeValue(error, 0);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    const maxStringLength = config().gameplayLogMaxString;
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}...[truncated ${value.length - maxStringLength} chars]`
      : value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (value instanceof Error) return sanitizeError(value);
  if (depth >= MAX_DEPTH) return '[max_depth]';
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = sanitizeValue(item, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function isSensitiveKey(key: string): boolean {
  // LANGUAGE-REGEX-OK: header/credential token allowlist matches HTTP / OAuth / API protocol names (RFC 7235 et al.), not natural-language words; the redaction must catch the exact protocol identifiers regardless of player language.
  return /cookie|authorization|password|token|secret|api[_-]?key|session[_-]?key/i.test(
    key,
  );
}

function dateKey(iso: string): string {
  return iso.slice(0, 10);
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120);
}

export const gameplayLogInternals = {
  normalizeEvent,
  targetFilesFor,
  defaultWriter,
};
