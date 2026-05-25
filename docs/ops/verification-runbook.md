# GreenHaven Verification Runbook

This is the working order for code checks, manual playtests, performance
triage, and packaged desktop diagnostics.

## 1. After Any Code Change

Run from the repository root:

```powershell
npm --prefix packages/web-server run build
npm --prefix packages/web-ui run build
node packages\web-server\dist\scripts\support-smoke.js
```

Expected result:

- both builds exit `0`;
- support smoke returns `"ok": true`;
- core telemetry checks pass:
  `frontend_telemetry_ingest`, `desktop_telemetry_ingest`,
  `telemetry_diagnostic_bundle`, `telemetry_retention_and_artifact_files`,
  and `telemetry_developer_export`.

If the change touches Electron packaging, also run:

```powershell
npm --prefix packages/desktop-electron run build
```

## 2. Before Manual Game Testing

Start from a known state:

1. Reset the world/session from the UI, or call the reset debug endpoint in a
   dev server.
2. Confirm stale telemetry is not affecting the session:

```powershell
npm --prefix packages/web-server run telemetry:report -- --minutes 15
```

3. If you are testing a packaged build, check:

```powershell
%APPDATA%\GreenHaven\logs\desktop.log
%APPDATA%\GreenHaven\telemetry\artifacts\
```

Portable mode uses:

```text
<GreenHaven.exe folder>\GreenHavenData\
```

## 3. During Manual Playtest

When a bug appears, do not reset immediately. Capture the last incident window:

```powershell
npm --prefix packages/web-server run telemetry:bundle -- --minutes 30 --write
npm --prefix packages/web-server run telemetry:errors -- --minutes 30
npm --prefix packages/web-server run telemetry:quality -- --minutes 30
```

If a specific turn id is visible in logs or UI diagnostics:

```powershell
npm --prefix packages/web-server run telemetry:report -- turn <turnId>
```

If a trace id is visible:

```powershell
npm --prefix packages/web-server run telemetry:report -- trace <traceId>
```

## 4. Performance Triage

Use the performance slice first:

```powershell
npm --prefix packages/web-server run perf:hotspots -- --minutes 30
npm --prefix packages/web-server run perf:failures -- --minutes 30
```

Then use the full telemetry lake:

```powershell
npm --prefix packages/web-server run telemetry:report -- --minutes 30
npm --prefix packages/web-server run telemetry:export -- --minutes 30 --write
```

The developer export writes:

- JSONL for scripts and quick local analysis;
- OTLP JSON for OpenTelemetry Collector/Grafana/Jaeger-style tooling.

## 5. Electron NetLog

NetLog is off by default. For a packaged build, open the renderer DevTools
console and run:

```js
await window.greenhavenDesktop.diagnostics.startNetLog()
// reproduce the issue
await window.greenhavenDesktop.diagnostics.stopNetLog()
```

The file is indexed in `telemetry_artifacts` and stored under:

```text
telemetry/artifacts/netlog/
```

For startup network capture, add to `config/greenhaven.env`:

```text
GREENHAVEN_DESKTOP_NETLOG=1
```

## 6. Developer OTLP Mode

Local export to files:

```powershell
npm --prefix packages/web-server run telemetry:export -- --minutes 60 --write --format jsonl,otlp
```

Optional POST to a local OpenTelemetry Collector:

```powershell
$env:GREENHAVEN_TELEMETRY_OTLP_ENDPOINT='http://127.0.0.1:4318'
npm --prefix packages/web-server run telemetry:export -- --minutes 60 --post-otlp
```

Remote endpoints are blocked by default. To export outside localhost, you must
explicitly pass:

```powershell
npm --prefix packages/web-server run telemetry:export -- --post-otlp --otlp-endpoint https://example.invalid --allow-remote
```

Do this only with a deliberately redacted developer dataset.

## 7. Retention

Inspect first:

```powershell
npm --prefix packages/web-server run telemetry:retention -- --dry-run
```

Apply:

```powershell
npm --prefix packages/web-server run telemetry:retention
```

Retention deletes old rows and managed files under `telemetry/artifacts/`.
It does not delete arbitrary paths outside the managed telemetry artifact root.

## 8. Release Check

Before giving a desktop build to a tester:

```powershell
npm --prefix packages/web-server run build
npm --prefix packages/web-ui run build
node packages\web-server\dist\scripts\support-smoke.js
npm --prefix packages/desktop-electron run dist:win-dir
```

Then launch:

```powershell
packages\desktop-electron\release\win-unpacked\GreenHaven.exe
```

Confirm:

- app window opens;
- `logs/desktop.log` is created;
- local backend starts on `127.0.0.1`;
- reset session works;
- character creation works;
- `telemetry:report -- --minutes 15` shows frontend and desktop rows.

## Failure Policy

- Build failure: stop and fix compile/type errors first.
- Smoke failure: treat as a regression unless the fixture itself was changed.
- Manual bug: capture `telemetry:bundle -- --write` before reset.
- Performance stall: capture `perf:hotspots`, `perf:failures`, and
  `telemetry:export -- --write`.
- Packaged app failure: inspect `desktop.log`, then capture a persisted
  telemetry bundle after the backend becomes reachable.
