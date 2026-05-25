# Notice Journal

`FEAT-NOTICE-1` makes the **Notice Journal** (J hotkey) a real, durable,
server-backed surface. The previous FEAT-SHELL-1 placeholder rendered in-memory
`systemEvents` via `EventCard`, which lost everything between reloads. The new
body reads a projection of important released `gui_events` from the
`player_journal_entries` table through a bridge-owned fetch and hook.

## Server contract

- Migration `packages/web-server/migrations/0120_player_journal_entries.sql`
  creates the projection table with FKs to `players(entity_id)`
  (`ON DELETE CASCADE`), `sessions(id)` (`ON DELETE SET NULL`), and
  `gui_events(id)` (`ON DELETE SET NULL`); a partial unique index on
  `(player_id, source_event_id) WHERE source_event_id IS NOT NULL` for
  `ON CONFLICT DO NOTHING` dedupe; and two read indexes — `(player_id, id DESC)`
  and `(player_id, entry_type, id DESC)`. `entry_type` is a `CHECK` enum of
  `quest | progression | relationship | world | story | system`.
- Service: `packages/web-server/src/services/NoticeJournalService.ts`.
  `snapshot(playerId, opts)` materializes released gui_events for the player
  (deterministic title/body derived from structured payload fields, no parsed
  prose) then returns `list(playerId, opts)`. `list` paginates newest-first by
  `id`, accepts an exclusive `cursor`, optional `entry_type` filter, default
  limit 50, hard cap 200, and reports `nextCursor` only when another page
  exists.
- Route: `GET /api/player/:id/notices?limit=<n>&cursor=<id>&type=<entry_type>`
  in `packages/web-server/src/routes/notices.ts`. Protected by the central
  `ownsPlayer()` middleware mounted in `index.ts`. Returns
  `{playerId, entries, nextCursor}`; 400 on invalid id / limit / cursor / type,
  404 on unknown player.

## Frontend

- Bridge: `packages/web-ui/src/bridge/noticeJournal.ts`. Owns the `fetch` call
  and the `JournalEntryType` / `NoticeJournalEntry` / `NoticeJournalSnapshot`
  types; the surface never touches the network directly.
- Hook: `packages/web-ui/src/hooks/useNoticeJournal.ts`. Loads on mount and
  refreshes whenever any of the 15 important quest / adventure / memory /
  relationship / progression / world events reaches the `system:event` bus that
  `bridge/eventTimeline.ts` already feeds (`emitSystemEventFromGuiEnvelope`
  pushes every released envelope into `__emit('system:event', {type, ...})`).
  Filters spurious system events client-side via `JOURNAL_REFRESH_TYPES`.
  Refresh bursts within 150 ms collapse into one refetch.
- Surface: `packages/web-ui/src/components/surfaces/NoticeJournalSurface.tsx`.
  Renders loading / error / empty states, six filter chips (`all` plus the five
  typed buckets — `quest`, `progression`, `relationship` (Bonds), `story`,
  `world`, `system` (Memory)), newest-first timeline rows with an entry-type
  pill and the occurred-at timestamp, and a cursor-backed "Load older notices"
  button while `nextCursor != null`. CSS lives in
  `packages/web-ui/src/styles/messenger-layout.css` under the `FEAT-NOTICE-1`
  block — uses existing Greenhaven CSS tokens (`--gh-surface-elev`,
  `--gh-text-strong`, etc.); no donor / Material UI imports.

## Event taxonomy watched

The hook's `JOURNAL_REFRESH_TYPES` Set mirrors the server's
`IMPORTANT_EVENT_TYPES`:

- `quest:created` — `tools/quest.ts:emitQuestCard`
- `quest:started` — `tools/quest.ts:emitQuestCard`
- `quest:advanced` — `tools/quest.ts:emitQuestCard`
- `quest:auto_advanced` — `agents/questWatcher.ts`
- `quest:completed` — `tools/quest.ts:emitQuestCard`
- `adventure:accepted` — `domain/adventure/AdventureService.ts`
- `adventure:expired` — `domain/adventure/runtime/adventureQueue.ts`
- `memory:added` — `tools/memory.ts`
- `memory:enriched` — `agents/npcVoice.ts`
- `string:changed` — `tools/strings.ts`
- `companion:added` / `companion:removed` — `tools/companion.ts`
- `xp:awarded` / `xp:levelup` — `tools/progression.ts`
- `location:first_entry` — `turn/phases/LocationVisitPhase.ts`

