# Images: how the world shows itself

This chapter covers visual cards. Cartridge title screens, cartridge boot
posters, videos, and music are covered in
[Media: title screens, cards, video, and music](Media.md).

Greenhaven is not text alone. Every character can have a portrait,
every location a view, every item an icon, every key scene a plate.
You can produce them with an image generator that reads your notes,
or you can drop in pictures you painted yourself. Either way works —
the engine cares only that the files end up in the right folders with
the right names.

There is **one hard constraint** on every image: it must be **square**
— a 1:1 aspect ratio. Style, palette, technique, mood, level of
realism — all of that is yours to decide for your own world. Saturated
adventure fantasy, ink-wash noir, painterly storybook, glitched
sci-fi, soft watercolor: anything works, as long as the canvas is
square.

## What kinds of image exist

| What it is         | Where it lives                                       | Format             | Purpose                                      |
| ------------------ | ---------------------------------------------------- | ------------------ | -------------------------------------------- |
| Character portrait | `npc/@Name/portraits/default.png`                    | square PNG / JPG / WEBM | The character's face in dialogue and the UI |
| Location view      | `@Location/images/establishing.png`                  | square PNG / JPG / WEBM | The wide impression of the location          |
| Item icon          | `items/@Name/images/icon.png`                        | square PNG / JPG / WEBM | The item in inventory and the UI             |
| Scene plate        | `scenes/@Scene/images/key.png` or `npc/@Name/images/<scene-slug>.png` | square PNG / JPG / WEBM | A key moment of a scene                      |

For cartridge startup atmosphere, use `GreenHavenWorld/media/boot/`.
A poster such as `01.png`, a video such as `01.webm`, and music such
as `01.mp3` form one boot bundle. The main menu can then show that
cartridge's own title art and play its own title music.

The `portraits/` and `images/` folders are created by hand inside the
entity's folder. The file names must be exactly the ones above —
otherwise the engine will not find the picture.

Animated cards use the same slots. A `default.webm` portrait, an
`establishing.webm` location view, an `icon.webm` item card, or a
scene-named `.webm` plate is treated as that entity's card and rendered as
muted looping video in the UI. Put music and other audio under `media/`,
`music/`, or `audio/` and control it through `## Media Script`; see
`03-mechanics/Media.md`.

Recommended dimensions: anywhere from **1024×1024** to **2048×2048**
pixels. Larger files take longer to load and are usually pointless
for a UI image. Smaller files lose detail. Either PNG or JPG is
acceptable. Use PNG when transparency or sharp edges matter (icons,
portraits on transparent backgrounds), JPG when you have a busy
illustrated scene and want a smaller file.

## Style is yours

There is no locked style for Greenhaven cartridges. The engine does
not check the look of an image; it only checks that the file is
present and that its name matches. Your world's visual language is
entirely your decision.

That said, a few craft notes that apply to any style:

- **Consistency inside one cartridge.** Pick a single style for the
  world and stay with it across portraits, locations, and icons.
  Mixing painted portraits with photographic locations and pixel-art
  icons makes a world feel fragmented. One look, one world.
- **A square canvas.** Compose for the square from the start. Faces
  centered, items centered, scenes built around a clear focal point.
  If you crop a wide landscape into a square, the result often loses
  its mid-ground; better to compose for 1:1 directly.
- **Readability at small sizes.** The UI displays portraits and icons
  small. A great image at 1024×1024 that turns into mud at 128×128
  is a half-win. Test your image at a small thumbnail; if you can
  still tell **who** or **what** it is at a glance, it works.

## How an image gets into the world — two paths

You have two ways of getting an image into the right place. They are
not mutually exclusive — you can mix them inside the same cartridge.

### Path A — generated from a brief

Inside each entity file there is an optional section that holds a
**brief** for an image generator. You write a short, concrete
description; an art agent reads it, produces the image, and saves
it to the correct path with the correct name. You never touch the
file system.

The brief sections are:

- `## Appearance For Portrait` — in a character file.
- `## Establishing Image Brief` — in a location file.
- `## Visual Brief` — in an item file.
- `## Scene Image Brief` — in a scene file (optional; many scenes do
  not need their own plate).

If a section is present, an agent will pick it up on the next image
pass. If a section is absent, no image is generated for that entity
— the world simply runs without that picture.

### Path B — drop the file in yourself

If you have your own art — drawn by hand, commissioned, or generated
elsewhere — you can place the file directly. Open the entity's
folder in Windows Explorer (or any file manager) and put the picture
at the path the engine expects:

```
Locations/@Greenhaven City/@Greenhaven Port/
└── npc/
    └── @Tessa Wrenlight/
        ├── NPCMind.md
        └── portraits/
            └── default.png         ← put it here
```

For a location:

```
Locations/@Greenhaven City/@Greenhaven Port/
├── PortMind.md
└── images/
    └── establishing.png            ← put it here
```

For an item:

```
items/@Brass Compass/
├── ItemMind.md
└── images/
    └── icon.png                    ← put it here
```

