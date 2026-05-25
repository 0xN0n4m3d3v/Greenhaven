# Live verification harness (spec 50)

Single endpoint that fires every specialist with a curated input, validates each output, and returns a per-specialist pass/fail/skipped summary. Plus a CLI wrapper for CI.

## /api/debug/verify-specialists

Defined at [packages/web-server/src/index.ts:1202](../../packages/web-server/src/index.ts#L1202). `POST /api/debug/verify-specialists` — accepts `{playerId?: number}`, defaults `1000`.

Access: this endpoint is under the shared `/api/debug/*` guard. In production set `GREENHAVEN_DEBUG_ROUTES=1`; if `GREENHAVEN_DEBUG_KEY` is set, include `x-debug-key`.

What it does:
1. Builds a list of tests, one per spec (39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 53, 54, 51).
2. Each test posts a curated synthetic body to the matching `/api/debug/run-<name>` endpoint via Hono's internal `app.fetch` (no network round-trip).
3. Tests run in parallel via `Promise.allSettled` — one failure can't poison the rest.
4. Each test's `check(parsed)` validator returns `{status: 'pass'|'fail'|'skipped', notes: string}`.
5. Response: `{ok, summary: {pass, skipped, fail, total}, results: Verdict[]}` sorted by spec number.

`status: 'skipped'` is acceptable — a specialist legitimately didn't fire (e.g., Dialogue Anchor with no active partner).

A representative test (Combat Director):
```ts
{
  spec: 40,
  name: 'combat_director',
  endpoint: '/api/debug/run-combat-director',
  body: {
    playerProse: 'I swing my longsword at @Mikka with full force, aiming for her ribs.',
    targetName: 'Mikka Quickgrin',
    playerId,
  },
  check: (p) => {
    const o = p as Record<string, unknown>;
    return /* check brief shape */ ? {status: 'pass', notes: '...'} : {status: 'fail', ...};
  },
}
```

The harness exists because each specialist has its own debug runner endpoint, but no single command tells you "is the whole specialist tier actually working today?". CI integration: ./scripts/verify-specialists.sh exits 0 only when fail==0. Pre-deploy gate.

## scripts/verify-specialists.sh

CLI wrapper at [packages/web-server/scripts/verify-specialists.sh](../../packages/web-server/scripts/verify-specialists.sh). Bash + `curl` + `jq`.

Usage:
```sh
# Defaults to http://localhost:7777, playerId=1000
./scripts/verify-specialists.sh

# Override host
GREENHAVEN_HOST=http://10.0.0.5:7777 ./scripts/verify-specialists.sh

# Override player id (must exist in DB with appropriate state — e.g. an active dialogue partner if you want anchor to pass)
PLAYER_ID=2000 ./scripts/verify-specialists.sh

# Production/debug-key deployments
GREENHAVEN_DEBUG_KEY=... ./scripts/verify-specialists.sh
```

Behaviour:
- POSTs to `$HOST/api/debug/verify-specialists` with `{"playerId": $PLAYER_ID}`.
- 90s timeout (specialists are fast; the timeout is for the whole batch).
- Validates the response is JSON.
- Reads `summary: {pass, skipped, fail, total}`.
- Iterates `results[]` and prints one line per specialist:
  - `✓ spec39 quest_watcher (1.2s) — watcher_ran=true`
  - `⊘ spec45 dialogue_anchor (skipped) — no active partner`
  - `✗ spec48 cartridge_steward — schema_mismatch`
- Exits 0 only when `fail == 0`.

Run as a CI step: `./scripts/verify-specialists.sh` after `npm run dev` boots in CI; CI fails if any specialist's contract regresses.

## CLI specialist regression harness (spec 61)

Spec 61 adds source-run CLI tools that do not require adding new HTTP routes:

- [packages/web-server/scripts/simulate-specialist.ts](../../packages/web-server/scripts/simulate-specialist.ts)
- [packages/web-server/scripts/test-voice-warden.ts](../../packages/web-server/scripts/test-voice-warden.ts)
- [packages/web-server/src/devtools/simulateSpecialist.ts](../../packages/web-server/src/devtools/simulateSpecialist.ts)
- [packages/web-server/src/devtools/specialistFixtures.ts](../../packages/web-server/src/devtools/specialistFixtures.ts)

Use them from `packages/web-server`:

```sh
npm exec -- tsx scripts/test-voice-warden.ts
npm exec -- tsx scripts/simulate-specialist.ts --fixture cartridge_reject_duplicate_location
npm exec -- tsx scripts/simulate-specialist.ts --fixture quest_pacer_dead_arc
npm exec -- tsx scripts/simulate-specialist.ts --specialist voice_warden --input "{\"author\":\"GH Harness Lane\",\"tone\":\"narrator\",\"text\":\"...\",\"done\":true}"
```

`simulate-specialist` options:

- `--specialist voice_warden|movement_warden|cartridge_steward|quest_pacer`
- `--input <json>` for custom input.
- `--fixture <id>` for built-in fixtures.
- `--fixture-mode temp|existing|none`; default `temp` creates an isolated PGlite database under `C:\tmp`.
- `--session-id`, `--player-id`, and `--turn-id` for existing-state runs.

Output is JSON on stdout:

```json
{
  "ok": true,
  "status": "passed",
  "specialist": "cartridge_steward",
  "fixtureId": "cartridge_reject_duplicate_location",
  "fixtureMode": "temp",
  "providerAvailable": false,
  "expected": {"kind": "tool_rejected", "errorIncludes": "near-duplicate"},
  "notes": ["tool rejected: ..."]
}
```

Provider-backed Voice Warden and Movement Warden fixtures return `status:"skipped"` when neither `DEEPSEEK_API_KEY` nor `FEATHERLESS_API_KEY` is configured. Deterministic fixtures such as Cartridge Steward and Quest Pacer run without provider keys.

For database and cartridge diagnostics outside the specialist layer, see [Developer diagnostics](developer-diagnostics.md).

## Support smoke ordered queue regression (spec 88)

`node packages/web-server/dist/scripts/support-smoke.js` now includes the `ordered_queue_regression` check. It runs without provider keys on a temporary PGlite database.

The fixture creates a slow Quest Watcher slot, a fast Quest Pacer slot, an expired optional post-turn slot, and a queued next player input. It verifies:

- queued input creates no chat row and no player bubble before the previous barrier closes;
- chat-visible post-turn cards release by slot order, not by producer completion time;
- replayed `/api/session/:id/events` order matches live `gui:event` order;
- released chat-visible GUI events have server ids and explicit turn/message anchors;
- duplicate quest watcher proposals do not emit duplicate quest cards;
- transcript diagnostics report no order gaps, open barriers, queue leaks, or duplicate quest cards.

The returned detail includes `liveEventIds`, `replayedEventIds`, and `releaseSeqs`; `releaseSeq` is the visible ordering key for deferred GUI events. Incremental replay callers should use `/events?afterReleaseSeq=<lastSeenReleaseSeq>`.

## Adding a new specialist to the harness

When you ship a new specialist (spec NN):

1. **Ship a debug runner endpoint** at `/api/debug/run-<name>` in [packages/web-server/src/index.ts](../../packages/web-server/src/index.ts). The endpoint should accept a synthetic body sufficient to drive the specialist end-to-end + return the validated output JSON (or `{ran:false, reason: ...}` if a precondition was missing).
2. **Add a `Test` entry** to the `tests: Test[]` array in `verify-specialists` ([packages/web-server/src/index.ts:1236](../../packages/web-server/src/index.ts#L1236)). Pattern:
   ```ts
   {
     spec: NN,
     name: 'my_new_specialist',
     endpoint: '/api/debug/run-my-new-specialist',
     body: { /* synthetic input — e.g. a player_id known to have the relevant state */ },
     check: (p) => {
       const o = p as Record<string, unknown>;
       if (o['ran'] === false) return {status: 'skipped', notes: o['reason'] ?? 'no precondition'};
       // Assert the documented contract
       return /* validation */ ? {status: 'pass', notes: '...'} : {status: 'fail', notes: '...'};
     },
   }
   ```
3. **No CLI change needed** — `verify-specialists.sh` iterates `results[]` from the response, no spec-specific code in the bash script.
4. **Cover the fail-open path.** The `check` should accept `{ran:false, reason}` as `'skipped'`, not `'fail'`. The harness verifies the contract — if a specialist legitimately decides "no opinion", that's the documented behaviour.

The synthetic input should be realistic enough that the specialist's `runSpecialist` call actually fires (so we test the full LLM path), but tight enough that the verdict is deterministic. For specialists that depend on per-player state (Dialogue Anchor, Companion Depart Engine), seed the verification player (entity_id 1000) with the relevant overlays via a fixture migration.

## Sources

- [packages/web-server/src/index.ts](../../packages/web-server/src/index.ts) — `/api/debug/verify-specialists` and per-specialist debug runners
- [packages/web-server/scripts/verify-specialists.sh](../../packages/web-server/scripts/verify-specialists.sh) — CLI wrapper
- [packages/web-server/plans/execution-roadmap/specs/50-verification-harness.md](../../packages/web-server/plans/execution-roadmap/specs/50-verification-harness.md) — original spec
