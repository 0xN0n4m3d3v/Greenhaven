# Media: title screens, cards, video, and music

Greenhaven cartridges are allowed to carry their own atmosphere. A cartridge
can bring:

- a title-screen poster, optional title-screen video, and title-screen music;
- character portraits, location cards, item icons, and scene plates;
- animated `webm` / `mp4` cards in the same slots as still images;
- local music for locations, NPC dialogue, and authored scenes.
- chat-visible media cards that a scene, location, or NPC can push into the
  chat at a scripted moment.

The rule is simple: put media beside the thing it belongs to. Do not write
absolute Windows paths in notes. The compiler discovers files, copies them into
the cartridge asset cache, and the runtime serves them by stable asset role.

## Supported folders and formats

| Use | Folder | Supported formats |
| --- | --- | --- |
| Cartridge boot/title atmosphere | `GreenHavenWorld/media/boot/` | `png`, `jpg`, `jpeg`, `webp`, `mp4`, `webm`, `mp3`, `ogg`, `m4a`, `wav` |
| NPC portraits | `npc/@Name/portraits/` | `png`, `jpg`, `jpeg`, `webp`, `gif`, `webm`, `mp4` |
| Location / item / scene cards | `images/` beside the owner | `png`, `jpg`, `jpeg`, `webp`, `gif`, `webm`, `mp4` |
| Extra local media | `media/` beside the owner | images, video, audio |
| Music and audio | `music/` or `audio/` beside the owner | `mp3`, `ogg`, `m4a`, `wav` |

The asset cache also accepts `svg`, but square raster images or short videos are
the normal player-facing card format.

## Cartridge boot/title media

Put title-screen media here:

```text
GreenHavenWorld/
  media/
    boot/
      01.png
      01.mp3
      02.poster.png
      02.video.webm
      02.music.ogg
```

Files with the same bundle id belong together:

- `01.png` becomes `boot_poster_01`;
- `01.mp3` becomes `boot_music_01`;
- `02.poster.png` becomes `boot_poster_02`;
- `02.video.webm` becomes `boot_video_02`;
- `02.music.ogg` becomes `boot_music_02`.

When the game opens, the installed cartridge can replace the built-in menu
atmosphere:

- poster image sets the title/menu background;
- video plays muted over the title/menu background;
- music plays across title, language picker, settings, and main menu, then
  fades out when the hero enters the game.

If several boot bundles exist, the launcher rotates through them by launch
counter. A bundle can contain only a poster, only music, or all three. For the
cleanest result, ship at least one poster plus one music file.

Do not put boot media under `.greenhaven-agent-manual`, `ref`, or a personal
Desktop folder. It must live inside the active portable cartridge source under
`GreenHavenWorld/media/boot/`.

## Canonical card slots

These file names are the default card slots the UI knows how to show.

| Entity | Still card | Animated card |
| --- | --- | --- |
| NPC | `npc/@Name/portraits/default.png` | `npc/@Name/portraits/default.webm` |
| Location | `@Location/images/establishing.png` | `@Location/images/establishing.webm` |
| Item | `items/@Item/images/icon.png` | `items/@Item/images/icon.webm` |
| Scene | owner `images/<scene-slug>.png` | owner `images/<scene-slug>.webm` |

The compiler treats an animated card with the same basename as the same visual
slot. A `default.webm` portrait is rendered as a muted looping portrait; it does
not need a separate image declaration.

## Extra media roles

Extra files are imported too. Their roles are derived from the file name:

```text
music/greenhaven-port.mp3          -> music_greenhaven_port
music/tamara-vey.mp3               -> music_tamara_vey
music/rats-under-the-blue-warehouse.mp3 -> music_rats_under_the_blue_warehouse
images/rain-loop.webm              -> video_rain_loop
images/ledger-closeup.png          -> media_ledger_closeup
portraits/angry.png                -> portrait_angry
```

Names are normalized: lower case, spaces and hyphens become underscores. In a
`## Media Script`, you usually refer to the normalized role, not the file path.
The parser also accepts a file-like argument such as
`switch_music("tamara-vey.mp3")`; it normalizes that to `music_tamara_vey`.

## Ownership rules

Media ownership is local:

- a location reads only its own `images/`, `media/`, `music/`, and `audio/`;
- an NPC reads only its own folders;
- a scene reads its canonical plate and scene-named helper media from the
  owning location or NPC folder;
- a parent location must not accidentally inherit child NPC portraits or item
  icons.

For scenes, name helper tracks after the scene slug:

```text
@Greenhaven Port/
  music/
    arrival-with-a-revolver.mp3
  scenes/
    @Arrival With A Revolver.md
```

