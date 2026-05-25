# LitRPG player-surface shell

Status: shell + four real, server-backed surfaces. The FEAT-SHELL-1 placeholders
were replaced by FEAT-INV-1, FEAT-QUEST-1, FEAT-NOTICE-1, and FEAT-STATE-1 (all
closed 2026-05-16); the Tier-8 cross-feature smoke at
`.codex/run-logs/live-playtest/2026-05-16T21-00-00Z-tier8-cross-feature-smoke/`
proved they coexist in one live session. FEAT-PRESENCE-3 (2026-05-17) extends
that proof with the FEAT-PRESENCE-1/2 living-world NPC presence UI. The donor
harness lives at
`.codex/run-logs/live-playtest/2026-05-17T09-25-34Z-living-world-cross-surface-smoke/`;
it was promoted into a stable repository command:

```sh
npm --prefix packages/web-server run live:living-world-surfaces
```

The script
(`packages/web-server/src/scripts/living-world-cross-surface-smoke.ts`) boots an
isolated temp PGlite + backend (default port 7802) + production `web-ui/dist`,
seeds one player + session + nearby NPC with one PUBLIC (`tired` / `long-shift`)
and one PRIVATE (`emotion` / `jealous`) actor status plus the four Tier-8
fixtures (inventory grant, quest, notice envelopes, progression + title +
skill + wallet + stat). Then it drives Chromium through:
rail/city-map/NPC-profile presence on bootstrap â†’ equip (I) â†’
`quest:auto_advanced` refresh (Q) â†’ live journal refresh (J) â†’ spend STR point
(P) â†’ hard `page.reload()` â†’ rail/city-map/NPC- profile presence on reload â†’
re-read all four surfaces â†’ whole- document `innerText` leak guard. Every
assertion is a hard blocker; private status strings must NOT appear anywhere in
API JSON, surface HTML, or `document.body.innerText`.

CLI flags: `--out <dir>` (default
`.codex/run-logs/live-playtest/living-world-cross-surface-smoke`), `--port <n>`
(default 7802), `--keep-temp`, `--timeout-ms <n>` (default 360_000). Evidence
written next to `result.json`: `summary.json`, the per-step API/DOM/SQL
snapshots listed under that directory, `screenshots/*.png`, and
`console-log.jsonl` / `network-log.jsonl` / `sse-events.jsonl` /
`emit-responses.jsonl`. Exits 1 on the first reproducible blocker.

## Shell

`packages/web-ui/src/components/surfaces/PlayerSurfaceShell.tsx` wraps
`@radix-ui/react-dialog` so the four player-facing surfaces share one
focus-trapped, Esc-closing, focus-restoring modal chrome. Visuals reuse the
existing `.modal-backdrop` / `.modal` / `.modal-body` Greenhaven classes;
per-surface layout rules (`.player-surface*` plus `.inventory-*` /
`.quest-dashboard-*` / `.notice-journal-*` / `.character-state-*`) live in
`src/styles/messenger-layout.css`. On viewports â‰¤ 540px the shell switches to a
bottom-anchored full-height sheet so no nested-card layout shifts the chat.

## Surfaces

| Hotkey | Surface         | Component               | Backed by                                                                                                                      | Contract doc                                   |
| ------ | --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `I`    | Inventory       | `InventorySurface`      | `bridge/inventory.ts` + `useInventorySnapshot` hook + `GET/POST /api/player/:id/inventory` / `/inventory/action`               | [`inventory-surface.md`](inventory-surface.md) |
| `Q`    | Quest Dashboard | `QuestDashboardSurface` | `bridge/questDashboard.ts` + `useQuestDashboard` hook + `GET /api/player/:id/quest-dashboard`                                  | [`quest-dashboard.md`](quest-dashboard.md)     |
| `J`    | Notice Journal  | `NoticeJournalSurface`  | `bridge/noticeJournal.ts` + `useNoticeJournal` hook + `GET /api/player/:id/notices`                                            | [`notice-journal.md`](notice-journal.md)       |
| `P`    | Character State | `CharacterStateSurface` | `bridge/characterState.ts` + `useCharacterState` hook + `GET/POST /api/player/:id/character-state` / `/character-state/action` | [`character-state.md`](character-state.md)     |
| `B`    | Bonds           | `RelationshipsSurface`  | `bridge/strings.ts` + `useStringsGraph` hook + `GET /api/player/:id/strings/graph` (FEAT-REL-1)                                | [`frontend-agent-specs/strings-web.md`](frontend-agent-specs/strings-web.md) |

