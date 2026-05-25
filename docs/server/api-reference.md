# Greenhaven API Reference

All backend routes are built with [Hono](https://hono.dev/) and registered under the `/api` prefix in [packages/web-server/src/index.ts](../../packages/web-server/src/index.ts). The server runs by default on `127.0.0.1:7777` with all state modifications fully synchronized inside database transactions.

---

## Global Middleware & Security Gates

Before a request hits any route handler, it must pass through several global security guards:

1. **Host/Origin Loopback Guard (`SEC-8` / `DEEP-16`):**
   - Rejects any incoming request carrying a non-loopback `Host` or `Origin` header (emits `421 Misdirected Request` or `403 Forbidden`). 
   - Prevents DNS-rebinding or cross-site scripting attacks from foreign domains.
2. **Global Telemetry Middleware (`ARCH-15`):**
   - Separates normal HTTP requests (`http.request` event logging) from long-polling SSE streams (`sse.opened`/`sse.closed` logging) so stream duration does not skew normal HTTP dashboards.
3. **Global Error Handler (`SEC-3` / `DEEP-7`):**
   - Intercepts uncaught exceptions, logs them with detailed metadata and stack traces inside the backend performance database, and returns a sanitized JSON envelope to the client:
     ```json
     {
       "error": "internal_error",
       "correlation_id": "c73a985e-990a-412f-981f-998fde27e023"
     }
     ```
     *No sensitive exception details, SQL queries, or file paths are ever exposed in the response.*

---

## 1. Player Identity & HUD Auth
**Router File:** [packages/web-server/src/routes/player.ts](../../packages/web-server/src/routes/player.ts) (Mounted under `/api/player`)

### `POST /api/player/anonymous`
- **Purpose:** Mints a new anonymous player slot. Sets the `gh_player` session cookie containing the encrypted `playerId` to authorize all subsequent actions.
- **Request Body (Optional):**
  ```json
  { "displayName": "Vance" }
  ```
- **Response Shape:**
  ```json
  {
    "entity_id": 4001,
    "public_id": "usr_902f82ac...",
    "display_name": "Vance",
    "recovery_code": "GH-REC-90F2-11A9-BC...", // Returned ONCE on create
    "profile_created": false
  }
  ```
- **Rate Limit:** `rateLimitAnonymousPlayer()` (Max 5 signups per 15 minutes per IP on non-desktop builds; desktop bypasses).

### `POST /api/player/restore`
- **Purpose:** Restores an existing player identity from a recovery code, re-issuing the `gh_player` session cookie.
- **Request Body:**
  ```json
  { "recovery_code": "GH-REC-90F2-11A9-BC..." }
  ```
- **Response Shape:** Full player record matching `/api/player/anonymous`.
- **Rate Limit:** `rateLimitRecoveryRestore()` (Max 5 attempts per 15 minutes per IP).

### `GET /api/player/me`
- **Purpose:** Fetches the current HUD status by public ID.
- **Query Parameters:**
  - `id` (string, required): Player's `public_id`.
  - `preferCreated` (1/0, optional): If `1`, returns the active playable profile state.
  - `includeIntro` (1/0, optional): If `1` and player creation is complete, embeds the localized world introduction text blocks.
- **Response Shape:**
  ```json
  {
    "entity_id": 4001,
    "public_id": "usr_902f82ac...",
    "display_name": "Vance",
    "profile_created": true,
    "intro_header": "Welcome to Grinhaven",
    "intro_body": "..."
  }
  ```

### `GET /api/player/currency`
- **Purpose:** Fetches the active hero's gold/currency purse.
- **Security:** `requireAuth` (Valid `gh_player` cookie).
- **Response Shape:**
  ```json
  {
    "playerId": 4001,
    "count": 150
  }
  ```

### `GET /api/player/:id/strings/graph`
- **Purpose:** Renders the social leverage/relationship string matrix between the player and all met NPCs.
- **Security:** `requireAuth` + `ownsPlayer()` (Matches URL player `:id` with cookie).
- **Query Parameters:** `language` (e.g. `'ru'`, `'ja'`).
- **Response Shape:**
  ```json
  {
    "nodes": [{ "id": "200", "label": "Mikka", "kind": "npc" }],
    "edges": [{ "from": "4001", "to": "200", "relationship": "cautious", "intensity": 3 }]
  }
  ```

### `POST /api/player/reset-local-game`
- **Purpose:** Offline debug tool. Deletes the active player, sessions, inventory, quests, and clears the cookie.
- **Security:** `requireResetAuth` (Cookie matches, or desktop bypass) + SEC-5 rate limiter.
- **Response Shape:** `{ "ok": true, "playerId": 4001, "rowsDeleted": 47 }`.

---

## 2. Worlds & Heroes (Cartridge Library)
**Router File:** [packages/web-server/src/routes/cartridges.ts](../../packages/web-server/src/routes/cartridges.ts) (Mounted under `/api`)

These routes manage available Cartridges, compiling and importing Forge projects, and launching playthroughs. There is no `ownsPlayer` check here because they are consulted during boot, before a hero is chosen.

### `GET /api/cartridges`
- **Purpose:** Lists all installed cartridges.
- **Response Shape:**
  ```json
  {
    "cartridges": [
      { "id": "greenhaven-world", "title": "Greenhaven", "version": "1.4.0", "contentHash": "sha256_..." }
    ]
  }
  ```

### `GET /api/cartridges/library/status`
- **Purpose:** Boot-gate status API called before any player signup. Decides if the UI boots directly to gameplay or routes into Worlds & Heroes to trigger a first import.
- **Response Shape:**
  ```json
  {
    "cartridgeCount": 1,
    "readyCartridgeCount": 1,
    "heroCount": 2,
    "defaultForgeProject": { "path": "C:\\Greenhaven\\cartridges\\default", "available": true }
  }
  ```

### `GET /api/filesystem/directories`
- **Purpose:** Directory browser allowing developers to pick local folders (Obsidian vaults or compiled Forge folders) for importing.
- **Query Parameters:** `path` (absolute folder path).
- **Response Shape:**
  ```json
  {
    "currentPath": "C:\\Greenhaven",
    "parentPath": "C:\\",
    "entries": [
      { "name": "MyWorld", "path": "C:\\Greenhaven\\MyWorld", "obsidianVault": true, "forgeProject": false }
    ]
  }
  ```

### `POST /api/cartridges/import/jobs`
- **Purpose:** Initiates an asynchronous import preview/dry-run job for a target folder.
- **Request Body:**
  ```json
  {
    "sourceKind": "obsidian_vault", // 'obsidian_vault' | 'forge_project'
    "sourcePath": "C:\\Greenhaven\\MyWorld",
    "mode": "install" // 'install' | 'reimport' | 'repair' | 'dry_run'
  }
  ```
- **Response Shape (Job Token):**
  ```json
  {
    "jobId": "job_9a0c128f...",
    "status": "processing",
    "sourcePath": "C:\\Greenhaven\\MyWorld"
  }
  ```

### `GET /api/cartridges/import/jobs/:jobId`
- **Purpose:** Polls the status, validation reports, and diff details of a generated import job.
- **Response Shape:**
  ```json
  {
    "jobId": "job_9a0c128f...",
    "status": "ready", // 'processing' | 'ready' | 'failed' | 'cancelled'
    "validation": { "ok": true, "errors": [], "warnings": [] },
    "diffSummary": { "added": 12, "modified": 4, "deleted": 0 }
  }
  ```

### `POST /api/cartridges/import/jobs/:jobId/apply`
- **Purpose:** Commits the previewed cartridge records into the database within a single transaction.
- **Request Body:**
  ```json
  { "acceptWarnings": true }
  ```
- **Side Effects:** Compiles static dialogue matrices, registers entities, writes scoped starting location tags, content-addresses visual assets into cache, and mints default single-player universes.

### `POST /api/playthroughs/preview`
- **Purpose:** Fetches the hero continuity carry-over preview before launching.
- **Request Body:**
  ```json
  { "playerId": 4001, "cartridgeId": "greenhaven-world" }
  ```
- **Response Shape:** Detailed continuity preview showing what items, stats, XP, and titles carry over (`hero_core`) vs what stays behind (`universe_local`).

### `POST /api/playthroughs/launch`
- **Purpose:** Launches a playthrough for a hero in an installed world. If a playthrough already exists, it loads the saved state. If not, it fails with `repair_required` or `no_starting_location` (requiring a call to `/new-game`).
- **Request Body:**
  ```json
  { "playerId": 4001, "cartridgeId": "greenhaven-world" }
  ```
- **Side Effects:** Sets `hero_cartridge_states.status = 'active'`, copies the starting location to the player slot, syncs the back-compat global meta cache, and re-issues the `gh_player` cookie.

### `POST /api/playthroughs/new-game`
- **Purpose:** Resets the playthrough state for the specific (hero, cartridge) pair (erasing local journal entries, quest progress, local inventory, and location states) while leaving other heroes' playthroughs untouched, then launches the fresh world.
- **Request Body:** Same as `/playthroughs/launch`.

---

## 3. Session & Turn Runtime
**Router File:** [packages/web-server/src/routes/session.ts](../../packages/web-server/src/routes/session.ts) (Mounted under `/api/session`)

All session routes require an authenticated player context (`requireAuth` cookie matching) and participate in player-ownership validation. State changes are guarded by `rateLimitStateChanges()` (30/min cap).

### `POST /api/session`
- **Purpose:** Finds or creates a gameplay session for the current player.
- **Request Body:**
  ```json
  { "sessionId": "sess_80fac...", "playerId": 4001 }
  ```
- **Response Shape:**
  ```json
  {
    "sessionId": "sess_80fac...",
    "state": { "turnNumber": 12, "lastMessageSeq": 45 }
  }
  ```

### `GET /api/session/:id/stream`
- **Purpose:** Establishes the real-time Server-Sent Events (SSE) stream for game narrative, tool triggers, cost telemetry, and client event synchronization.
- **Security:** Chained to the specialized `rateLimitSse()` middleware.
- **Header Contract:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.

### `GET /api/session/:id/state`
- **Purpose:** Returns a complete recap snapshot of the current session state (e.g. active narrator/broker models, turn counter, thinking states).

### `GET /api/session/:id/locations`
- **Purpose:** Returns the visual location bubble, adjacent exits, present NPCs, and local map nodes.
- **Security:** Dynamically filters all exited topologies and map nodes to the active cartridge (`FEAT-CART-LIB-7`), guaranteeing A-side players never leak B-side paths.

### `POST /api/session/:id/turn`
- **Purpose:** Dispatches the player's written text or button click into the turn queue.
- **Rate Limit:** Chained to the strict `rateLimitTurns()` middleware (10-burst token bucket, 30/min refill rate per IP/player).
- **Request Body:**
  ```json
  {
    "text": "Inspect the wooden latch",
    "actionId": "act_button_inspect_latch", // Optional button ref
    "language": "en",
    "clientRequestId": "req_uuid_901c..."
  }
  ```
- **Side Effects:** Enqueues the turn into the in-memory turn ingress queue. The turn runner picks it up, validates reachability, locks the player row via `SELECT FOR UPDATE`, fires specialists, processes broker tool choices, commands narrator text generation, materializes asset updates, and pushes events over the SSE stream.

### `POST /api/session/:id/cancel`
- **Purpose:** Cancels a currently processing or enqueued turn, freeing the turn lock for subsequent player inputs.

### `POST /api/session/:id/reset`
- **Purpose:** Resets the local session turn counter and returns the player to their last saved/stable anchor.

### `POST /api/session/:id/dialogue/start`
- **Purpose:** Places the session into focused dialogue mode with a present NPC, routing subsequent ambient turns directly to focused-narrator pipelines.
- **Request Body:** `{ "npcId": 200 }`

### `POST /api/session/:id/dialogue/end`
- **Purpose:** Exit focused conversation mode, returning the session topology to ambient location-graph listening.

---

## 4. Gameplay Systems (Player-Scoped)

These routes are protected by `ownsPlayer()` + `rateLimitStateChanges()` (30/min cap for mutations).

### `GET /api/player/:id/quests`
**Router:** [packages/web-server/src/routes/quests.ts](../../packages/web-server/src/routes/quests.ts)
- **Purpose:** Fetches the quest log for the player.
- **Response Shape:**
  ```json
  {
    "active": [{ "questId": "q_mikka_trust", "title": "Earn Mikka's Trust", "stage": "bargain_made" }],
    "completed": [],
    "failed": []
  }
  ```

### `GET /api/player/:id/inventory`
**Router:** [packages/web-server/src/routes/inventory.ts](../../packages/web-server/src/routes/inventory.ts)
- **Purpose:** Returns the detailed inventory slots, categories, and item properties of the hero.

### `GET /api/player/:id/saves`
**Router:** [packages/web-server/src/routes/saves.ts](../../packages/web-server/src/routes/saves.ts)
- **Purpose:** Lists all saved states available in `save_slots`.
- **Response Shape:**
  ```json
  {
    "slots": [
      { "id": "save_slot_1", "label": "Before entering the cellar", "timestamp": "2026-05-20T12:00:00Z" }
    ]
  }
  ```

### `POST /api/player/:id/saves`
- **Purpose:** Mints a fresh save-state slot, packing the entire playthrough memory and fields.
- **Request Body:** `{ "label": "Before the bargain" }`

### `POST /api/player/:id/saves/:slotId/restore`
- **Purpose:** Restores a save state, overwriting active player stats, active quest details, and current coordinates with the cached slot snapshot.

---

## 5. Audio & Scoped Assets serving

These routes stream binary media assets and are unauthenticated to allow direct loading inside standard browser tags (e.g. `<img src="...">`).

### `GET /api/assets/cartridges/:cartridgeId/world/:kind/:slug/:role?`
**Router:** [packages/web-server/src/routes/visualAssets.ts](../../packages/web-server/src/routes/visualAssets.ts)
- **Purpose:** Resolves a content-addressed visual asset belonging to an installed cartridge and streams the bytes.
- **Security Hardening (`OWV-17`):**
  - Rigid ASCII-slug path checks (rejects any traversal `..` or `/`).
  - File extension allowlist (`.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`).
  - Emits `X-Content-Type-Options: nosniff` header on every stream.
  - Strict Content-Security-Policy (CSP) headers applied when streaming SVG types:
    ```http
    Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox
    ```

### `GET /api/assets/world/:kind/:slug/:role?`
- **Purpose:** Legacy fallback route for visual assets. Consults the active cartridge manifest cache first; if none exists, falls back to streaming from the default raw Obsidian directories for convenience.

---

## 6. Debug & Diagnostics
**Router File:** [packages/web-server/src/routes/debug.ts](../../packages/web-server/src/routes/debug.ts) & [packages/web-server/src/routes/debugDiagnostics.ts](../../packages/web-server/src/routes/debugDiagnostics.ts)

All routes under `/api/debug/*` and `/api/db/*` (excluding health checks) are locked by the `createDebugRouteGuardMiddleware()` (`SEC-4`).
- **Dev/Desktop mode:** Require a matching header: `X-Debug-Key: <configured_key>`.
- **Production mode:** Are completely deactivated, returning `404 Not Found` regardless of the key sent.

### `GET /api/debug/verify-specialists`
- **Purpose:** Triggers a dry-run smoke test against the active specialist roster, running sample inputs through pre-broker and post-turn evaluation cycles.
- **Response Shape:**
  ```json
  {
    "ok": true,
    "specialists": [
      { "name": "injury_tracker", "status": "passed", "checksRun": 4 }
    ]
  }
  ```

### `GET /api/debug/diagnostics/telemetry/errors`
- **Purpose:** Extracts and summarizes recent telemetry errors and LLM usage over-draft statistics.

---

## Summary Table: Route Security Policies

| Endpoint Prefix | Primary Middleware | Rate Limit Policy | Auth Required? |
| :--- | :--- | :--- | :--- |
| `/api/player/anonymous` | None | `rateLimitAnonymousPlayer()` | No |
| `/api/player/restore` | None | `rateLimitRecoveryRestore()` | No |
| `/api/cartridges/library/`| None | None | No |
| `/api/filesystem/` | None | None | No |
| `/api/assets/` | SVG-CSP Guard | None | No |
| `/api/player/:id/` | `ownsPlayer()` | `rateLimitStateChanges()` (30/min) | Yes |
| `/api/session/:id/turn` | `requireAuth` | `rateLimitTurns()` (10 burst, 30/min) | Yes |
| `/api/session/:id/stream`| `requireAuth` | `rateLimitSse()` | Yes |
| `/api/debug/*` | `debugRouteGuard` | None | Header key (Dev) / Blended (Prod) |
