# Desktop distribution

GreenHaven's desktop target is an offline-first Electron app.

## Decision

Keep PGlite for the first distributable build. Do not replace it with SQLite
during packaging work.

The backend already uses PostgreSQL/PGlite deeply: JSONB columns and operators,
`RETURNING`, `ILIKE`, `BIGSERIAL`, partial `ON CONFLICT`, SQL functions, and
the `vector` memory schema. Moving to SQLite would be a separate database-port
project, not a shortcut to distribution.

PGlite gives the important distribution property already: no external Postgres
install. The app only needs to point `PGLITE_DATA_DIR` at the selected local
data folder.

## Data Layout

Normal desktop builds store player-owned data in Electron `userData`.

Windows default:

```text
%APPDATA%/GreenHaven/
  pgdata/
  config/
  saves/
  logs/
  backups/
  boot-state.json
  telemetry/
    artifacts/
      bundles/
      crashes/
      netlog/
      logs/
```

This survives app updates and works even when the executable is installed under
`C:\Program Files`.

`config/auth-secret` is created automatically on first launch and is used to
sign the local `gh_player` cookie. It is user data, not bundled application
data.

Optional provider keys live in `config/greenhaven.env`:

```text
DEEPSEEK_API_KEY=...
FEATHERLESS_API_KEY=...
```

The file is local player/operator config. Do not place provider keys in the app
bundle.

Backend/main-process diagnostics are written to `logs/desktop.log`.
Renderer console messages are mirrored there too, so packaged UI failures can
be diagnosed without opening Electron devtools.

`boot-state.json` stores local launch state such as the title-screen rotation
counter. It follows the selected data root: AppData for normal installs and
`GreenHavenData` for portable mode.

Local telemetry artifacts live under `telemetry/artifacts/`. Electron keeps
crash dumps there with upload disabled, indexes `logs/desktop.log`, and can
write on-demand netLog files under `telemetry/artifacts/netlog/`.

## Portable Override

Portable colocated data is explicit:

```text
GREENHAVEN_PORTABLE_DATA=1
<dirname(GreenHaven.exe)>/GreenHavenData/
  pgdata/
  config/
  saves/
  logs/
  backups/
  boot-state.json
  telemetry/
```

If portable mode is requested and `GreenHavenData` is not writable, the app
must fail clearly. It must not silently fall back to AppData in portable mode.

## Runtime Model

Electron main process owns startup:

1. Resolve data root from `app.getPath('userData')`, or from
   `dirname(process.execPath)/GreenHavenData` when portable mode is requested.
2. Create the data subfolders.
3. Load `config/greenhaven.env` and ensure `config/auth-secret` exists.
4. Set `PGLITE_DATA_DIR=<dataRoot>/pgdata`.
5. Set `GREENHAVEN_DATA_DIR=<dataRoot>` so telemetry artifacts, logs, saves,
   and backups share one local root.
6. Clear inherited `DATABASE_URL` / `AUTH_DISABLED` so desktop uses the local
   embedded database and real cookie auth.
7. Set `GREENHAVEN_DESKTOP=1`; desktop auth uses the same signed `gh_player`
   cookie but does not mark it `Secure` because the local backend is plain
   `http://127.0.0.1`.
8. Validate packaged backend/frontend assets before starting the server.
9. Start local crash reporting with `uploadToServer=false`.
10. Start the Hono backend on `127.0.0.1` using an ephemeral port.
11. Serve the built web UI from the same backend origin.
12. Open `BrowserWindow` at that local URL.
13. Close the backend during app shutdown.

The renderer stays a normal web UI and talks to same-origin `/api`.

Runtime ownership is split across focused desktop modules: `desktopPaths.ts`
selects AppData vs portable data roots, `desktopConfig.ts` owns local env/auth
secret persistence, `desktopConfigIpc.ts` owns provider-key IPC,
`desktopDiagnostics.ts` owns crash dumps and NetLog, `desktopTelemetry.ts` owns
desktop telemetry POSTs, `desktopLogging.ts` owns local logs, and
`desktopWindow.ts` owns BrowserWindow setup.

## Local Reset

The in-game reset button is a local "new game" reset, not only a transcript
clear. It calls `POST /api/player/reset-local-game`, which wipes players,
sessions, chat/tool/gui history, adventure queues, dynamic runtime entities,
saves, overlays, and progression through the shared reset-world lifecycle. The
client then clears GreenHaven-owned local identity/session storage and reloads
so the next boot creates a fresh anonymous player and opens the character
creator.

In desktop mode this endpoint may run without a valid current cookie. That is
intentional: the reset button is the recovery path when local auth or stored
identity is stale. Non-desktop production keeps auth required.

## Security Rules

- `nodeIntegration: false`.
- `contextIsolation: true`.
- Minimal preload only.
- Debug routes disabled by default in production.
- API keys are user config, not bundled secrets.
- The desktop app must generate its own `AUTH_SECRET`; packaged builds must not
  depend on a developer `.env` file.

## Backup Rule

The player backup unit is the AppData `GreenHaven` folder. A later UI pass
should add buttons to open the data folder, export a timestamped backup,
restore a backup, and reset local state. Portable mode can additionally export
or import a `GreenHavenData` bundle.
