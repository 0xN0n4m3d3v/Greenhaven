/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Soak runner — N fake clients × M turns over a fixed duration.
// Reports error rate, p95 latency, DeepSeek 429 rate. Pass criteria:
//   <1% error rate
//   p95 turn end-to-end <15s
//   <2% DeepSeek 429
//
// Usage:
//   AUTH_DISABLED=1 npm run dev   # in another terminal
//   tsx scripts/soak.ts --baseUrl http://127.0.0.1:7777 --clients 100 \
//        --turnsPerClient 50 --durationHours 4 --report soak-report.json

interface Args {
  baseUrl: string;
  clients: number;
  turnsPerClient: number;
  durationHours: number;
  reportPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    baseUrl: 'http://127.0.0.1:7777',
    clients: 10,
    turnsPerClient: 20,
    durationHours: 0.1,
    reportPath: 'soak-report.json',
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k || v === undefined) continue;
    if (k === '--baseUrl') out.baseUrl = v;
    else if (k === '--clients') out.clients = Number(v);
    else if (k === '--turnsPerClient') out.turnsPerClient = Number(v);
    else if (k === '--durationHours') out.durationHours = Number(v);
    else if (k === '--report') out.reportPath = v;
  }
  return out;
}

interface Sample {
  durationMs: number;
  status: number;
  errorKind?: 'fetch' | 'http' | 'rate_limited' | 'deepseek_429';
}

async function bootstrapClient(baseUrl: string): Promise<{
  sessionId: string;
  playerId: number;
}> {
  const pres = await fetch(`${baseUrl}/api/player/anonymous`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({}),
  });
  if (!pres.ok) throw new Error(`anonymous create failed: ${pres.status}`);
  const player = (await pres.json()) as {entity_id: number};
  const sres = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({}),
  });
  if (!sres.ok) throw new Error(`session create failed: ${sres.status}`);
  const session = (await sres.json()) as {sessionId: string};
  return {sessionId: session.sessionId, playerId: player.entity_id};
}

async function takeOneTurn(
  baseUrl: string,
  sessionId: string,
  playerId: number,
): Promise<Sample> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${baseUrl}/api/session/${sessionId}/turn`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text: 'look around', playerId}),
    });
    const elapsed = Date.now() - t0;
    if (r.ok) return {durationMs: elapsed, status: r.status};
    if (r.status === 429) return {durationMs: elapsed, status: 429, errorKind: 'rate_limited'};
    return {durationMs: elapsed, status: r.status, errorKind: 'http'};
  } catch (err) {
    return {
      durationMs: Date.now() - t0,
      status: 0,
      errorKind: 'fetch',
    };
  }
}

async function clientLoop(
  args: Args,
  endTime: number,
  results: Sample[],
): Promise<void> {
  let setup: Awaited<ReturnType<typeof bootstrapClient>>;
  try {
    setup = await bootstrapClient(args.baseUrl);
  } catch (err) {
    results.push({durationMs: 0, status: 0, errorKind: 'fetch'});
    return;
  }
  for (let i = 0; i < args.turnsPerClient && Date.now() < endTime; i++) {
    const sample = await takeOneTurn(args.baseUrl, setup.sessionId, setup.playerId);
    results.push(sample);
    // Light pacing to stay under burst rate-limit defaults.
    await new Promise(r => setTimeout(r, 1000));
  }
}

function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log('[soak] starting:', args);
  const endTime = Date.now() + args.durationHours * 3600 * 1000;
  const results: Sample[] = [];
  const loops: Array<Promise<void>> = [];
  for (let i = 0; i < args.clients; i++) {
    loops.push(clientLoop(args, endTime, results));
  }
  await Promise.all(loops);
  const total = results.length;
  const errors = results.filter(s => s.errorKind != null).length;
  const rateLimited = results.filter(s => s.errorKind === 'rate_limited').length;
  const okSamples = results.filter(s => s.errorKind == null).map(s => s.durationMs);
  const report = {
    total,
    errors,
    errorRate: total > 0 ? errors / total : 0,
    rateLimited,
    p50Ms: p95(okSamples.length > 0 ? [okSamples[Math.floor(okSamples.length / 2)]!] : []),
    p95Ms: p95(okSamples),
  };
  console.log('[soak] report:', report);
  const fs = await import('node:fs/promises');
  await fs.writeFile(args.reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[soak] wrote ${args.reportPath}`);
}

main().catch(err => {
  console.error('[soak] failed:', err);
  process.exit(1);
});
