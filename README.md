# Greenhaven

<p align="center">
  <img src="landing/greenhaven/assets/hero.jpg" alt="Greenhaven" width="100%" />
</p>

Greenhaven is a local-first AI-native narrative RPG engine: a fantasy/noir
RPG novel told through chat, where the world does not live only in a prompt.
NPC memories, relationships, quests, inventory, locations, dice, media,
music, and consequences are stored as real game state.

The core promise is simple:

> A player can leave a scene, come back later, and the world still knows what
> happened.

Trailer / demo video:
https://www.youtube.com/watch?v=zPogiRcDM_M

Downloadable Windows builds are published through GitHub Releases:
https://github.com/0xN0n4m3d3v/Greenhaven/releases

## What This Is

Greenhaven is not a generic chatbot, a visual novel, or a digital tabletop.
It is a database-backed story engine for persistent fictional life.

- Players type natural actions in a chat-like interface.
- The backend resolves movement, dialogue, quests, dice, inventory, memory,
  media, relationships, and world mutations.
- The narrator writes visible prose after state changes are decided.
- Game masters build worlds as human-readable Obsidian-style cartridge notes,
  not SQL or code.
- Desktop builds can ship with one or more precompiled cartridges and their
  media assets.

The current bundled demo is **Greenhaven Noir**: a detective-fantasy loop
campaign where the hero wakes at 6:00 AM on Monday inside
`@Greenhaven Police Department`. The week is trapped in a loop. Seven cases
point toward `@The Chemist` and a Sunday metro gas attack. Memory is the weapon
that survives reset.

## Why Greenhaven Is Different

Most AI story systems rely on prompt context. Greenhaven treats fiction as
runtime state.

| Layer | What Greenhaven persists |
| --- | --- |
| Characters | NPC identity, voice, memory, status, routines, relationships, companion rules |
| World | Locations, exits, hidden routes, first-entry bubbles, pressure, remembered facts |
| Quests | Hooks, stages, outcomes, failure states, rewards, consequences |
| Inventory | Items, clues, money, merchant behavior, ownership, transfers |
| Scenes | Authored beats, choices, combat pressure, romance tone, memory changes |
| Media | Cartridge title media, portraits, location cards, scene plates, music scripts |
| Playthrough | Hero state, world state, cartridge install cache, session event history |

The design goal is a psychological LitRPG novel in chat form: durable memory,
relationships, trauma, mood, consequence, progression, and playable scenes
without turning the game into paperwork.

## For Players

Greenhaven is built for players who want a private RPG life with continuity:

- NPCs can remember gifts, threats, flirting, promises, debts, fear, jealousy,
  trust, attraction, and betrayals.
- Dangerous actions can trigger dice checks, combat, injuries, rewards, and
  lasting world consequences.
- The world can open routes, reveal clues, change music, show media cards, and
  keep location state after the turn ends.
- The hero can grow through XP, skills, titles, possessions, wounds,
  relationships, and reputation.

## For Game Masters

A Greenhaven cartridge is a playable world folder. Writers create plain
Markdown notes in an Obsidian-style vault; the transformer and Cartridge Forge
compile those notes into runtime records and assets.

Current bundled cartridge source:

```text
GreenhavenWorld/
|-- WORLD_MANIFEST.md
|-- GreenhavenNoir/
|   |-- media/boot/
|   `-- Locations/
`-- Gamemasters-v2/
```

Start here:

- [Greenhaven Workshop](GreenhavenWorld/Gamemasters-v2/Welcome.md)
- [What is a cartridge](GreenhavenWorld/Gamemasters-v2/01-getting-started/What%20is%20a%20cartridge.md)
- [Creating the vault](GreenhavenWorld/Gamemasters-v2/01-getting-started/Creating%20the%20vault.md)
- [NPC reference](GreenhavenWorld/Gamemasters-v2/02-reference/NPC%20reference.md)
- [Location reference](GreenhavenWorld/Gamemasters-v2/02-reference/Location%20reference.md)
- [Scene reference](GreenhavenWorld/Gamemasters-v2/02-reference/Scene%20reference.md)
- [Quest reference](GreenhavenWorld/Gamemasters-v2/02-reference/Quest%20reference.md)
- [Materializes](GreenhavenWorld/Gamemasters-v2/03-mechanics/Materializes.md)
- [Media](GreenhavenWorld/Gamemasters-v2/03-mechanics/Media.md)
- [Companions](GreenhavenWorld/Gamemasters-v2/03-mechanics/Companions.md)

The same guide is also built as a static website under
`landing/greenhaven/gamemasters/`.

### Cartridge Authoring Rules

- Write active cartridge content English-first.
- Use exact canonical `@Name` mentions for NPCs, places, scenes, and items.
- Do not translate `@Name` mentions. Translate prose around them if needed.
- Keep media beside the thing it belongs to: NPC portraits beside the NPC,
  location cards beside the location, scene plates beside the scene owner.