For a scene plate, two layouts are accepted. Either inside the
scene's own folder:

```
scenes/@First Word On The Pier/
├── @First Word On The Pier.md
└── images/
    └── key.png
```

Or next to the owning character, with a slug that matches the scene
title:

```
npc/@Tessa Wrenlight/
├── NPCMind.md
└── images/
    └── first-word-on-the-pier.png
```

When the cartridge is compiled, the engine walks these folders, sees
the picture, and links it to the right entity. Nothing else is
required.

## Writing a portrait brief

In the character file, under `## Appearance For Portrait`. This is a
technical brief — what the artist sees, not what the narrator says.
Image generators understand English best, so even if your prose
language is something else, the brief itself is usually written in
English:

```markdown
## Appearance For Portrait

Portrait target: `portraits/default.png` (1:1). A tall lean half-elf
woman, sun-tanned deep brown skin, silver-streaked dark hair tied
back with a faded teal cord, pale gray-green eyes, sharp watchful
expression. Sun-faded teal coat over hardened leather, fingerless
gloves, sea-worn boots, an old brass smuggler's compass on a cord at
her chest. Warm side light, deep blue background. Centered head and
shoulders, clear silhouette. No text, no UI.
```

Anatomy of a brief:

- **The target line.** Where to save and the aspect ratio. Always
  start with this — it removes ambiguity for any agent or human
  reader.
- **The subject.** A condensed version of `Appearance` — the
  essentials of who is in the frame.
- **Light and background.** "Warm side light, deep blue background."
  Pick lighting that suits your world, not someone else's.
- **Composition for square.** "Centered head and shoulders," "clear
  silhouette." These directions keep the portrait readable at the
  small sizes the UI uses.
- **Negatives.** "No text, no UI" — useful, because generators will
  sometimes invent captions or interface elements if you do not
  forbid them.

## Writing a location view brief

In the location file, under `## Establishing Image Brief`:

```markdown
## Establishing Image Brief

Image target: `images/establishing.png` (1:1). A bright harbor view
from waist height on the central planks. Mid-ground: a tall white
skyship descending, a cargo crane lifting a turquoise net, the
colored awning of the customs hut. Foreground: porters in red
sashes, a rival team near crates, a young woman in a green coat at
the notice post. Strong sun, optimistic but not safe. Square
composition with a clear focal point in the center.
```

Notice the layered structure: foreground, mid-ground, background.
That gives the image depth even at 1:1. Concrete details — "porters
in red sashes," "young woman in green coat" — turn a landscape into
a small living scene.

When you compose a wide place for a square frame, think in terms of
**a single focal point** with supporting elements around it. A
sprawling panorama loses the square; a centered tableau owns it.

## Writing an item icon brief

In the item file, under `## Visual Brief`:

```markdown
## Visual Brief

Image target: `images/icon.png` (1:1). A small straw-wrapped brass
compass, lid open, the letter J engraved on the inner cover. Wood
grain visible under it. Soft side light, warm muted background, no
strong cast shadow. Clear silhouette, recognizable at thumbnail
size. No text legible enough to read.
```

Icons must be **recognizable at a glance**. The brief therefore
prioritizes clarity, contrast, and silhouette. A common trap with
icons is too much detail: a complex icon at 64×64 turns into a
smudge. State the silhouette first and let the artist (or the
generator) carry the rest.

## Writing a scene plate brief

In the scene file, under `## Scene Image Brief` (optional — most
scenes do not need one):

```markdown
## Scene Image Brief

Image target: `images/key.png` (1:1). The moment the compass leaves
Tessa's hand into the hero's. Two pairs of hands, close-up, the
brass catches the warm low sunlight off the harbor water. Background
softly out of focus: the blue of distant water. Centered hands,
square crop. No faces required, no text.
```

A good scene plate is **one frame, one moment** — the way a film
director picks the single still that represents the scene. Resist
the urge to cram the whole sequence into one image.

## What happens at compile time

To make the off-stage clear:

1. You either have a `## ... Brief` in the entity file (an agent
   will draw it), or you have already placed the image manually at
   the correct path.
2. When the cartridge is assembled, the compiler walks the folders,
   finds the picture by its expected name, and links it to the entity
   in the compiled cartridge.
3. The runtime serves the image to the game interface when the
   entity comes on screen.

If a picture is missing, the engine falls back to a placeholder.
Nothing crashes; the world simply runs without that image until you
add one.

## A short checklist

- [ ] Every image is **square** (1:1).
- [ ] File names match exactly: `portraits/default.png`,
      `images/establishing.png`, `images/icon.png`, scene image at
      `images/key.png` or `images/<scene-slug>.png`.
- [ ] Boot/title media, if used, lives under `GreenHavenWorld/media/boot/`.
- [ ] One consistent style across the whole cartridge.
- [ ] Briefs (if used) include a `target:` line, subject, light,
      composition, and a "no text, no UI" negative.
- [ ] The image is readable at thumbnail size.
