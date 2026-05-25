# Greenhaven Noir Default Cartridge

This vault is the active English-first source for the bundled default cartridge.
The cartridge source of truth is the human-authored Obsidian folder
`GreenhavenNoir/`; generated Forge output and packaged database templates are
derived from that folder.

## Start Of The Game

Start location: @Greenhaven Police Department.

The player begins as a detective waking at 6:00 AM on Monday inside
@Greenhaven Police Department. The week is trapped in a loop. Seven cases point
toward @The Chemist and a Sunday metro gas attack. The first play goal is to
read the case board, inspect the locker, establish the baseline inventory, and
step into @Greenhaven City with memory as the only weapon that survives reset.

## Active World Root

Write playable source notes under:

```text
GreenhavenNoir/
```

Use ordinary Markdown prose. Do not put SQL, YAML, JSON, numeric IDs, API keys,
or engine instructions in visible world notes.

## Cartridge Scope

The playable bundled cartridge is the Greenhaven Noir loop campaign:

- @Greenhaven City.
- @Greenhaven Police Department.
- @Iron Row District.
- @Greenhaven Industrial Complex.
- @Guildrise Avenue Storage Units.
- @Sunbridge Street.
- @Metro Maintenance Depot.
- @Metro Service Tunnels.
- @Metro Central Hub.

Those locations demonstrate first-entry bubbles, time-loop pressure, persistent
memory, investigation routing, evidence, NPC relationships, authored scenes,
quest pointers, music/media scripts, and cartridge-local visual assets.

## Tone And Art Direction

Greenhaven Noir is grounded detective fantasy-noir: rain, sodium lamps,
concrete, occult industrial pressure, old case files, and dangerous affection
inside a city that remembers every failed week. It should feel cinematic,
readable, and realistic, not cartoonish and not generic dark fantasy.

Default image direction:

- square 1:1 realism cards;
- black-and-white or hard-contrast noir lighting;
- visible grain, clear silhouettes, practical streets and interiors;
- readable character props, case evidence, weapons, badges, doors, and signs;
- stable card framing so gamemasters can see how every asset slot is used.

## Authoring Rules

- All active source content is English-first.
- Use exact canonical runtime mentions for playable entities.
- Do not translate canonical `@Name` mentions.
- Put NPC scenes under the NPC that owns them.
- Put public crowd, fight, hearing, and travel scenes under the location.
- Put items under their owning location or under `GreenhavenNoir/Economy`.
- Add `Materializes` whenever an action, purchase, scene, or quest creates
  access, state, service, item, NPC, scene, quest, media, or location state.
- Every location must have a first-entry bubble, exits, pressure, memory hooks,
  and at least one durable consequence example.

## Demonstration Checklist

- [x] Active world root is `GreenhavenNoir/`.
- [x] Start location is @Greenhaven Police Department.
- [x] Cartridge boot media lives under `GreenhavenNoir/media/boot/`.
- [x] Location, NPC, item, and scene media live beside their owning notes.
- [x] First-entry bubbles are authored in visible notes.
- [x] Materializers demonstrate persistent world, hero, and inventory state.
- [x] Media scripts demonstrate location, NPC, and scene atmosphere changes.
- [x] The default packaged database is built from the active `GreenhavenNoir/`
  world root.

## Gamemaster Quick Map

- `@Greenhaven Police Department` teaches start state, loop anchoring, baseline
  inventory, case-board quest routing, and persistent evidence.
- `@Greenhaven City` teaches world voice, atmospheric pressure, loop memory,
  and city-scale consequence hooks.
- `@Iron Row District` teaches the first murder case and forensic discovery.
- `@Greenhaven Industrial Complex` teaches supply-chain investigation and
  precursor tracking.
- `@Guildrise Avenue Storage Units` teaches hidden storage, maps, motive, and
  personal stakes around @Lin.
- `@Sunbridge Street` teaches social pressure, money trails, and access codes.
- `@Metro Maintenance Depot` teaches accomplice pressure and technical clues.
- `@Metro Service Tunnels` teaches device discovery, danger, and route control.
- `@Metro Central Hub` teaches the Sunday confrontation and loop resolution.

## Where Each Mechanic Lives

- First entry and travel: every location uses `First Entry Bubble` and
  `Visible Exits`.
- Public scenes: location-owned scenes live in each location's `scenes/`
  folder.
- Personal scenes: NPC-owned scenes live under `npc/@NPC/scenes/`.
- NPC quests: quest files live under `npc/@NPC/quests/`.
- Item examples: item notes live under `items/@Item/ItemMind.md`.
- Materializes examples: locations, scenes, items, and quests can materialize
  access, state, item, quest, scene, service, media, or relationship output.
- Visual assets: location, NPC, item, and scene card assets should sit beside
  their owning note with prompt text beside generated media when available.
- Cartridge music: locations, NPCs, and scenes use local `music/` folders plus
  `## Media Script` to switch atmosphere without hardcoded engine paths.
- Cartridge boot atmosphere: `GreenhavenNoir/media/boot/01.poster.jpg`,
  `GreenhavenNoir/media/boot/01.video.mp4`, and
  `GreenhavenNoir/media/boot/01.music.mp3` define the bundled start/menu mood.

## Historical Reference

The older bright Greenhaven sample is no longer the bundled default. If it is
kept in the repository, it is reference material only. Default compilation,
packaging, and precompiled database generation must follow `Active World Root`
above.
