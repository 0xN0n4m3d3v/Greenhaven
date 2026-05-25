# What Greenhaven Is

Greenhaven is a local-first narrative RPG engine and game prototype. The
playable cartridge is Quickgrin Lane: a dense adult LitRPG scene with NPCs,
locations, quests, inventory, combat, intimacy, language packs, and dynamic
adventure hooks.

Greenhaven uses parts of the original monorepo shape, but the active product is
the game stack in `packages/web-server`, `packages/web-ui`, and
`packages/desktop-electron`.

## What It Is

- **Narrative game runtime.** Player prose becomes intent. State changes become
  canon only through validated tools and deterministic systems.
- **Two-stage model flow.** The broker owns mechanics and tool calls; the
  narrator owns visible prose. Cheap narrator-only routes handle ambient turns.
- **Role-scoped prompts.** `greenhaven.md` is common identity/rules. Broker mode
  fragments live in `prompts/broker/`; narrator rules live in
  `greenhaven.narrator.md`.
- **Tool-first state.** Dice, movement, inventory, quests, memories, strings,
  surfaces, companions, and narration all use registered tools with audit rows.
- **Specialist-backed safety.** Combat Director, Intimacy Coordinator, Quest
  Watcher, Voice Warden, Movement Warden, Cartridge Steward, and others narrow
  the reasoning load without replacing the broker contract.
- **Durable presentation.** Chat-visible events use `gui_events`, turn queues,
  and post-turn presentation slots so asynchronous systems replay in order.
- **Shared dialogue.** One focused `dialogue_partner_id` remains for backward
  compatibility, while `players.metadata.dialogue_participants` carries
  nearby NPCs and companions for multi-speaker scenes. Manual end-dialogue UI
  is gone; server intent rules switch or release focus.
- **Adventure opportunities.** The oracle/materializer pipeline creates durable
  ready hooks. Accept/ignore actions now submit ordinary turns so NPCs or the
  world answer immediately and consequences can be recorded.
- **Local-first desktop.** Electron packages the built server and UI, stores
  user data under AppData by default, and keeps diagnostics local.

## Design Pillars

1. **Voice equals author.** NPC speech belongs to the NPC author; place/scene
   narration belongs to the narrator/location. Voice Warden rejects mismatches.
2. **Movement is mechanical.** Prose cannot move the player unless `move_player`
   has changed the location state.
3. **Dice decide contested outcomes.** Combat impact requires a visible d20 and
   successful mechanical resolution before `damage`.
4. **Reuse before spawn.** The engine searches current world facts and validates
   ownership/access before creating new canon.
5. **Current player is explicit.** Player mutations use `ctx.playerId` or
   numeric entity ids, not placeholder protagonist names.
6. **Selected language wins.** UI, mechanics, cartridge text, and generated
   visible prose follow the active player language contract.

## Current Feature Map

- **Character creation:** unified full-sheet creator with AI polish and
  sheet-based card synthesis.
- **Runtime world:** PGlite/Postgres schema, migrations, cartridge i18n packs,
  runtime field overlays, inventory/currency, save slots.
- **Turn system:** classifier, prompt-fragment loader, role toolsets, broker
  retry/fail-open, narrator quarantine, synth fallback, queue recovery.
- **Questing:** authored quests plus adventure oracle/materializer/situation
  integrity pipeline.
- **Living world:** location memory, first-entry bubbles, dense topology,
  deterministic NPC agency, actor status presence gating, companions, and
  shared dialogue participants.
- **Diagnostics:** support smoke, performance events, local telemetry lake,
  transcript diagnostics, telemetry bundle/export commands.
- **Frontend:** React 19/Vite UI, durable EventCards, chat-centered shell,
  current opportunities rail, map/modal surfaces, client storage manager,
  language picker, telemetry hooks.

## Sources

- [packages/web-server/src/turnRunnerV2.ts](../packages/web-server/src/turnRunnerV2.ts)
- [packages/web-server/src/ai/prompts.ts](../packages/web-server/src/ai/prompts.ts)
- [packages/web-server/src/ai/toolsets.ts](../packages/web-server/src/ai/toolsets.ts)
- [packages/web-server/src/postTurnPipeline.ts](../packages/web-server/src/postTurnPipeline.ts)
- [packages/web-ui/src/bridge/](../packages/web-ui/src/bridge/)
- [packages/desktop-electron/](../packages/desktop-electron/)
