# Backend Services Catalogue

All server business logic is organized into specialized domain services inside [packages/web-server/src/services/](../../packages/web-server/src/services/). Services coordinate transactions, interface with PGlite/Postgres, manage AI prompt templates, and materialize state changes.

---

## Service Architectural Domains

```text
  ┌────────────────────────────────────────────────────────┐
  │                   API & SSE Router Gates               │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌───────────────────────────▼────────────────────────────┐
  │                 Cartridge Library Domain               │
  │  - CartridgeLibraryService   - CartridgeImportApply   │
  │  - CartridgeImportPreview    - DefaultCartridgeBoot   │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌───────────────────────────▼────────────────────────────┐
  │                 Playthrough & Session Domain           │
  │  - SessionLifecycleService   - CartridgePlaythrough    │
  │  - SaveSlotService           - UniverseInstance        │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌───────────────────────────▼────────────────────────────┐
  │             Character, Systems & Ledger Domain         │
  │  - CharacterStateService     - HeroContinuityServices  │
  │  - InventoryReadService      - QuestDashboardService   │
  │  - PlayerStringsService      - NoticeJournalService    │
  └────────────────────────────────────────────────────────┘
```

---

## 1. Cartridge Library & Compilation Bridges

These services manage compiled Forge templates, run structural validations, and install static records into the database.

### [CartridgeLibraryService](CartridgeLibraryService.ts)
- **Primary Responsibility:** Exposes read-only views of the installed worlds registry, player heroes roster, and flat active playthrough listings for the boot gate interface. Handles world deletion.
- **Tables Read/Mutated:** Reads `cartridges`, `players`, `hero_cartridge_states`. Mutates `cartridges` (on deletion).
- **Transactional Behavior:** Runs standard read-only queries. Deletion cascading is governed by foreign key constraints in the database schema.

### [CartridgeImportPreviewService](CartridgeImportPreviewService.ts)
- **Primary Responsibility:** Creates and tracks asynchronous preflight dry-run tasks. Spawns the Forge filesystem compiler, parses output manifests, counts entity modifications, and logs validation failures.
- **Tables Read/Mutated:** Mutates `cartridge_import_preview_jobs` to track state (`processing`, `ready`, `failed`).
- **Transactional Behavior:** Non-blocking asynchronous reads. Writes job tokens using independent transactional writes to prevent compiling from blocking regular turn locks.

### [CartridgeImportApplyService](CartridgeImportApplyService.ts)
- **Primary Responsibility:** Commits a preflight-approved import job into active game tables. Mints the cartridge entity ledger and localized language indexes.
- **Tables Read/Mutated:** Mutates `cartridges`, `cartridge_records`, `entities` (static static records), `cartridge_meta_scoped`.
- **Transactional Behavior:** Wraps the entire apply run in a **single database transaction**. Aborts immediately if the drift gate catches a cartridge ID mismatch.

### [DefaultCartridgeBootstrapService](DefaultCartridgeBootstrapService.ts)
- **Primary Responsibility:** Verifies on server boot if a default world is present. If missing, compiles the bundled world folder and executes a silent background apply task.
- **Tables Read/Mutated:** Reads `cartridges`. Triggers `CartridgeImportApplyService`.
- **Transactional Behavior:** Initiates identical single-transaction commits on boot. Bypassed on subsequent starts if the database template is already provisioned.

### [CartridgeAssetManifestService](CartridgeAssetManifestService.ts)
- **Primary Responsibility:** Validates compiled asset lists. Computes SHA-256 binary signatures, hashes media resources, copies files to content-addressed folders, and writes scoped lookup registers.
- **Tables Read/Mutated:** Mutates `cartridge_meta_scoped` (`key = 'forge_visual_assets'`).
- **Transactional Behavior:** Commits the asset register at the final stage of the cartridge apply transaction.

### [ForgeBridgeArtifactsService](ForgeBridgeArtifactsService.ts)
- **Primary Responsibility:** Accesses precompiled compilation items and structural world files from the compiler's generated directory.
- **Tables Read/Mutated:** Read-only filesystem operations.

---

## 2. Playthrough & Session Lifecycle

These services govern active session turn enqueuing, narrative progression, coordinate tracking, and playthrough saves.