This gives the scene the role `music_arrival_with_a_revolver`.

## Media Script

Locations, NPCs, and scenes may include a `## Media Script` section. Each line
is a small function call.

```md
## Media Script

switch_music("music_greenhaven_port", label="Greenhaven Port", loop=true, volume=0.55)
play_music("tamara-vey.mp3", label="Tamara Vey", loop=true, volume=0.60)
show_media("scene_plate", title="Arrival with a Revolver", caption="Tamara watches the hatch while the crowd pretends not to.")
pause_music()
resume_music()
stop_music()
```

Supported commands:

| Command | Effect |
| --- | --- |
| `play_music("role")` | Starts a track if it is not already active. |
| `switch_music("role")` | Replaces the current track. This is the normal command for locations, NPCs, and scenes. |
| `pause_music()` | Pauses the current cartridge track. |
| `resume_music()` | Resumes the paused cartridge track. |
| `stop_music()` | Stops and unloads the current cartridge track. |
| `show_media("role")` | Sends an image, video, or audio asset into the chat as a media card. |

Supported named arguments:

- `label="Tamara Vey"` - text shown in the small music controller;
- `title="The torn ledger"` - title for a chat media card;
- `caption="Wax seal and blue thread."` - optional text under the media card;
- `alt="A torn ledger page."` - accessibility text for image/video media;
- `loop=true` or `loop=false`;
- `volume=0.75` - local multiplier from `0` to `1`.

The player's master volume still applies. The default player volume is 75%, and
the settings slider can no longer persist absolute zero by accident.

## Trigger timing

Automatic runtime triggers currently exist for:

- location scripts: when the player enters or restores into that location;
- NPC scripts: when dialogue focuses on that NPC, including auto-engage;
- scene scripts: when an authored scene opens.

Item notes can own icons and media files, but item `## Media Script` does not
auto-fire by itself. If item use should change music, put the script on the
scene, NPC, or location that item use opens.

`show_media(...)` uses the same trigger timing as music. A location can show a
postcard when the hero arrives, an NPC can show a clue during dialogue, and a
scene can show a plate, close-up, short `webm`, or audio note when the scene
opens. The card is stored as a durable `media:shown` event, so replay and
reload can restore it from the event log.

## Sample layout

```text
@Greenhaven Port/
  PortMind.md
  images/
    establishing.png
  music/
    greenhaven-port.mp3
    arrival-with-a-revolver.mp3
    rats-under-the-blue-warehouse.mp3
  scenes/
    @Arrival With A Revolver.md
    @Rats Under The Blue Warehouse.md
  npc/
    @Tamara Vey/
      NPCMind.md
      portraits/
        default.png
      music/
        tamara-vey.mp3
```

`PortMind.md`:

```md
## Media Script

switch_music("music_greenhaven_port", label="Greenhaven Port", loop=true, volume=0.55)
```

`npc/@Tamara Vey/NPCMind.md`:

```md
## Media Script

switch_music("music_tamara_vey", label="Tamara Vey", loop=true, volume=0.60)
```

`scenes/@Arrival With A Revolver.md`:

```md
## Media Script

switch_music("music_arrival_with_a_revolver", label="Arrival With A Revolver", loop=true, volume=0.68)
show_media("scene_plate", title="Arrival with a Revolver", caption="The first image the scene wants in chat.")
```

## Build and import behavior

During compile/import:

1. The transformer writes `audit/visual-assets.jsonl`.
2. Cartridge Forge validates the records.
3. The apply pipeline copies all available media into the cartridge asset
   cache under the app data directory.
4. The runtime serves media from `/api/assets/cartridges/...`, not from raw
   author paths.
5. Packaged desktop builds copy the default cartridge source and its
   precompiled database into `resources/web-server/default-cartridge/`.

This is why replacing a file in the source cartridge is not enough for a release
build. Re-run the cartridge/default build or the desktop asset preparation step
so the new media is copied into the packaged resources.

## Verification checklist

- [ ] Boot media lives in `GreenHavenWorld/media/boot/`.
- [ ] At least one boot poster or video exists.
- [ ] At least one boot music file exists if the cartridge needs its own title
      music.
- [ ] Every important NPC has `portraits/default.png` or `default.webm`.
- [ ] Every important location has `images/establishing.png` or
      `establishing.webm`.
- [ ] Every important scene has a scene plate or a deliberate reason not to.
- [ ] Every `switch_music` role matches a real file role.
- [ ] `compile_vault_to_forge.py` and Cartridge Forge validation finish with
      zero errors, warnings, and questions.
