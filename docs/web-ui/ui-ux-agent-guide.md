# UI/UX Agent Guide

This is the working guide for an agent editing Greenhaven's visual web game:
layout, UX flows, GUI state, event cards, styling, motion, and frontend/server
contracts. Read it before changing `packages/web-ui`.

## Scope

The active visual client is [packages/web-ui](../../packages/web-ui), a Vite +
React 19 SPA. It is used both in browser dev mode and inside the Electron
desktop shell. The UI is not a marketing site; it is the playable game surface:
chat timeline, world rails, action composer, dice, system cards, character
creator, settings, and adventure opportunities.

Primary files:

- [src/App.tsx](../../packages/web-ui/src/App.tsx) - state wiring and top-level
  handlers.
- [src/components/GameScreen.tsx](../../packages/web-ui/src/components/GameScreen.tsx)
  - visible gameplay shell.
- [src/App.css](../../packages/web-ui/src/App.css) - main visual tokens, layout,
  and component styling.
- [src/style.css](../../packages/web-ui/src/style.css) - document root,
  viewport, fonts, base chat typography.
- [src/styles/rpg-frame.css](../../packages/web-ui/src/styles/rpg-frame.css) -
  reusable RPG frame utilities.
- [src/bridge](../../packages/web-ui/src/bridge) - HTTP/SSE bridge.
- [src/hooks](../../packages/web-ui/src/hooks) - UI state effects.

## Visual Product Model

Greenhaven is a dark LitRPG chat interface with brass, parchment, teal, rust,
bruise-purple, and ember accents. The interface should feel like a playable RPG
dashboard, not a flat chatbot:

- Chat is the primary surface.
- Server-authored state cards are part of the narrative timeline.
- Rails show actionable world state, not decoration.
- The composer is the player's command line into the world.
- Motion, dice, mood pulses, and ambient effects support feedback, but must not
  become required for understanding state.

Avoid pure black/white, generic SaaS cards, oversized landing-page composition,
and UI text that explains implementation details.

## Screen Anatomy

`GameScreen` renders the core shell:

```text
game-shell
  contact-rail        desktop left rail / mobile popover drawer
  chat-stage
    ChatHeader        current location, scene, nearby NPC shortcuts
    SceneSurfaceStrip active environmental surfaces
    DialogueBanner    focused NPC dialogue state, no manual end button
    MessageFlow       chat bubbles + EventCards + pending stream
    ChatComposer      player input and submit action
```

Rail content includes locations, hero vitals, currency, player state,
companions, nearby NPCs, reset, and settings. On mobile the rail is hidden from
the grid and reappears as a popover drawer; desktop uses a two-column grid.

## Styling System

CSS variables in `App.css` are the visual ABI. New visual work should use
existing tokens before adding new ones:

- surface tokens: `--background`, `--card`, `--popover`, `--border`;
- accent tokens: `--primary`, `--ember`, `--moss`, `--bruise`, `--rust`;
- type tokens: `--font-serif-prose`, `--font-serif-display`, `--font-sans`,
  `--font-mono`;
- persona tokens: `--persona-hue-*`;
- dice/scrollbar tokens for game chrome.

Keep layout rules stable:

- `game-shell` owns viewport height with `100dvh` fallback behavior.
- `chat-stage` is a container query context named `chat`.
- `message-flow` is the scroll root; preserve `min-height: 0` and
  `overscroll-behavior`.
- Chat bubbles must wrap long Cyrillic, URLs, and generated prose with
  `overflow-wrap`.
- Touch targets should stay near 40-44px minimum.

Use `lucide-react` icons where possible. Respect `prefers-reduced-motion` with
CSS media queries or `useReducedMotion()`.

## Component Ownership

Use the feature directories under
[src/components](../../packages/web-ui/src/components):

| Directory    | Owns                                                                |
| ------------ | ------------------------------------------------------------------- |
| `chat`       | MessageFlow, ChatComposer, EventCard, bubbles, mentions, streaming. |
| `rail`       | hero state, locations, currency, player state rail.                 |
| `npc`        | nearby NPCs, portraits, partner switching.                          |
| `adventure`  | opportunity rail/cards and accept/ignore controls.                  |
| `character`  | full-sheet creator, AI polish, card review, commit path.            |
| `scene`      | scene breaks, surfaces, scene/location presentation.                |
| `atmosphere` | mood/ambient visual and audio effects.                              |
| `modals`     | settings, recovery, debug/character overlays.                       |
| `ui`         | low-level reusable primitives.                                      |

Do not put feature logic into `components/ui`. Keep bridge calls out of leaf
visual components unless the existing feature already owns that action.

## Server Interaction Model

The frontend does not talk to the database. It talks to the Hono server through
the bridge:

- HTTP helpers live in [bridge/api.ts](../../packages/web-ui/src/bridge/api.ts).
- Bootstrap/session ownership lives in
  [bridge/bootstrap.ts](../../packages/web-ui/src/bridge/bootstrap.ts).
- Turn jobs live in
  [bridge/turnJobs.ts](../../packages/web-ui/src/bridge/turnJobs.ts).
- SSE live stream lives in
  [bridge/sseClient.ts](../../packages/web-ui/src/bridge/sseClient.ts).
- Durable event replay lives in
  [bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts).

Important endpoints:

- `POST /api/session/:id/turn` submits a player command.
- `GET /api/session/:id/stream` is the live SSE stream.
- `GET /api/session/:id/events` replays durable GUI events.
- `GET /api/session/:id/turn-queue` rehydrates queued/running turns.
- `POST /api/session/:id/cancel` cancels a turn.
- `/api/player/:id/adventures` drives current opportunity cards.

