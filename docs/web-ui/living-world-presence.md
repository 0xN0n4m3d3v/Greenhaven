# Living-world presence (FEAT-PRESENCE-1)

Greenhaven's left rail, city-map "Here now" list, and NPC profile modal surface
two server-canonical, public-only signals so the world feels alive without
exposing private NPC interiority:

1. **Relationship bond band** — a coarse 7-step ladder (`hostile` / `wary` /
   `neutral` / `friendly` / `trusted` / `bonded`, plus `unknown` when no strings
   recorded) derived from the per-player strings count for that NPC
   (`runtime_fields.field_key = 'strings'`).
2. **Public actor statuses** — at most three short, whitelisted status chips
   taken from `actor_statuses` rows where the `status_kind` is public
   (`injured`, `wounded`, `sick`, `tired`, `exhausted`, `drunk`, `asleep`,
   `unconscious`, `busy`, `hostile`, `wary`, `friendly`, `grieving`, `missing`,
   `dead`). NPC private memory / mood / intent is **never** surfaced here.

## Read model contract

The signals piggyback on the existing `/api/session/:id/locations` LocationsView
read model so no new fetch path or mutation endpoint is needed. The `nearby[]`
entries returned to the client carry:

```ts
interface LocationsViewNearby {
  id: number;
  name: string;
  status?: string;
  summary?: string | null;
  portrait_set?: Record<string, string | null> | null;
  // FEAT-PRESENCE-1 ↓
  relationship: { band: RelationshipBand | null; count: number | null } | null;
  statuses: Array<{ kind: string; value: string; intensity: number }>;
}
```

Server source of truth: `packages/web-server/src/presenceEnrichment.ts` →
`buildPresenceEnrichment(playerId, npcIds)`. The helper:

- short-circuits when `npcIds` is empty,
- reads the cartridge-scoped `runtime_fields.field_key = 'strings'` row,
  projects the JSONB string-count map onto the requested NPC ids, and maps each
  count through `stringBandForCount` (single source of truth in
  `packages/web-server/src/stringsContract.ts`),
- selects the per-NPC top-N (cap `STATUS_PER_NPC_CAP = 3`) public statuses via
  `ROW_NUMBER() OVER (PARTITION BY actor_entity_id ORDER BY intensity DESC, updated_at DESC)`,
  clamps each `intensity` into `[0, 1]` rounded to 2 decimals, and filters
  through the `PUBLIC_STATUS_KINDS` whitelist.

`SessionLifecycleService.loadNearbyForLocation` calls the helper after
`loadPresentPeopleAtLocation` and zips the relationship/statuses into each
`nearby[]` row.

## Bridge / hook plumbing

`useLocationUpdates` (the `nearby:updated` SSE handler) accepts the new optional
fields in the payload (`relationship`, `statuses`) and stores them on
`state.nearby`. Legacy emitters that don't yet send the fields are tolerated —
the consumer treats absence as `band: null` + empty status list.

Shared UI types live in `packages/web-ui/src/lib/presenceLabels.ts`:

- `RelationshipBand` mirrors the server union.
- `relationshipBandLabel(band, t)` resolves the localized label with an English
  fallback when `t` returns the key unchanged.

## Surface rendering

- **`ChatList` contact rows** — render a compact `chatlist-band-chip` next to
  the row name and a leading `chatlist-status-pip` (plus `+N` overflow
  indicator). When neither is available the legacy `chatlist-row-sub` summary
  line is kept.
- **`CityMapModal` "Here now" list** — each nearby row shows the band badge and
  the leading status pip.
- **`NPCProfileModal`** — when present, a dedicated `npc-profile-presence` block
  renders the bond label and a small list of all surfaced status badges. The
  block disappears if neither signal is set.

## What this is not

- Not a mutation surface. There is no client-side affordance to change a band or
  a status; the broker tools and tick engines remain the only writers.
- Not a leak of NPC inner state. Hidden status kinds (`emotion`, `mood`,
  `intent`, …) are excluded at SQL time.
- Not a new transport. The fields ride on existing `nearby:updated` /
  `locations:updated` events and the bootstrap snapshot; nothing new is fetched
  from the leaf components.

## FEAT-PRESENCE-2 polish

Followup pass on top of FEAT-PRESENCE-1 (2026-05-17):

- **Localized labels in the map.** `CityMapModal` now accepts an optional `t`
  prop and renders the relationship band via `relationshipBandLabel(band, t)`
  instead of the raw `band` id. `GameScreen` threads the existing `t` function
  through. The chip `aria-label` mirrors the visible label so screen-reader
  users hear the localized band, not `trusted` / `friendly`.
- **Dedicated CSS** in `packages/web-ui/src/styles/messenger-layout.css`. Six
  `chatlist-band-*` palettes, six `city-map-band-*` palettes, six
  `npc-profile-band-*` palettes, plus shared chip/pip primitives. All chips have
  a fixed pixel height (16px in the rail, 18px on the map row, 20px in the
  modal) so adding presence to a row never changes its layout height. Chip
  widths are capped (`max-width: 12ch / 16ch / 20ch`) with
  `overflow: hidden; text-overflow: ellipsis` so a long Russian or Greek label
  clips cleanly instead of breaking the contact-row flexbox.