- Use `## Materializes` when a player action creates access, state, an item,
  a clue, a quest pointer, a status, a scene, a route, or a companion contract.
- Use `## Media Script` to start, switch, pause, resume, or stop cartridge
  music and to push media cards into chat.
- Do not put absolute local Windows media paths in notes. Put the files inside
  the cartridge.

## Greenhaven Noir Demo Cartridge

`GreenhavenWorld/GreenhavenNoir` demonstrates the current cartridge standard:

- nine authored locations, including police, industrial, storage, street, and
  metro spaces;
- eleven authored NPCs, including `@Detective Vex`, `@Captain Harrow`,
  `@The Chemist`, `@The Hobo`, and case-linked witnesses;
- local portraits, location cards, scene assets, boot poster/video/music, and
  per-location or per-NPC music;
- first-entry bubbles, authored scene choices, investigation pressure,
  item/clue ownership, and materialized consequences.

The active world manifest is
[GreenhavenWorld/WORLD_MANIFEST.md](GreenhavenWorld/WORLD_MANIFEST.md).

## Architecture

```text
packages/
|-- web-server/        Hono API, turn runner, tools, prompts, specialists,
|                      cartridge import/apply, PGlite persistence
|-- web-ui/            React/Vite game client, cartridge library, chat surface,
|                      event cards, UI state, music and media playback
|-- desktop-electron/  Windows desktop shell, packaged backend/frontend,
|                      local AppData runtime, release packaging
|-- cartridge-forge/   Cartridge validation and authoring toolchain
`-- shared/            Shared TypeScript utilities

GreenhavenWorld/       Obsidian-style cartridge source and GM documentation
landing/greenhaven/    Public landing page and GM guide static site
docs/                  Runtime, cartridge, server, database, and ops notes
```

Server state is canonical. The UI presents and suggests actions, but gameplay
mutations must be confirmed by backend tools, persisted state, or replayable
server events.

## Requirements

- Node.js 20+
- npm
- Python 3.11+ for Obsidian cartridge transformer scripts
- Windows for Electron installer packaging

## Development

Install dependencies:

```bat
npm install
```

Run the backend:

```bat
npm run dev:server
```

Run the web UI:

```bat
npm run dev:ui
```

Then open the Vite URL printed by the UI server.

Desktop builds store local player data, provider keys, logs, saves, and the
PGlite database under:

```text
%APPDATA%\GreenHaven
```

Optional local provider keys can be saved from the game settings UI or placed
in:

```text
%APPDATA%\GreenHaven\config\greenhaven.env
```

Example:

```text
DEEPSEEK_API_KEY=...
```

Do not commit local keys, logs, `pgdata`, AppData, or release output.

## Verification

General repository checks:

```bat
npm run build
npm run typecheck
npm --prefix packages/web-server run cartridge:i18n:check
```

Cartridge validation path:

```bat
python GreenhavenWorld\.greenhaven-agent-manual\skills\greenhaven-human-world-transformer\scripts\compile_vault_preview.py
python GreenhavenWorld\.greenhaven-agent-manual\skills\greenhaven-human-world-transformer\scripts\compile_vault_to_forge.py --vault-root C:\Greenhaven\GreenhavenWorld
npm --prefix packages\cartridge-forge run forge -- validate C:\Greenhaven\GreenhavenWorld\.greenhaven-agent-manual\generated\cartridge-forge-project
```

The target for a release-ready cartridge is zero errors, zero warnings, and
zero open questions.

## Windows Release Builds

Build with the bundled default world:

```bat
build-release.bat --all
```

Build without a bundled world/database:

```bat
build-release-no-world.bat --all
```

Build with a specific Obsidian world folder:

```bat
build-release-with-world.bat C:\Greenhaven\GreenhavenWorld\GreenhavenNoir --all
```

Build multiple precompiled worlds from a manifest:

```bat
build-release-with-worlds.bat C:\Greenhaven\build-release-worlds.example.json --all
```

Manifest shape:

```json
{
  "default": "greenhaven-noir",
  "worlds": [
    {
      "id": "greenhaven-noir",
      "title": "Greenhaven Noir",
      "path": "C:\\Greenhaven\\GreenhavenWorld\\GreenhavenNoir"
    }
  ]
}
```

The build pipeline compiles the cartridge, copies media into the cartridge
asset cache, precompiles the local database template, and packages those
resources into the desktop app. If a cartridge image, video, or music file
changes, rebuild before distributing the installer.

## Landing Site

The public-facing site lives in:

```text
landing/greenhaven/
```

It explains the product promise, player value, game-master workflow, roadmap,
and investor-facing architecture. Project links from the site:

- Website: https://greenhaven.quest/?lang=en
- Patreon: https://www.patreon.com/cw/greenhavenquest
- Contact: author@greenhaven.quest

## License

Apache-2.0.
