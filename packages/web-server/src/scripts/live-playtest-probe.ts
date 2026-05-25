export {};

import fs from 'node:fs/promises';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => console.error(...args);

try {
  const args = await parseArgs(process.argv.slice(2));
  await fs.mkdir(args.outDir, {recursive: true});

  const before = await liveState(args);
  await writeJson(args.outDir, '01-before.json', before);

  let presetResult: unknown = null;
  if (args.preset) {
    presetResult = await postJson(`${args.server}/api/debug/live-preset`, {
      playerId: args.playerId,
      sessionId: args.sessionId,
      preset: args.preset,
      limit: args.limit,
      options: {
        includeQueuedTurn: false,
        ...args.options,
      },
    });
    await writeJson(args.outDir, '02-preset.json', presetResult);
  }

  const afterPreset = await liveState(args);
  await writeJson(args.outDir, '03-after-preset.json', afterPreset);

  const session = await postJson(`${args.server}/api/session`, {
    playerId: args.playerId,
    sessionId: args.sessionId,
  });
  await writeJson(args.outDir, '04-session.json', session);

  const turn = await postJson(
    `${args.server}/api/session/${encodeURIComponent(args.sessionId)}/turn`,
    {
      playerId: args.playerId,
      text: args.text,
      language: args.language,
      clientRequestId: `live-probe:${Date.now()}`,
    },
  );
  await writeJson(args.outDir, '05-turn-submit.json', turn);

  const turnId = typeof turn['turnId'] === 'string' ? turn['turnId'] : undefined;
  const settled = await waitForTurn(args, turnId);
  await writeJson(args.outDir, '06-turn-settled.json', settled);

  const after = await liveState(args);
  await writeJson(args.outDir, '07-after-turn.json', after);
  await writeJson(args.outDir, '08-transcript-summary.json', {
    playerId: args.playerId,
    sessionId: args.sessionId,
    preset: args.preset,
    text: args.text,
    turn,
    transcript: transcriptSummary(after),
    queue: queueSummary(after),
    activeQuests: questSummary(after),
    toolInvocations: toolSummary(after),
  });

  await fs.writeFile(
    path.join(args.outDir, 'BUG_LEDGER.md'),
    bugLedgerTemplate(args, turnId),
    'utf8',
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outDir: args.outDir,
        playerId: args.playerId,
        sessionId: args.sessionId,
        preset: args.preset,
        turnId,
        turn,
      },
      null,
      2,
    )}\n`,
  );
} catch (err) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
} finally {
  console.log = originalLog;
}

async function parseArgs(argv: string[]): Promise<{
  server: string;
  playerId: number;
  sessionId: string;
  preset?: string;
  text: string;
  language: string;
  limit: number;
  timeoutMs: number;
  pollMs: number;
  outDir: string;
  options: JsonRecord;
}> {
  const server = stringArg(argv, 'server') ?? 'http://127.0.0.1:7777';
  const playerId = positiveIntArg(argv, 'player-id') ?? positiveIntArg(argv, 'playerId');
  if (!playerId) throw new Error('--player-id is required');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const preset = stringArg(argv, 'preset');
  const sessionId =
    stringArg(argv, 'session-id') ??
    stringArg(argv, 'sessionId') ??
    `debug-live-probe-${stamp}`;
  const text =
    (await textInput(argv)) ??
    defaultTextForPreset(preset) ??
    'Я делаю то, чего от меня не ждут. Мир должен отреагировать состоянием, а не красивой отпиской.';
  const options = parseOptions(argv);
  const outDir = path.resolve(
    stringArg(argv, 'out') ??
      `.codex/run-logs/live-playtest/${stamp}-${preset ?? 'probe'}`,
  );
  return {
    server: server.replace(/\/$/, ''),
    playerId,
    sessionId,
    preset,
    text,
    language: stringArg(argv, 'language') ?? 'ru',
    limit: positiveIntArg(argv, 'limit') ?? 120,
    timeoutMs: positiveIntArg(argv, 'timeout-ms') ?? 180_000,
    pollMs: positiveIntArg(argv, 'poll-ms') ?? 2_000,
    outDir,
    options,
  };
}

async function textInput(argv: string[]): Promise<string | undefined> {
  const text = stringArg(argv, 'text');
  if (text) return text;
  const file = stringArg(argv, 'text-file');
  if (!file) return undefined;
  return (await fs.readFile(path.resolve(file), 'utf8')).trim();
}

function parseOptions(argv: string[]): JsonRecord {
  const raw = stringArg(argv, 'options-json');
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('--options-json must be an object');
  return parsed;
}

function stringArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const next = argv[idx + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

function positiveIntArg(argv: string[], name: string): number | undefined {
  const raw = stringArg(argv, name);
  const n = raw == null ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function defaultTextForPreset(preset: string | undefined): string | undefined {
  switch (preset) {
    case 'silent_follow_private_scene':
      return 'Я молча прохожу за занавеску, не отвечая Микке. Она сама сказала идти сюда. Что происходит дальше?';
    case 'quest_chain_wrong_order':
      return 'Я возвращаюсь за наградой, хотя улику не находил и никому ничего не передавал. Плати.';
    case 'quest_item_wrong_handoff':
      return 'Я отдал конверт не тому человеку, но хочу убедить Микку, что поручение выполнено.';
    case 'multi_quest_same_giver_conflict':
      return 'Я сделал оба твоих поручения сразу, хотя одно требовало идти в трактир, а другое избегать трактира.';
    default:
      return undefined;
  }
}

async function liveState(args: {
  server: string;
  playerId: number;
  sessionId: string;
  limit: number;
}): Promise<JsonRecord> {
  const url = new URL(`${args.server}/api/debug/live-state`);
  url.searchParams.set('playerId', String(args.playerId));
  url.searchParams.set('sessionId', args.sessionId);
  url.searchParams.set('limit', String(args.limit));
  return getJson(url.toString());
}

async function waitForTurn(
  args: {
    server: string;
    playerId: number;
    sessionId: string;
    limit: number;
    timeoutMs: number;
    pollMs: number;
  },
  turnId: string | undefined,
): Promise<JsonRecord> {
  const startedAt = Date.now();
  let last: JsonRecord = {};
  while (Date.now() - startedAt < args.timeoutMs) {
    last = await liveState(args);
    const live = isRecord(last['live']) ? last['live'] : {};
    const inMemory = Array.isArray(live['in_memory_sessions'])
      ? live['in_memory_sessions']
      : [];
    const active = inMemory.some(row => {
      if (!isRecord(row)) return false;
      const activeTurn = row['activeTurn'];
      if (!isRecord(activeTurn)) return false;
      return !turnId || activeTurn['turnId'] === turnId;
    });
    const queue = Array.isArray(live['turn_ingress_queue'])
      ? live['turn_ingress_queue']
      : [];
    const queueRow = queue
      .filter(isRecord)
      .find(row => !turnId || row['turn_id'] === turnId);
    const status =
      queueRow && typeof queueRow['status'] === 'string'
        ? queueRow['status']
        : undefined;
    if (!active && ['done', 'failed', 'cancelled'].includes(status ?? '')) {
      return {
        ok: status === 'done',
        status,
        elapsedMs: Date.now() - startedAt,
        turnId,
      };
    }
    await sleep(args.pollMs);
  }
  return {
    ok: false,
    status: 'timeout',
    elapsedMs: Date.now() - startedAt,
    turnId,
    lastQueue: queueSummary(last),
  };
}

async function getJson(url: string): Promise<JsonRecord> {
  const response = await fetch(url);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${response.status} ${url}: ${JSON.stringify(parsed)}`);
  }
  if (!isRecord(parsed)) throw new Error(`unexpected JSON response from ${url}`);
  return parsed;
}

