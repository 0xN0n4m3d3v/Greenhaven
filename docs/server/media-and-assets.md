# Media & Assets System Architecture

Greenhaven handles audio, music, ambient beds, and visual asset materials (portraits, locations, maps) via a decentralized caching system. Media references are compiled into asset manifests during cartridge import, copied into a content-addressed storage repository, and streamed safely using Hono routes protected by security-hardened headers.

---

## 1. Scoped Cartridge Asset Cache

To decouple the server's engine from static files in local development vaults, all media files are copied and content-addressed when a cartridge is applied.

### Compiling Visual Assets
1. **Source Manifest:** The compiled Forge project includes an `audit/visual-assets.jsonl` manifest, cataloging all visual declarations (NPC portraits, location backgrounds, card imagery) and their relative source paths.
2. **Hash & Copy:** [CartridgeAssetManifestService](../../packages/web-server/src/services/CartridgeAssetManifestService.ts) parses the manifest. For each referenced file:
   - It reads the binary bytes and calculates the SHA-256 content hash.
   - It copies the file to the deterministic, content-addressed location:
     ```text
     <data-directory>/cartridges/<cartridge-id>/assets/<sha-256-hash>.<extension>
     ```
   - If the file already exists in the cache, the copy is bypassed, ensuring rapid reimports.
3. **Database Scoped Manifest:** The service commits the mapped associations to `cartridge_meta_scoped` (where `key = 'forge_visual_assets'`) using the `greenhaven.cartridge_assets.v1` JSONB schema.

### Reimport & Deletion Invariant
The scoped manifest is **authoritative across reimports**:
- If a reimport drops an asset, the new manifest replaces the old row. Stale database pointers are automatically broken so that deleted media can no longer be resolved.
- Image bytes are never stored directly in SQL columns; the database only holds SHA-256 references.

---

## 2. Secure Asset Streaming Route Contracts

Visual assets are streamed to client browsers via Hono endpoint bridges that protect against directory traversal and malicious script execution.

```text
Browser <img src="...">
  │
  ├── GET /api/assets/cartridges/:cartridgeId/world/:kind/:slug/:role?
  │
  ├── [VisualAssetBridgeService] 
  │     ├── 1. Validate ASCII slug (No traversal / No ".." / No "/").
  │     ├── 2. Validate Extension allowlist (.png, .jpg, .jpeg, .webp, .svg).
  │     └── 3. Query Scoped Manifest (cartridge_meta_scoped).
  │
  ├── [Fails Check] ──> Returns 404 (sanitized response)
  │
  └── [Passes Check] ─> Stream file with:
                        ├── X-Content-Type-Options: nosniff
                        └── CSP Sandbox Headers (If SVG)
```

### Endpoints
- **`GET /api/assets/cartridges/:cartridgeId/world/:kind/:slug/:role?`**:
  Queries the scoped manifest of the target cartridge, resolves the SHA-256 hash, and streams the asset directly from the cache directory.
- **`GET /api/assets/world/:kind/:slug/:role?`**:
  Legacy fallback wrapper. If the default cartridge has an installed scoped manifest, it resolves through it. If not, it falls back to streaming directly from the local developer directories for convenient testing without a database.

### Security Hardening Standards (`OWV-17`)
Both routes enforce rigid security checks to neutralize malicious client vectors:
1. **ASCII Path Bounds:** The `:kind`, `:slug`, and `:role` params are validated against strict regex expressions. Any characters resembling directory traversals (`..`, `/`, `\`) or non-ASCII boundaries are immediately rejected (emits `404 unknown_asset`).
2. **Extension Allowlist:** The server only streams files matching a hard allowlist: `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`. Unknown extensions trigger an immediate block.
3. **No-Sniff Header:** Every response emits `X-Content-Type-Options: nosniff` to prevent browsers from executing script payloads masquerading as images.
4. **SVG Content-Security-Policy (CSP):** Because SVG files can carry malicious inline JavaScript (XSS vectors), streaming an `image/svg+xml` asset injects a highly restrictive sandbox CSP header:
   ```http
   Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox
   ```

---

## 3. Media Scripts & SSE Materialization Flow

Greenhaven uses dynamic trigger scripts to alter scene mood, play ambient soundscapes, and render visual effects in real time.

```text
Player Action ──> Turn Pipeline ──> [CartridgeMediaScriptService]
                                             │
                                             ├── Match directive tag triggers
                                             │
                                             ▼
                                     [MaterializerBridge]
                                             │
                                             ├── 1. Commit state changes
                                             ├── 2. Fire transition event
                                             │
                                             ▼
                                      SSE Stream Broadcast
                                        ├── media:music
                                        ├── media:shown
                                        └── materializer:applied
```

### Compiling Soundscapes
Audio configs are compiled by [CartridgeMediaScriptService](../../packages/web-server/src/services/CartridgeMediaScriptService.ts).
- Authors declare ambient loops and trigger quotes under `audio/ambient-beds.jsonl` and `audio/dialogue-quotes.jsonl` in their Obsidian vaults.
- The service maps audio trigger tags (`music:combat`, `ambient:rain`) to file pathways in the audio catalog, which the client consumes via the `useAmbientBed` hook on `GET /api/audio/ambient`.

### Dynamic SSE Event Broadcasts
During turn execution, when the player's text or actions trigger a state change (e.g. entering a burning room, starting combat, or talking to a companion):
1. **Trigger Evaluation:** The turn runner queries `CartridgeMediaScriptService` to check if the new location or dialogue state has registered directive media tags.
2. **Bridges & State Materialization:**
   - **`VisualAssetBridgeService`** resolves the required graphics.
   - **`MaterializerBridgeService`** checks if environmental surface effects (like surfaces, weather shifts, or UI overlays) should engage.
3. **SSE Envelope Dispatch:** The events are serialized and pushed immediately to the client over the Server-Sent Events stream:
   - **`media:music`**: Commands the client's audio player to crossfade to a new musical track or trigger an ambient bed loop.
   - **`media:shown`**: Triggers the rendering of new illustration cards or NPC portraits.
   - **`materializer:applied`**: Instructs the user interface to render temporary overlay effects (e.g., overlaying a poison shroud, flame ripples, or status badges).