`M` continues to open `CityMapModal` (unchanged). `Esc` closes the active
surface; Radix Dialog also handles Esc inside the focus trap so the global
keyboard handler is fallback only. Settings, NPC profile, and Recovery modals
are independent and unaffected.

## State ownership

`GameScreen` owns one `activeSurface: SurfaceKind | null` state where
`SurfaceKind = 'inventory' | 'quests' | 'journal' | 'character' | 'bonds'`. The
legacy self-profile modal / notices drawer multi-state was replaced with this
single piece of state. `I/Q/J/P/B` hotkeys plus `ChatHeader` menu items all funnel
through `setActiveSurface(...)`. The deprecated self-profile tabs and compact
profile modal are removed from active source.

## Server-state-is-canon

Every surface reads through its bridge module and never calls `fetch` from a
leaf component. The four read snapshots (`/api/player/:id/inventory`,
`/quest-dashboard`, `/notices`, `/character-state`) and the two action endpoints
(`/inventory/action`, `/character-state/action`) are protected by the central
`ownsPlayer()` middleware; state-changing routes additionally chain
`rateLimitStateChanges()` for SEC-5. Player clicks dispatch through validated
server actions that route into the existing tool registry (`use_item` /
`equip_item` / `give_to_npc` / `equip_title` / `spend_stat_point` /
`spend_skill_point`), so client and broker mutations share one transactional +
SSE-OK path.

Refresh comes from SSE: `inventory:changed`, `currency:changed`, the quest /
adventure refresh taxonomy in `useQuestDashboard`, the journal taxonomy in
`useNoticeJournal`, and the `character:*` / `xp:*` taxonomy in
`useCharacterState`. No surface mutates the snapshot optimistically â€” every
visible state change is the result of a server-emitted envelope.

## i18n

Surface titles, empty-state copy, filter chips, action buttons, success / error
chips, and per-tab labels are all real `BASE_MESSAGES` / `EXTRA_MESSAGES` keys,
not `tx(key, fallback)` fallbacks. The catalog covers 26 languages â€” English and
Russian have bespoke strings and the other 24 locales inherit the English
baseline from `COMMON` in `translationExtras.ts` until per-locale overrides
land. `npm --prefix packages/web-ui run i18n:check` enforces this.

## No new fetches

No component under `src/components/surfaces/` calls `fetch` directly. The static
check `rg -n "fetch\(" packages/web-ui/src/components/surfaces` must return no
matches; the per-surface bridge modules in `packages/web-ui/src/bridge/` own the
network surface. The same rule applies to `GameScreen.tsx` and `ChatHeader.tsx`.

## Smoke evidence

- FEAT-INV-1:
  `.codex/run-logs/live-playtest/2026-05-16T17-00-00Z-inventory-browser-smoke/`
- FEAT-QUEST-1:
  `.codex/run-logs/live-playtest/2026-05-16T18-00-00Z-quest-dashboard-browser-smoke/`
- FEAT-NOTICE-1:
  `.codex/run-logs/live-playtest/2026-05-16T19-00-00Z-notice-journal-browser-smoke/`
- FEAT-STATE-1:
  `.codex/run-logs/live-playtest/2026-05-16T20-00-00Z-character-state-browser-smoke/`
- Tier-8 cross-feature gate:
  `.codex/run-logs/live-playtest/2026-05-16T21-00-00Z-tier8-cross-feature-smoke/`
