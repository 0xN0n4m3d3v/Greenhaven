# Greenhaven Documentation

This folder is the Greenhaven documentation set for the current game, server,
frontend, cartridge pipeline, desktop runtime, and operations.

Greenhaven is a 21+ LitRPG narrative game. A player writes free text, the server
classifies the turn, broker/narrator model stages call validated tools, and a
React UI renders streamed narration plus durable system cards.

## Current Status

- Latest numbered specs in the roadmap currently run through Spec 145, with
  active work around living-world location memory, first-entry bubbles, dense
  place topology, deterministic NPC agency, and UI gamification redesign.
- Spec 112 remains the long-running anti-god-layer cleanup thread; later specs
  are concrete slices that keep moving responsibilities out of broad runner,
  prompt, bridge, and cartridge surfaces.
- Desktop packaging exists as an Electron app with AppData-backed local state.
- Active migrations currently run through `0101_mikka_portrait_set.sql`.
- The prompt system is role-scoped: common prompt, broker fragments, narrator
  prompt, narrator-only toolsets, and conditional fragments such as companion
  rules.
- Dialogue is now intent-driven: there is no manual "end dialogue" UI control.
  Server focus changes through address/travel/action/farewell intent, while
  active companions can persist as shared-chat participants across movement.
- Adventure opportunities are durable queue rows. Accept/ignore from chat use
  the ordinary turn path so the NPC/world can immediately answer the player's
  choice.

## Reading Order

1. [What Greenhaven is](00-overview.md)
2. [Architecture](01-architecture.md)
3. [Runtime stack](02-runtime-stack.md)
4. [Turn pipeline](server/turn-pipeline.md)
5. [Session lifecycle](server/session-lifecycle.md)
6. [Tool system](server/tool-system.md)
7. [Database and migrations](server/db-and-migrations.md)
8. [Specialists overview](agents/00-overview.md)
9. [Prompt system](prompts/greenhaven-md.md)
10. [Web UI architecture](web-ui/architecture.md)
11. [UI/UX agent guide](web-ui/ui-ux-agent-guide.md)
12. [Run locally](ops/run-locally.md)
13. [Documentation refresh log](ops/documentation-refresh.md)

## Server

- [Session lifecycle](server/session-lifecycle.md) - auth, owned sessions, SSE,
  queue-backed turns, pending-turn recovery.
- [Turn pipeline](server/turn-pipeline.md) - classifier, context, prompt/tool
  scoping, broker/narrator stages, post-turn barrier.
- [Tool system](server/tool-system.md) - Zod schemas, shared dispatch, audit,
  validators, batch transactions.
- [SSE events](server/sse-events.md) - live stream, durable GUI outbox, replay,
  presentation slots.
- [Database and migrations](server/db-and-migrations.md) - PGlite/Postgres
  selection and migration groups.

## Product And Gameplay

- [Player overview EN](product/greenhaven-player-overview.md)
- [Player overview RU](product/greenhaven-player-overview.ru.md)
- [Voice and author](design/voice-and-author.md)
- [Combat](design/combat.md)
- [Intimacy](design/intimacy.md)
- [Adventure queue](design/adventure-queue.md)

## Content Authoring

- [Cartridge authoring](cartridge/authoring-guide.md)
- [Quest recipes](cartridge/quest-recipes.md)
- [Sex moves](cartridge/sex-moves.md)
- [Persona and voice](cartridge/persona-and-voice.md)

## Frontend

- [Architecture](web-ui/architecture.md)
- [UI/UX agent guide](web-ui/ui-ux-agent-guide.md)
- [Components](web-ui/components.md)
- [SSE flow](web-ui/sse-flow.md)
- [Event cards](web-ui/event-cards.md)
- [Adventure cards](web-ui/adventure-cards.md)

## Operations

- [Run locally](ops/run-locally.md)
- [Documentation refresh log](ops/documentation-refresh.md)
- [Desktop distribution](ops/desktop-distribution.md)
- [Reset and seed](ops/reset-and-seed.md)
- [Cost and telemetry](ops/cost-and-telemetry.md)
- [Developer diagnostics](ops/developer-diagnostics.md)
- [Support smoke](ops/support-smoke.md)
- [Multilingual support](ops/multilingual.md)

## Reference

- [Tool reference](tools/reference.md)
- [Database schema](db/schema.md)