### [SessionLifecycleService](SessionLifecycleService.ts)
- **Primary Responsibility:** The central coordinator of active gameplay. Initializes player sessions, loads locations views, streams Server-Sent Events, dispatches turns to the queue, and interfaces with focused conversation brokers.
- **Tables Read/Mutated:** Reads and mutates `sessions`, `chat_messages`, `gui_events`, `turn_telemetry`.
- **Transactional Behavior:** Manages turns via the `withTransaction` coordinator. Orchestrates **turn enqueuing concurrency locks** (`SELECT FOR UPDATE` on player slots) to prevent out-of-order execution.

### [CartridgePlaythroughService](CartridgePlaythroughService.ts)
- **Primary Responsibility:** Handles hero parallel entry contracts. Coordinates continuity validations, boots active playthrough configurations, resets local state databases during new-game runs, and manages active session coordinate mirrors.
- **Tables Read/Mutated:** Mutates `hero_cartridge_states`, `players` (coordinates).
- **Transactional Behavior:** Resets playthrough metrics inside a single database transaction. Updates coordinate pointers atomically alongside player profile slots.

### [SaveSlotService](SaveSlotService.ts)
- **Primary Responsibility:** Mints and restores serialized database save slots. Saves complete active stats, quest milestones, relationship graphs, and inventory purser matrices.
- **Tables Read/Mutated:** Mutates `save_slots`. Reads/mutates `players`, `player_quests`, `inventory_entries`.
- **Transactional Behavior:** Writing a save slot locks the player record. Restoring a save runs inside a transaction, fully overwriting current state rows with the slot's stored JSON payload.

### [UniverseInstanceService](UniverseInstanceService.ts)
- **Primary Responsibility:** Guarantees each cartridge has a default universe row matching its content version.
- **Tables Read/Mutated:** Mutates `universe_instances`.
- **Transactional Behavior:** Executes thread-safe idempotent inserts (`INSERT ... ON CONFLICT DO NOTHING`), allowing parallel starts to safely resolve the same universe row.

---

## 3. Character Creator & Progression Systems

These services manage character creation stats, class setups, active inventories, logs, and quest progression logs.

### [CharacterService](CharacterService.ts) & [CharacterAssistService](CharacterAssistService.ts)
- **Primary Responsibility:** Manages core character profile changes. Interfaces with LLM cost surfaces to suggest portraits, backgrounds, class distributions, and polish freeform text histories during wizard steps.
- **Tables Read/Mutated:** Mutates `players`, `player_stats`.
- **Transactional Behavior:** Commits character parameters within standard player-locked transactions.

### [CharacterStateService](CharacterStateService.ts)
- **Primary Responsibility:** Renders detailed character cards, class proficiencies, XP requirements, level increases, and active status indicators.
- **Tables Read/Mutated:** Reads `players`, `player_stats`, `player_skills`, `xp_levels`.
- **Transactional Behavior:** Read-only HUD compiler.

### [InventoryReadService](InventoryReadService.ts)
- **Primary Responsibility:** Assembles detailed player inventory matrices, categorizes items, and checks item stats.
- **Tables Read/Mutated:** Reads `inventory_entries`, `entities` (static item templates).

### [PlayerIntroService](PlayerIntroService.ts)
- **Primary Responsibility:** Compiles localized initial narration blocks and splash screens when a character enters the world.
- **Tables Read/Mutated:** Reads `entities` (starting location metadata), `i18n_translations`.

### [PlayerStringsService](PlayerStringsService.ts)
- **Primary Responsibility:** Computes social relationship matrices (strings) between the hero and NPCs.
- **Tables Read/Mutated:** Reads `gui_events` (`event_type = 'string:changed'`).

### [QuestLogService](QuestLogService.ts) & [QuestDashboardService](QuestDashboardService.ts)
- **Primary Responsibility:** Manages quest states. Evaluates stage completions, prerequisites, quest items, and rewards, and compiles active HUD quest logs.
- **Tables Read/Mutated:** Reads and mutates `player_quests`, `player_journal_entries`.
- **Transactional Behavior:** Quest stage updates are executed atomically inside the active game turn transaction.

---

## 4. Parallel-Universe Travel Ledger

These services govern cross-world companion and item transportation registries.

### [HeroContinuityService](HeroContinuityService.ts)
- **Primary Responsibility:** Analyzes active hero profiles and builds travel maps. Separates portable metrics (`hero_core`) from world-bound statistics (`universe_local`).
- **Tables Read/Mutated:** Reads all progression, quest, relationship, and inventory tables. *Guaranteed read-only (no mutations).*