async function postJson(url: string, body: JsonRecord): Promise<JsonRecord> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${response.status} ${url}: ${JSON.stringify(parsed)}`);
  }
  if (!isRecord(parsed)) throw new Error(`unexpected JSON response from ${url}`);
  return parsed;
}

function transcriptSummary(state: JsonRecord): unknown[] {
  const rows = baseRows(state, 'chat_messages');
  return rows.map(row => ({
    id: row['id'],
    tone: row['tone'],
    author: row['author_name'],
    turn_index: row['turn_index'],
    text:
      typeof row['text'] === 'string'
        ? row['text'].slice(0, 1000)
        : row['text'],
  }));
}

function queueSummary(state: JsonRecord): unknown[] {
  const live = isRecord(state['live']) ? state['live'] : {};
  const rows = Array.isArray(live['turn_ingress_queue'])
    ? live['turn_ingress_queue']
    : [];
  return rows.filter(isRecord).map(row => ({
    id: row['id'],
    turn_id: row['turn_id'],
    status: row['status'],
    text:
      typeof row['text'] === 'string'
        ? row['text'].slice(0, 300)
        : row['text'],
    error: row['error'],
  }));
}

function questSummary(state: JsonRecord): unknown[] {
  return baseRows(state, 'player_quests').map(row => ({
    quest_entity_id: row['quest_entity_id'],
    title: row['quest_title'],
    status: row['status'],
    current_stage_id: row['current_stage_id'],
    metadata: row['metadata'],
  }));
}

function toolSummary(state: JsonRecord): unknown[] {
  return baseRows(state, 'tool_invocations').map(row => ({
    id: row['id'],
    turn_id: row['turn_id'],
    tool_name: row['tool_name'],
    error: row['error'],
  }));
}

function baseRows(state: JsonRecord, key: string): JsonRecord[] {
  const base = isRecord(state['baseSnapshot']) ? state['baseSnapshot'] : {};
  const data = isRecord(base['data']) ? base['data'] : {};
  const rows = Array.isArray(data[key]) ? data[key] : [];
  return rows.filter(isRecord);
}

function bugLedgerTemplate(
  args: {playerId: number; sessionId: string; preset?: string; text: string},
  turnId: string | undefined,
): string {
  return `# Live Probe Bug Ledger

- Player/session: ${args.playerId} / ${args.sessionId}
- Preset: ${args.preset ?? 'none'}
- Turn id: ${turnId ?? 'unknown'}
- Player text: ${args.text}

## Finding

- Severity:
- Repro:
- Expected durable state:
- Actual response/state:
- Evidence:
- Suspected owner:
- Fix path:
`;
}

async function writeJson(
  outDir: string,
  filename: string,
  data: unknown,
): Promise<void> {
  await fs.writeFile(
    path.join(outDir, filename),
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8',
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
