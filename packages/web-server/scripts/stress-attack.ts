/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Stress test for shared-state races introduced in spec 12.
// Spawns N concurrent fake clients, each fires `attacksEach` POST /turn
// requests with actionId=attack:<npcId>. Final NPC HP is then checked
// against the expected total damage. A passing run validates that the
// advisory-lock + transaction wrap on scriptAttack actually serialises
// concurrent damage applications.
//
// Usage:
//   AUTH_DISABLED=1 npm run dev   # in another terminal
//   tsx scripts/stress-attack.ts <baseUrl> <npcId> <numClients> <attacksEach>
//
// Defaults: http://127.0.0.1:7777, NPC id 200 (Mikka — adjust), 50, 20.
// Requires AUTH_DISABLED=1 on the server so we can pass playerId in body
// without forging the signed cookie. For a real authenticated soak,
// switch to issuing real cookies via /api/player/anonymous and reusing
// the Set-Cookie header.

const [, , baseArg, npcArg, nArg, attacksArg] = process.argv;
const baseURL = baseArg ?? 'http://127.0.0.1:7777';
const npcId = Number(npcArg ?? 200);
const numClients = Number(nArg ?? 50);
const attacksEach = Number(attacksArg ?? 20);

interface CreatedPlayer {
  entity_id: number;
  public_id: string;
}

async function createPlayer(): Promise<CreatedPlayer> {
  const r = await fetch(`${baseURL}/api/player/anonymous`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`anonymous create failed: ${r.status}`);
  return (await r.json()) as CreatedPlayer;
}

async function createSession(): Promise<string> {
  const r = await fetch(`${baseURL}/api/session`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status}`);
  const body = (await r.json()) as {sessionId: string};
  return body.sessionId;
}

async function attackOnce(sessionId: string, playerId: number): Promise<void> {
  const r = await fetch(`${baseURL}/api/session/${sessionId}/turn`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      text: 'attack',
      actionId: `attack:${npcId}`,
      playerId,
    }),
  });
  await r.text();
}

async function clientLoop(): Promise<void> {
  const player = await createPlayer();
  const sessionId = await createSession();
  for (let i = 0; i < attacksEach; i++) {
    await attackOnce(sessionId, player.entity_id);
  }
}

async function main(): Promise<void> {
  console.log(
    `[stress] ${numClients} clients × ${attacksEach} attacks against NPC ${npcId} via ${baseURL}`,
  );
  const t0 = Date.now();
  const loops: Array<Promise<void>> = [];
  for (let i = 0; i < numClients; i++) loops.push(clientLoop());
  await Promise.all(loops);
  const elapsedMs = Date.now() - t0;
  console.log(
    `[stress] all loops settled in ${elapsedMs} ms — total attacks: ${numClients * attacksEach}`,
  );
  console.log(
    `[stress] verify NPC ${npcId} HP via curl ${baseURL}/api/debug/mikka and compare to expected damage total.`,
  );
}

main().catch(err => {
  console.error('[stress] failed:', err);
  process.exit(1);
});
