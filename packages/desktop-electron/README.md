# GreenHaven Desktop

Electron shell for the offline-first GreenHaven desktop build.

## Data Location

Normal desktop builds store player data under Electron `userData`.

On Windows this is:

```text
%APPDATA%\GreenHaven
```

The app creates:

```text
pgdata/
config/
saves/
logs/
backups/
telemetry/
  artifacts/
    bundles/
    crashes/
    netlog/
    logs/
```

`pgdata` is passed to the local backend as `PGLITE_DATA_DIR`.

The app creates `config/auth-secret` on first launch for the local
`gh_player` cookie. Optional provider keys can be supplied in
`config/greenhaven.env`:

```text
DEEPSEEK_API_KEY=...
FEATHERLESS_API_KEY=...
```

The main-menu settings screen can also save or clear `DEEPSEEK_API_KEY`.
The saved key is written to `config/greenhaven.env`; the renderer only sees
whether a key exists, not the saved secret value.

Packaged backend/main-process diagnostics are written to `logs/desktop.log`.
The backend indexes that file in `telemetry_artifacts` on startup. Electron
crash dumps are kept locally under `telemetry/artifacts/crashes/`; crash upload
is disabled.

## Desktop Diagnostics

Electron sends local desktop telemetry to the embedded backend:

- packaged backend/frontend asset validation;
- backend startup duration;
- window ready/unresponsive/responsive events;
- renderer and child process exits;
- `logs/desktop.log` artifact indexing.

NetLog capture is off by default. To start it for a session from the renderer
DevTools console:

```js
await window.greenhavenDesktop.diagnostics.startNetLog()
// reproduce the network/backend problem
await window.greenhavenDesktop.diagnostics.stopNetLog()
```

The resulting file is stored under `telemetry/artifacts/netlog/` and indexed in
`telemetry_artifacts`.

For startup capture, set this in `config/greenhaven.env`:

```text
GREENHAVEN_DESKTOP_NETLOG=1
```

## Portable Data Override

Portable colocated data is explicit:

```powershell
$env:GREENHAVEN_PORTABLE_DATA='1'
.\GreenHaven.exe
```

In that mode data lives beside the executable:

```text
GreenHavenData/
  pgdata/
  config/
  saves/
  logs/
  backups/
  telemetry/
```

## Commands

```powershell
npm --prefix packages/web-server run build
npm --prefix packages/web-ui run build
npm --prefix packages/desktop-electron run build
npm --prefix packages/desktop-electron run dev
npm --prefix packages/desktop-electron run dist:win-dir
```

`dist:win-dir` is the fastest packaging smoke test. `dist:win` creates the
Windows installer target.