The two sources of truth for this taxonomy are `IMPORTANT_EVENT_TYPES` exported
from `packages/web-server/src/services/NoticeJournalService.ts` and the
`JOURNAL_REFRESH_TYPES` Set in `packages/web-ui/src/hooks/useNoticeJournal.ts`.
Adding a new emit site means updating both.

## Filter + pagination contract

- Changing a filter chip is server-owned: it calls
  `/api/player/:id/notices?type=...`, the hook resets the local list, and the
  server returns only entries in that bucket. The surface does not filter loaded
  text locally.
- "Load older notices" appends the next page via the server-returned
  `nextCursor`. Entries are deduped by `id` so a concurrent refresh that crosses
  a page boundary never doubles a row. The merged list is re-sorted newest-first
  defensively.
- Refresh coalescing: a burst of important `system:event`s collapses into one
  refetch (debounced 150 ms). This keeps the storm of `quest:advanced` +
  `xp:awarded` + `string:changed` that often fires on quest completion from
  triggering five sequential fetches.

## Memory privacy (FEAT-MEMORY-1)

The Notice Journal records that a memory beat _happened_ without ever exposing
the underlying NPC memory text, summary, draft text, private reflection, link
reason, tags, or category. The chat-side `EventCardMemory` already enforces this
in the live timeline; the durable projection + its API response apply the same
contract so durability does not become a privacy regression.

- The taxonomy still includes `memory:added` and `memory:enriched` — players
  need to _see that something happened_ — but every row is normalized to a
  generic, deterministic shape:
  - `title`: `"Memory recorded"` (for `memory:added`) or `"Memory deepened"`
    (for `memory:enriched`). The memory `kind` / `category` (`betrayal`,
    `intimacy`, etc.) is **not** surfaced — leaking it would tell the player
    _what type_ of private memory the NPC just formed. The frontend localizes
    via the standard `entry_type` / `event_type` keys; no additional translation
    surface is required.
  - `body`: always `null`. The journal row carries no prose for memory events.
  - `payload`: passed through `sanitizeJournalPayload(eventType, payload)` which
    keeps **only** structured identifiers the UI needs to render "X noticed
    something": `memoryId`, `ownerId`, `ownerName`, `aboutId`, `aboutName`, plus
    the numeric `importance` (an opaque signal, not a clue to what was
    remembered). Everything else — `text`, `summary`, `draft_text`, `kind`,
    `category`, `tags`, `sensitive`, `internal_reflection`, `link_reason`,
    `links_to_memory_id`, and any other field — is dropped.

- Two-layer defense:
  1. **At INSERT** — `materialize()` calls `sanitizeJournalPayload` before the
     row reaches `player_journal_entries`, so disk never holds the private
     memory text going forward.
  2. **At read** — `list()` re-applies the sanitizer to legacy memory rows that
     may have been materialized before this contract landed, forces their `body`
     to `null`, **and rewrites `title` through `deriveTitle()`** so a
     pre-FEAT-MEMORY-1 row whose persisted `title` carries the memory `kind` /
     `category` (e.g. `"betrayal"`, `"intimacy"`) is normalized to the generic
     `"Memory recorded"` / `"Memory deepened"` placeholder before the row leaves
     the service. The sanitizer is idempotent on already-clean payloads, and the
     title rewrite is idempotent on already-generic titles, so both are no-ops
     for new rows.

- The read-time normalization is intentionally **read-only**: we do not mutate
  already-persisted rows (no migration was added). The on-disk `title` / `body`
  / `payload` may still be the leaky originals on legacy installs; only the API
  response and the journal projection are normalized. The legacy-title live
  smoke
  (`.codex/run-logs/live-playtest/2026-05-17T10-30-00Z-memory-journal-legacy-title-privacy-smoke/`)
  explicitly seeds a leaky row, proves the API returns the generic title, and
  re-reads the table to confirm the on-disk row was not modified.

- **`gui_events` itself is not scrubbed.** It remains the server audit / outbox
  source of truth. Only the player-facing projection (`player_journal_entries`)
  and the `/api/player/:id/notices` response are sanitized. The live smoke
  harness explicitly verifies this — `gui_events` still carries the original
  memory text while `player_journal_entries` and the API response do not.

The sanitizer is exported from
`packages/web-server/src/services/NoticeJournalService.ts` as
`sanitizeJournalPayload(eventType, payload)` so future callers that want to
expose journal-shape data through any other surface can route through the same
chokepoint.

### Repeatable smoke command

The two timestamped donor harnesses above were promoted into a stable repository
command so future agents can verify the FEAT-MEMORY-1 contract without hunting
buried `.codex/run-logs` artifacts:

```sh
npm --prefix packages/web-server run live:notice-journal-privacy
```