### [HeroContinuityCarryoverService](HeroContinuityCarryoverService.ts)
- **Primary Responsibility:** Executes the actual character transfer transaction when launching a playthrough under custom carryover policies.
- **Tables Read/Mutated:** Mutates `players`, `player_skills`, `player_stats`.
- **Transactional Behavior:** Runs as a **single isolated transaction** when initializing a playthrough, mapping assets safely to prevent character corruption.

### [HeroContinuityLedgerService](HeroContinuityLedgerService.ts)
- **Primary Responsibility:** Coordinates companion memory freezing and traveler items registries.
- **Tables Read/Mutated:** Mutates `hero_continuity_events`, `hero_portable_artifacts`, `hero_companion_bonds`, `hero_companion_capsules`, `companion_universe_projections`.
- **Transactional Behavior:** Saves traveler snapshots during universe transition steps, verifying active bonds before authorizing companion entry.

---

## 5. Bridges & State Materializers

These services resolve references, evaluate dynamic commands, and push Server-Sent Events to the client UI.

| Service | Primary Responsibility | Tables/Resources Managed |
| :--- | :--- | :--- |
| [AudioService](AudioService.ts) | Reads and serves loading quote tables and ambient track maps. | `audio_beds`, `quotes_pool` |
| [VisualAssetBridgeService](VisualAssetBridgeService.ts) | Resolves visual assets and verifies file boundaries. | `cartridge_meta_scoped` |
| [MaterializerBridgeService](MaterializerBridgeService.ts) | Materializes dynamic items and surface effects on turns. | `entities`, `runtime_fields` |
| [CurrencyBridgeService](CurrencyBridgeService.ts) | Processes gold increases and transaction ledgers. | `player_progression_wallets` |
| [CurrencyChangePlanner](CurrencyChangePlanner.ts) | Calculates optimal coin splits for merchant trades. | In-memory planning |
| [MerchantContractService](MerchantContractService.ts) | Evaluates shop catalogs, dynamic prices, and items. | `entities` (merchant parameters) |
| [SceneInstructionBridgeService](SceneInstructionBridgeService.ts) | Parses LLM instructions to alter background scenes. | `runtime_values` |
| [NoticeJournalService](NoticeJournalService.ts) | Appends milestones and notices to the narrative feed. | `player_journal_entries` |
| [CartridgeMediaScriptService](CartridgeMediaScriptService.ts) | Compiles soundscapes and trigger quotes from Obsidian. | `audio_beds` JSONB scoped maps |
| [MechanicI18nService](MechanicI18nService.ts) | Caches translated system vocabulary (stats, terms). | `i18n_translations` |
| [ProfileService](ProfileService.ts) | Updates player alignment, background, and features. | `players.metadata` |
| [WorldService](WorldService.ts) | Manages time-of-day progression and weather parameters. | `world_atmosphere` configuration |
| [QuoteService](QuoteService.ts) | Supplies randomized diegetic quotes for loading gates. | `quotes_pool` |
| [scopedBridgeMeta](scopedBridgeMeta.ts) | Decouples registry configurations from dynamic scopes. | Scoped JSON configurations |

---

## 6. Telemetry & Diagnostics

These services manage debug diagnostics, table counts, error tracing, and performance spans.

### [TelemetryIngestionService](TelemetryIngestionService.ts)
- **Primary Responsibility:** Receives and logs game metrics and LLM usage statistics.
- **Tables Read/Mutated:** Mutates `turn_telemetry`, `performance_spans`.
- **Transactional Behavior:** Employs asynchronous writes to prevent logging operations from slowing down turn processing.

### [DebugService](DebugService.ts) & [DebugDiagnosticsService](DebugDiagnosticsService.ts)
- **Primary Responsibility:** Coordinates developer tools. Resets database tables, mock-generates items, logs active specialist schemas, and outputs engine summaries.
- **Tables Read/Mutated:** Mutates all active runtime tables (when executing developer resets).
- **Transactional Behavior:** Requires an active `X-Debug-Key` header. Deactivated in production.

### [HealthService](HealthService.ts)
- **Primary Responsibility:** Supplies database connection indicators and table row counts.
- **Tables Read/Mutated:** Queries table names from `information_schema` / SQLite catalog.
- **Transactional Behavior:** Read-only health checker. Bypasses transaction locking.
