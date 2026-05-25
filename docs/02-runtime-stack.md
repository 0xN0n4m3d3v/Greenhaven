# Runtime Stack

## Server Runtime

- **Node + Hono**: HTTP API in `packages/web-server/src/index.ts`.
- **TypeScript ESM**: package type is `module`; relative imports use `.js`.
- **Vercel AI SDK v6**: `streamText`, `generateText`, tool calls, and provider
  telemetry.
- **Providers**: DeepSeek through `@ai-sdk/deepseek`; Featherless through
  OpenAI-compatible provider.
- **Zod**: every registered tool owns a Zod input schema.
- **AsyncLocalStorage**: `runWithContext()` carries `sessionId`, `playerId`,
  `turnId`, abort signal, transaction context, tool history, and SSE buffering.
- **PGlite/Postgres**: PGlite for local/desktop, `pg.Pool` when `DATABASE_URL`
  is set.
- **Local telemetry**: `performance_events` and telemetry-lake tables capture
  turn, LLM, tool, frontend, Electron, and support diagnostics.

## Frontend Runtime

- **Vite 8 + React 19** in `packages/web-ui`.
- **Tailwind CSS 4** and Radix primitives for UI.
- **Motion, Howler, Dice Box, Fontsource** for animation, audio, dice, and local
  fonts.
- **Runtime bus**: bridge adapters publish events through `EventsEmit` /
  `__emit`; hooks own state updates.
- **Client storage manager**: `CLIENT_STORAGE_KEYS` centralizes all
  `greenhaven.*` localStorage keys and stale identity cleanup.

## Desktop Runtime

`packages/desktop-electron` builds an offline-first Windows desktop app. The
Electron main process starts the built Hono server, serves the built UI from the
same origin, configures local PGlite data, creates an auth secret, mirrors logs,
and stores user-owned config/data under `%APPDATA%/GreenHaven` by default.

Portable colocated data remains opt-in through `GREENHAVEN_PORTABLE_DATA=1`.

## DB Backend Selection

- `DATABASE_URL` set: use Postgres via `pg.Pool`.
- `DATABASE_URL` unset: use PGlite at `PGLITE_DATA_DIR` or the package-local
  `pgdata`.
- Desktop clears inherited `DATABASE_URL`/`AUTH_DISABLED` so packaged play uses
  local PGlite and real cookie auth.

Migrations are ordered SQL files under `packages/web-server/migrations`. Current
active set runs through `0101_mikka_portrait_set.sql`.

## Model Providers

`buildProviders()` creates broker and narrator slots. Environment/model
selection is role-based:

- `GREENHAVEN_BROKER_MODEL`
- `GREENHAVEN_NARRATOR_MODEL`
- `FEATHERLESS_API_KEY`
- `DEEPSEEK_API_KEY`

The broker prompt and toolset are selected by mode. The narrator and Scene
Painter receive only the executable `narrate` tool.

## Commands

```sh
npm --prefix packages/web-server run dev
npm --prefix packages/web-ui run dev
npm --prefix packages/web-server run build
npm --prefix packages/web-ui run build
npm --prefix packages/desktop-electron run dist:win-dir
```

## Sources

- [packages/web-server/package.json](../packages/web-server/package.json)
- [packages/web-ui/package.json](../packages/web-ui/package.json)
- [packages/desktop-electron/package.json](../packages/desktop-electron/package.json)
- [packages/web-server/src/ai/providers.ts](../packages/web-server/src/ai/providers.ts)
- [packages/web-server/src/db.ts](../packages/web-server/src/db.ts)
