# Cartridge media and boot assets

This is the runtime-facing media contract for Obsidian-authored cartridges.
Human authors normally write media rules in `Gamemasters-v2/03-mechanics/Media.md`;
this page records how the current Greenhaven engine imports and plays those
assets.

## Current authoring path

The current cartridge source of truth is the Obsidian-style vault:

```text
GreenhavenWorld/
|-- WORLD_MANIFEST.md
|-- GreenHavenWorld/
|   |-- media/boot/
|   `-- Locations/...
`-- .greenhaven-agent-manual/
```

`WORLD_MANIFEST.md` is a human start page, not a machine YAML contract. The
compiler reads the `GreenHavenWorld/` tree, discovers media files near their
owning notes, and produces Cartridge Forge records plus an asset manifest.

Legacy SQL and JSONL cartridge docs are still useful for generated packs and
debugging, but game-master work should stay Obsidian-first unless a task
explicitly asks for low-level migration authoring.

## Supported media

The cartridge asset manifest currently accepts:

- images: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`;
- audio: `mp3`, `ogg`, `m4a`, `wav`;
- video: `mp4`, `webm`.

The UI renders images as cards, `mp4`/`webm` as muted looping visual cards, and
audio through the cartridge music system.

## Boot and title screen media

Cartridge startup assets live under:

```text
GreenHavenWorld/media/boot/
```

The compiler groups files into boot bundles by stem:

```text
01.png         -> boot_poster_01
01.webm        -> boot_video_01
01.mp3         -> boot_music_01

02.poster.png  -> boot_poster_02
02.video.webm  -> boot_video_02
02.music.ogg   -> boot_music_02
```

The library/status API exposes those bundles as cartridge `bootMedia`. The
desktop/main-menu UI can show the cartridge poster or video and play the
cartridge boot music before the hero enters the world.

## Entity card slots

Use stable relative paths so art can be replaced without changing code:

| Entity | Main slot |
| --- | --- |
| NPC | `portraits/default.png` or `portraits/default.webm` |
| Location | `images/establishing.png` or `images/establishing.webm` |
| Item | `images/icon.png` or `images/icon.webm` |
| Scene | scene-local `images/key.png` or a scene slug image |

Cards should be square. A still card can be replaced with a square `webm` or
`mp4` loop when the world needs motion.

## Media script

Locations, NPCs, and scenes can include:

```markdown
## Media Script

switch_music("music_greenhaven_port", label="Greenhaven Port", loop=true, volume=0.55)
```

Role names come from local asset file names. For example,
`music/greenhaven-port.mp3` becomes `music_greenhaven_port`.

Supported commands:

- `play_music(role, label?, loop?, volume?)`
- `switch_music(role, label?, loop?, volume?)`
- `pause_music()`
- `resume_music()`
- `stop_music()`

Automatic triggers:

- location scripts run on location entry and session restore;
- NPC scripts run when dialogue focuses on that NPC;
- scene scripts run when an authored scene opens;
- item media can be imported, but item `Media Script` is not an automatic music
  trigger. Put item-triggered music on the scene, NPC, or location that opens
  after the item is used.

## Packaged builds

Packaged desktop builds must include both the compiled cartridge database and
the cartridge asset cache. If a source image, boot poster, boot video, or audio
file changes, rebuild the cartridge/default assets before packaging so the
`win-unpacked` runtime is not serving stale media.

The player-facing audio widget controls final volume. Cartridge script volume is
multiplied by the player's setting. The default music volume is 75%.

## Verification

For the default Greenhaven cartridge:

```powershell
python .greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/compile_vault_preview.py
python .greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/compile_vault_to_forge.py --vault-root C:\Greenhaven\GreenhavenWorld
npm --prefix packages/cartridge-forge run forge -- validate C:\Greenhaven\GreenhavenWorld\.greenhaven-agent-manual\generated\cartridge-forge-project
```

Validation should remain clean: no errors, no warnings, no open questions.
