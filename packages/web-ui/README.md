# Greenhaven - web-ui

React + Vite frontend for the Greenhaven game runtime. It talks to
`packages/web-server` over HTTP and SSE, renders the chat game surface, and
hosts the cartridge/world/hero management screens used by the desktop build.

## Quick Start

```bash
npm install
npm --prefix packages/web-server run dev
npm --prefix packages/web-ui run dev
```

Vite prints the URL it picked, usually `http://127.0.0.1:5173/`.

## Checks

```bash
npm --prefix packages/web-ui run build
npm --prefix packages/web-ui run i18n:check
```

## Key Areas

- `src/bridge/` is the HTTP/SSE bridge to the backend.
- `src/components/` contains game UI surfaces.
- `src/styles/` contains shared visual styling.
- `src/hooks/` owns client state reconciliation and runtime event handling.

Keep backend mutations behind the bridge or owning hooks; leaf components
should render state and submit explicit actions.
