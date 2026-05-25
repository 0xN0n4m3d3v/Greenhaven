# Run Locally

Greenhaven is a TypeScript monorepo with a Hono backend (`packages/web-server`),
a Vite + React frontend (`packages/web-ui`), and an Electron desktop shell
(`packages/desktop-electron`). The backend runs against Postgres when
`DATABASE_URL` is set and otherwise uses local PGlite data.

## Required Env

Set backend variables in `packages/web-server/.env`. Start from
[`packages/web-server/.env.example`](../../packages/web-server/.env.example) and
fill in local secrets before running the backend.

| Var                                         | Value              | Why                                                                |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| `DEEPSEEK_API_KEY` or `FEATHERLESS_API_KEY` | API key            | At least one model provider is required.                           |
| `AUTH_SECRET`                               | Long random string | HMAC key for the `gh_player` cookie. Use a dev-only value locally. |

## Useful Optional Env

| Var                         | Default            | Effect                                    |
| --------------------------- | ------------------ | ----------------------------------------- |
| `GEMINI_WEB_PORT`           | `7777`             | Backend HTTP port.                        |
| `DATABASE_URL`              | unset              | Uses Postgres when set; otherwise PGlite. |
| `PGLITE_DATA_DIR`           | `<server>/pgdata/` | Overrides local PGlite storage. The default `packages/web-server/pgdata/` is disposable dev catalog and is ignored by git via `**/pgdata/` / `**/pgdata-*/`. Point it at an isolated temp root for smoke / playtest runs, or at an AppData / portable folder for desktop builds. |
| `GREENHAVEN_BROKER_MODEL`   | provider default   | Overrides broker model id.                |
| `GREENHAVEN_NARRATOR_MODEL` | provider default   | Overrides narrator model id.              |
| `AUTH_DISABLED`             | unset              | Set `1` for local auth bypass only.       |

## Backend Dev

```sh
cd packages/web-server
npm install
npm run dev
```

`npm run dev` starts `tsx watch --env-file=.env src/index.ts`. On boot the
server loads env, connects to PGlite/Postgres, applies all ordered migrations
through the latest SQL file in `packages/web-server/migrations` (currently
`0101_mikka_portrait_set.sql`), mounts Hono routes, and listens on `:7777` by
default.

Health checks:

```sh
curl http://localhost:7777/api/health
curl http://localhost:7777/api/db/health
```

## Frontend Dev

```sh
cd packages/web-ui
npm install
npm run dev
```

Vite serves on `:5173` and proxies `/api/*` to `http://localhost:7777`.

## Desktop Dev And Build

```sh
npm run build:greenhaven-desktop
npm --prefix packages/desktop-electron run dev
npm run dist:greenhaven-win-dir
npm run dist:greenhaven-win
```

The Electron package builds backend and frontend assets first. Desktop game data
is stored under the app data directory, not the repo `pgdata` directory.

## Resetting Local State

Use `POST /api/debug/reset-world` to drop dynamic world state while keeping the
seed cartridge. See [reset-and-seed.md](reset-and-seed.md).

For a full local PGlite wipe, stop the backend, delete
`packages/web-server/pgdata/` with PowerShell or Explorer, then restart the
server. Migrations reapply on boot. The folder is disposable local
state (gitignored under `**/pgdata/`), so wiping it is safe; the only
caveat is that any chat history, save slots, or dynamic entities in
that catalog go with it.

## Sources

- [packages/web-server/package.json](../../packages/web-server/package.json)
- [packages/web-ui/package.json](../../packages/web-ui/package.json)
- [packages/desktop-electron/package.json](../../packages/desktop-electron/package.json)
- [packages/web-server/src/migrate.ts](../../packages/web-server/src/migrate.ts)