The script
(`packages/web-server/src/scripts/notice-journal-memory-privacy-smoke.ts`) spins
up an isolated temp PGlite + backend on its own port (default 7801), serves
production `web-ui/dist`, and covers both halves of the contract in one run:

1. **Materialization path** — fires a live `memory:added` `gui_event` with a
   maximally-revealing payload through `/api/debug/live-ops`, then asserts the
   materialized journal row + API response are sanitized while the `gui_events`
   outbox still carries the original secret (audit intact).
2. **Legacy-title read path** — SQL-INSERTs two pre-FEAT-MEMORY-1 rows with
   leaky `title` (`betrayal` / `intimacy`), leaky `body`, and full sensitive
   `payload`, then asserts the API returns `Memory recorded` / `Memory deepened`
   with `body: null` and a sanitized payload while the on-disk rows are left
   untouched (read-only invariant).
3. **DOM leak guard** — drives Chromium through Title → Continue → game shell →
   J menu, asserts the three generic-title rows render, and verifies
   `document.body.innerText` contains zero hits for any of the six
   secret/category strings.

Evidence (read-only):

- `summary.json` — full per-step ok/failed report with `details`.
- `result.json` — terse `{passed, blockers, steps}` shape mirroring the earlier
  donor harness output (preserves any existing grep tooling).
- `notices-api-{materialized,legacy}.json`,
  `persisted-journal-row-materialized.json`, `gui-events-row-materialized.json`,
  `persisted-journal-rows-legacy-{before,after}.json` — captured SQL + HTTP
  snapshots so a failing run is diagnosable from the artifacts alone.
- `screenshots/journal.png` — full-page Notice Journal screenshot.
- `console-log.jsonl` + `network-log.jsonl` — browser-side noise log.

CLI flags: `--out <dir>` (default
`.codex/run-logs/live-playtest/notice-journal-memory-privacy-smoke`),
`--port <n>` (default 7801), `--keep-temp` (skip PGlite tmpdir cleanup),
`--timeout-ms <n>` (default 240_000). The script exits 1 on any blocker
(4xx/5xx, missing generic row, leak hit, unexpected exception) so it can plug
straight into CI when desired.

## Tests

- `packages/web-server/src/__tests__/services/noticeJournalService.test.ts` pins
  the backend contract: bounded taxonomy, noisy / side- effect types filtered
  out, materializer SQL shape, ON CONFLICT DO NOTHING, deterministic title/body
  derivation, cursor pagination, entry-type filtering, limit cap. The
  `memory privacy (FEAT-MEMORY-1)` suite pins the sanitizer whitelist, the
  materializer-time and read-time sanitization paths, and the no-op contract for
  non-memory events.
- `packages/web-server/src/__tests__/migrations/playerJournalEntries.test.ts`
  pins the migration shape on real PGlite: columns, primary key, three foreign
  keys with their delete rules, `CHECK` enum, the partial unique index + dedupe
  behavior, and the two read indexes.

## Status

`FEAT-NOTICE-1` is `[done]` in the master plan. Backend projection + API,
frontend bridge + hook + surface + filters + cursor pagination + CSS + i18n +
doc, and the isolated browser smoke that proves the round trip end to end are
all in place.

The closure smoke lives at
`.codex/run-logs/live-playtest/2026-05-16T19-00-00Z-notice-journal-browser-smoke/notice-journal-browser-smoke.ts`
and follows the FEAT-QUEST-1 pattern: temporary PGlite backend, profile PATCH
`{created:true}`, live-ops `emit_gui_event` seeds covering every bucket + 55
quest entries to force `nextCursor`, two read calls to prove materialization is
idempotent, Playwright drive of TitleScreen → Continue → ChatHeader Menu → `J`,
filter chips for all six typed buckets with zero pill leaks, a "Load older
notices" click that grows the rendered list from 50 → 65 rows with no
duplicates, one fresh `quest:auto_advanced` emit that triggers a live refetch
(no full reload) and surfaces the new entry at the top, and a `page.reload()`
that confirms persistence (50 rows + the live-emit row).

Hook hardening in the same pass: `useNoticeJournal` now uses a monotonic
generation token so stale fetches from a previous player/filter generation never
write after the next effect re-runs, and `loadMore()` sends the server-returned
`nextCursor` (mirrored via `nextCursorRef`) instead of inferring the cursor from
the last row.

Two optional follow-ups stay deferred (not blocking and not required by the
smoke):

- A dedicated `notice:created` SSE channel if a future playtest proves sub-turn
  freshness needs more than the existing `system:event` refresh path.
- An `importance` column via a forward-only migration 0121+ if ranking beyond
  newest-first becomes necessary.
