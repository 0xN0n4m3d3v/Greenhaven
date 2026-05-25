---
name: greenhaven-world-author
description: Create and update human-editable Greenhaven Obsidian vault notes from natural-language requests. Use when a writer asks an AI agent to add a new NPC, item, location, scene, quest, hidden path, action unlock, portrait/media placeholder, or to expand GreenhavenWorld without writing YAML, JSON, SQL, IDs, or cartridge records by hand.
---

# Greenhaven World Author

Create writer-facing notes inside the active world directory selected by
`GreenhavenWorld/WORLD_MANIFEST.md`. This
skill does not compile or import cartridge data; it prepares clean human
source material for the compiler skill.

## Core Rules

- Treat the visible Obsidian vault as the only authoring source of truth.
- Do not add YAML frontmatter, JSON blocks, SQL, numeric DB ids, or `GH[...]`
  syntax to human notes.
- Use canonical runtime mentions as `@Name` in folder names and prose.
- Never translate `@Name` tokens. Russian prose may say "Микка", but the live
  link remains `@Mikka`.
- Preserve the writer's folder logic. Do not create `00_System`, `01_Atlas`,
  or other machine-first visible folders.
- Do not maintain manual index blocks such as "Quests and scenes" inside NPC,
  item, or location notes. Child quests, NPC scenes, location scenes, images,
  and portraits are rendered from folder structure by the compiler.
- Do not put image API keys, model names, or generation settings into human
  notes. Visual generation is handled by the transformer skill and local hidden
  config.
- Do not put compiler/importer/runtime-field instructions in visible character
  notes. No `profile.*`, "compiler should", "generator should", or similar
  meta-rules inside NPC prose.
- Put generated machine files nowhere. The compiler skill owns
  `.greenhaven-agent-manual/generated/`.

## Placement

Use this layout:

```text
<ActiveWorldDir>/
  Economy/
    Currency.md
    items/
      @Gold coin/
        GoldCoinMind.md
  Locations/
    @Region or city/
      @Location/
        LocationMind.md
        scenes/
          @Location Scene.md
        npc/
          @NPC/
            NPCMind.md
            portraits/
            images/
            scenes/
              @NPC Scene.md
            quests/
              Quest Name.md
        items/
          @Item/
            ItemMind.md
            images/
            quests/
              Quest Name.md
```

Use `portraits/` beside NPC notes for character portraits and `images/` beside
items, locations, or NPCs for generated or hand-made visual assets. The writer
does not need to list these files manually inside the parent note.

If the request does not name a parent location, search existing notes for the
best parent. If still unclear, create the note under the most likely parent and
leave a short `## Вопросы автору` question inside the note.

## Templates

Use the hidden templates at:

```text
.greenhaven-agent-manual/templates/human/
```

Choose the closest template:

- `LocationMind.template.md`
- `SceneMind.template.md`
- `NPCScene.template.md`
- `NPCMind.template.md`
- `ItemMind.template.md`
- `Quest.template.md`
- `ActionUnlock.template.md`
- `UNIVERSAL_NOTE_TEMPLATE.md`

Copy the structure conceptually, then fill it with the user's request in plain
prose. Delete irrelevant sections only when they would distract a writer.

For merchants and paid services, read:

- `references/merchant-authoring.md`

## Creation Workflow

1. Read `WORLD_MANIFEST.md` and the nearest parent note.
2. Search for existing `@Name` folders and note files to avoid duplicates.
3. Decide entity kind and path from the request.
4. Create the folder with a leading `@` for game entities.
5. Create the note file:
   - location: `LocationMind.md` or a readable existing convention such as
     `TownSquareMind.md`;
   - location-owned scene: `@Location/scenes/@Scene Name.md`;
   - NPC-owned scene: `npc/@NPC/scenes/@Scene Name.md`;
   - NPC: `<ShortName>Mind.md`;
   - item: `<ShortName>Mind.md`;
   - quest: `quests/<Quest Name>.md`;
   - action unlock: quest/action note under the source entity's `quests/`.
6. Fill the note in the writer's language.
7. Add canonical `@` links only where the prose needs a cross-entity
   relationship. Do not add parent-to-child index links for notes that already
   live under `quests/`, `scenes/`, `images/`, or `portraits/`; the transformer
   derives those from folder placement.
8. If the request implies a hidden place, write the reveal rule in plain prose:
   "если игрок делает X, открывается @Hidden location".
9. For every NPC, generate `Appearance` and `Sexual Appearance` sections by
   default. The note itself stays character canon only, preferably in first
   person. `Appearance` is non-explicit character appearance; `Sexual
   Appearance` is adult-only character appearance. Do not explain compiler,
   profile, image-generation, or runtime rules inside either section.
10. If the request creates an adult romance/intimacy NPC, include both sections.
    Keep adult appearance in the NPC note so the compiler can preserve sexual
    appearance, intimacy boundaries, and adult-scene guidance separately from
    ordinary appearance.
11. If the user provides explicit adult anatomy for a consenting adult NPC,
    preserve the authored details in the adult-only section. Do not sanitize
    them into vague euphemisms; add boundaries/guidance around them instead.
12. If the request describes a scene centered on one NPC, create it under that
    NPC as a file: `npc/@NPC/scenes/@Scene Name.md`. This includes first
    meetings, romance/intimacy beats, trade beats, combat reactions, fear,
    betrayal, routines, and companion behavior.
13. Use `@Location/scenes/` only for scenes owned by the place itself: crowd
    events, weather, patrols, public rituals, ambience, disasters, or
    multi-entity beats that are not primarily one NPC's scene.
14. If the NPC scene is conditional behavior, include trigger, priority,
    behavior, runtime state, voice, and "do not" constraints.
15. If an NPC sells anything, add a `Merchant` section with direct prices in
    `@Gold coin`, `@Silver coin`, or `@Copper coin`, plus what the NPC remembers
    about payment, debt, change, active service, and expiration.
16. If any action, purchase, quest, item, or scene creates or opens another
    entity, add a `Materializes` section. Use it for all target types:
    locations, items, NPCs, scenes, quests, services, access, and states. Put
    the target on an `Entity:` line so the transformer can treat a missing
    target note as an explicit materialization candidate, not a broken link.

## Canonical Mentions

- Folder `@Mikka` -> runtime mention `@Mikka`.
- DB/compiler display name later becomes `Mikka`, without `@`.
- Add aliases in prose only when the writer explicitly wants them.
- Do not generate localized aliases just because the prose language changed.

## After Creating Notes

Tell the user:

- which notes were created or updated;
- which `@Name` links were introduced;
- which open questions remain for the writer;
- that compilation is a separate step handled by
  `greenhaven-human-world-transformer`.

## Demo Vault Script

To generate the canonical demo vault shape from Python, run:

```bash
python .greenhaven-agent-manual/skills/greenhaven-world-author/scripts/generate_demo_vault.py --dry-run
```

Use `--force` only when intentionally overwriting the demo notes. The generated
NPC notes use English section names and first-person character prose.