The bridge intentionally keeps a Wails-compatible API shape because older UI
code imports generated model types and `wailsjs/go/main/App` functions.

## Turn And Timeline UX

Turn submission is queue-backed:

1. `ChatComposer` calls `useTurnSubmission`.
2. `bridge/turnJobs.ts` posts to `/turn`.
3. If the server returns `visible=false`, show a compact queued status only. Do
   not append a fake player bubble.
4. `message:created` commits the real player bubble with server `messageId`.
5. `content` deltas update a transient streaming bubble.
6. `narrate` finalizes the assistant/NPC/narrator bubble.
7. `turn.end` unlocks the composer and terminalizes the job.
8. Post-turn `gui_events` release as ordered EventCards.

Never sort chat-visible system events by arrival time. Use server `releaseSeq`
first, then `eventId`. This preserves post-turn presentation barriers and replay
consistency.

## EventCard Contract

Anything that should be a durable timeline card must use the system-event path:

1. Server emits a durable `gui_events` row and/or legacy SSE.
2. `eventTimeline.ts` allows the type through `SYSTEM_EVENT_TYPES`.
3. `sseClient.ts` normalizes payloads and emits `system:event`.
4. `useSystemEvents` merges/dedupes by event identity.
5. `MessageFlow` renders the card through
   [EventCard.tsx](../../packages/web-ui/src/components/chat/EventCard.tsx).

When adding a card type, update:

- server event type and payload;
- `SYSTEM_EVENT_TYPES`;
- `EventCard` rendering and localization keys;
- docs in [event-cards.md](event-cards.md);
- replay/order tests or fixture if ordering matters.

## State And Hooks

`GameState` comes from
[src/types/app.ts](../../packages/web-ui/src/types/app.ts) and mirrors generated
backend model shapes. Keep UI state normalized and feature-owned:

- `useGameBootstrap` owns load/retry and pending-turn recovery.
- `useTurnSubmission` owns submit/continue/result application.
- `useSseSubscriptions` connects bus events to `App.tsx` state setters.
- `useSystemEvents` owns durable card merge state.
- `useMentionTargets` merges known entities and action affordances.
- `useLocationUpdates` updates location summaries after movement.
- `useRuntimeFields` exposes reactive runtime fields.
- `useAmbientBed`, `useMoodPulse`, and `useReducedMotion` own sensory effects.

Do not add scattered `localStorage` calls. Use
[src/lib/clientStorage.ts](../../packages/web-ui/src/lib/clientStorage.ts) and
registered `CLIENT_STORAGE_KEYS`.

## UX Rules

- Preserve server authority for state. UI can suggest actions, but canon changes
  come from tools and server events.
- Keep queued turns visibly queued and uncommitted until the server creates the
  player message.
- Keep system cards standalone in the timeline; do not fold quest/memory/dice
  changes into prose bubbles.
- Use selected UI/game language for visible labels and action text.
- Keep author identity visible: narrator, NPC, player, and system cards must be
  distinguishable.
- Make rail actions repeatable and disabled while busy.
- Avoid layout shifts from streaming text, long names, or translated labels.
- Check desktop and mobile widths whenever changing shell/grid/composer styles.
- Do not make motion the only state indicator.

## Common Change Recipes

### Add A New Server Event Card

Update server `gui_events` emission, add the type to `SYSTEM_EVENT_TYPES`,
render it in `EventCard`, add translations, and extend docs/tests. Verify live
SSE and `/api/session/:id/events` replay produce identical order.

### Add A New Rail Widget

Put feature UI in `components/rail` or the owning feature directory. Source its
data from `GameState`, bridge HTTP, or runtime bus hooks. Keep the widget
compact and resilient to missing data because state can rehydrate mid-turn.

### Add A New Player Action Button

Prefer existing affordance/action flows. The button should call `onRunAction` or
an existing bridge function, disable while busy, and use localized action text.
Do not mutate local game state optimistically unless the server will confirm it
through SSE or refreshed state.

### Change Layout Or Theme

Start with `App.css` tokens and the shell classes. Verify:

- 390px phone width;
- 768px tablet breakpoint;
- 1280px desktop;
- reduced-motion mode;
- long Cyrillic/Arabic text and long entity names;
- scroll behavior after 50+ messages.

## Agent Editing Checklist

Before editing:

- Read this guide, [architecture.md](architecture.md),
  [sse-flow.md](sse-flow.md), and [event-cards.md](event-cards.md).
- Identify the owning directory and hook.
- Check whether the behavior is server-owned, bridge-owned, hook-owned, or
  component-owned.

While editing:

- Keep changes scoped to the owning feature.
- Use existing CSS tokens and component conventions.
- Add localization keys for visible strings.
- Preserve `releaseSeq`/`eventId` ordering and queued-turn semantics.
- Respect reduced motion and mobile layout.

After editing:

```sh
npm --prefix packages/web-ui run build
npm --prefix packages/web-ui run i18n:check
```

For event/timeline changes, also run the relevant server support or regression
harness from `packages/web-server` and manually replay a session after reload.

## Sources

- [docs/web-ui/architecture.md](architecture.md)
- [docs/web-ui/sse-flow.md](sse-flow.md)
- [docs/web-ui/event-cards.md](event-cards.md)
- [docs/web-ui/components.md](components.md)
- [packages/web-ui/src/App.tsx](../../packages/web-ui/src/App.tsx)
- [packages/web-ui/src/components/GameScreen.tsx](../../packages/web-ui/src/components/GameScreen.tsx)
- [packages/web-ui/src/bridge/eventTimeline.ts](../../packages/web-ui/src/bridge/eventTimeline.ts)
- [packages/web-server/src/postTurnPipeline.ts](../../packages/web-server/src/postTurnPipeline.ts)
