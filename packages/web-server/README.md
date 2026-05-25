# Greenhaven - web-server

Hono backend for the local Greenhaven game runtime. It owns session state,
turn routing, cartridge import/runtime, tools, prompts, telemetry, and the
PGlite/Postgres database used by the web UI and Electron shell.

## Quick Start

The server uses PGlite by default: Postgres compiled to WebAssembly and running
in-process. Database files live in `./pgdata/` next to the package by default;
this is disposable local state and is ignored by git.

```bash
npm install
npm --prefix packages/web-server run dev
```

Useful checks:

```bash
curl http://127.0.0.1:7777/api/health
curl http://127.0.0.1:7777/api/db/health
npm --prefix packages/web-server run typecheck
npm --prefix packages/web-server run build
```

## Database

Fresh databases start from `baseline/0001_engine_baseline.sql`; historical
pre-baseline SQL remains archived under `migrations/archive-prebaseline/` for
baseline regeneration and migration tests. New schema changes are forward-only
SQL files in `migrations/*.sql`.

## Runtime Surface

- `src/index.ts` mounts the Hono API.
- `src/turnRunnerV2.ts` owns the main turn flow.
- `src/tools/` contains validated game tools.
- `src/services/` contains read/write domain services.
- `src/scripts/` contains smoke, cartridge, telemetry, and packaging helpers.

Runtime state, provider keys, logs, and generated build output must stay local.
