# Greenhaven

Greenhaven is a local-first narrative RPG engine: a chat-shaped game where
quests, locations, NPC memory, relationships, inventory, media, and cartridge
state are stored as real runtime data.

This repository contains the active desktop game stack:

- `packages/web-server` - Hono backend, game state, cartridge import/runtime,
  tools, prompts, database migrations, and live smoke scripts.
- `packages/web-ui` - React game UI.
- `packages/desktop-electron` - Windows desktop shell and release packaging.
- `packages/cartridge-forge` - cartridge validation/authoring tooling.
- `packages/shared` - shared TypeScript helpers.
- `GreenhavenWorld` - human-authored Obsidian cartridge sources and authoring
  documentation.

Demo video: https://www.youtube.com/watch?v=zPogiRcDM_M

## Requirements

- Node.js 20+
- npm
- Python 3.11+ for Obsidian cartridge transformer scripts

## Development

```bat
npm install
npm run dev:server
npm run dev:ui
```

## Verification

```bat
npm run build
npm run typecheck
npm --prefix packages/web-server run cartridge:i18n:check
```

## Windows Release

Build with the bundled default world:

```bat
build-release.bat --all
```

Build with a specific Obsidian world folder:

```bat
build-release-with-world.bat C:\Greenhaven\GreenhavenWorld\GreenhavenNoir --all
```

Build multiple precompiled worlds from a manifest:

```bat
build-release-with-worlds.bat C:\Greenhaven\build-release-worlds.example.json --all
```

Runtime player data, provider keys, logs, and packaged release output are local
machine artifacts and are intentionally ignored by git.