- **Mobile guard.** Under `@media (max-width: 480px)` the leading status pip
  beside the rail/map band is hidden (the player can still see the full status
  list in the NPC profile modal) and the band chip's max width drops to `10ch`
  so the avatar + name pair stays legible on a narrow phone viewport.
- **Bridge model preservation** in `packages/web-ui/src/bridge/models.ts`.
  `engine.NPCSummary` now carries the optional `summary` / `portrait_set` /
  `relationship` / `statuses` fields and copies them verbatim from the source
  payload in its constructor. Every `engine.GameState.createFrom()` call site —
  `GetGameState()`, `bootstrap`, `sessionReset`, `stateReconciler` (×3) —
  therefore reconstructs `nearby[]` with the enriched fields intact instead of
  stripping them. The bootstrap and SSE-refresh DTO typings in
  `bridge/bootstrap.ts` and `bridge/sseClient.ts` were tightened to explicitly
  include `relationship` and `statuses` so future drift is caught at compile
  time.
- **Cross-surface integration smoke** at
  `.codex/run-logs/live-playtest/2026-05-17T09-25-34Z-living-world-cross-surface-smoke/presence-browser-smoke equivalent`
  (FEAT-PRESENCE-3, 2026-05-17). Combines the FEAT-PRESENCE seeding flow with
  the Tier-8 four-surface seed/act/reload cycle. The harness asserts (a) initial
  rail / city-map / NPC-profile presence chips render with `Friendly` + `tired`
  on bootstrap, (b) Inventory equip, Quest dashboard refetch, Notice Journal
  live emit, and Character State stat spend each take effect via the existing
  SSE-driven refresh, (c) after a hard reload all rail / map / profile presence
  chips AND all four durable player-surface rows survive, (d) the strings
  `emotion` and `jealous` are absent from every captured DOM snapshot and from
  `document.body.innerText` across the whole flow. All render assertions are
  blockers (no warnings tolerated); the smoke runs on its own isolated port
  (`7797`) and temp PGlite alongside the `7793` Tier-8 and `7795` presence-only
  harnesses.
- **Stable repository smoke command** (FEAT-PRESENCE-3 hardening, 2026-05-17).
  The donor harness above was promoted into a single repeatable `npm` script
  under `packages/web-server`:

  ```sh
  npm --prefix packages/web-server run live:living-world-surfaces
  ```

  Script: `packages/web-server/src/scripts/living-world-cross-surface-smoke.ts`.
  Boots an isolated temp PGlite + backend (default port 7802), serves production
  `web-ui/dist`, exercises the exact same seed → act → hard-reload → re-assert
  flow as the donor, writes `summary.json` + `result.json` + per-step
  snapshots + screenshots
  - `console-log.jsonl` / `network-log.jsonl` / `sse-events.jsonl` /
    `emit-responses.jsonl` to the `--out` dir (default
    `.codex/run-logs/live-playtest/living-world-cross-surface-smoke`). CLI
    flags: `--out <dir>`, `--port <n>`, `--keep-temp`, `--timeout-ms <n>`
    (default 360_000). The script exits 1 on the first reproducible blocker — no
    warnings are tolerated. This is the canonical way for future agents to
    verify the living-world × Tier-8 cross-surface contract without hunting
    timestamped run-log artifacts.

- **Browser smoke harness** at
  `.codex/run-logs/live-playtest/2026-05-17T09-16-14Z-presence-browser-smoke/`.
  Spins up an isolated backend on an alternate port, seeds one cartridge-scoped
  NPC at a known location with a positive relationship-string entry plus a
  PUBLIC `tired` actor status and a PRIVATE `emotion: jealous` actor status.
  Hits `/api/session/:id/locations?playerId=…`, asserts the band + only the
  public status, then drives the UI: title screen → Continue → game shell → rail
  row → city map → NPC profile, capturing a screenshot at each step. All PASS
  criteria are **hard blockers**: (a) the API JSON returns
  `relationship.band: 'friendly'` and `statuses[0].kind: 'tired'` for the seeded
  NPC and excludes the private kind/value; (b) the rail row HTML carries
  `.chatlist-band-chip.chatlist-band-friendly` with visible `"Friendly"` text
  and the `tired` status pip on initial bootstrap (no later SSE refresh
  required); (c) the city-map "Here now" row carries `.city-map-band-friendly`
  with `"Friendly"` text; (d) the NPC profile modal renders
  `.npc-profile-presence` with the bond label and a `tired` status badge; (e)
  the strings `emotion` and `jealous` are absent from the rail/map/profile DOM
  and from `document.body.innerText`. A failure in any of these fails the
  harness with exit code 1.
