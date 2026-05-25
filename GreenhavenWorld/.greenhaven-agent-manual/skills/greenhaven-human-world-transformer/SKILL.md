---
name: greenhaven-human-world-transformer
description: Compile Greenhaven's human-authored Obsidian vault into reviewable cartridge state. Use when asked to transform, validate, diff, compile, or import the active world directory selected by GreenhavenWorld/WORLD_MANIFEST.md into Cartridge Forge artifacts, Greenhaven SQL/import drafts, world graphs, unresolved-link reports, or runtime @mention-safe cartridge records.
---

# Greenhaven Human World Transformer

Use this skill to turn the writer-facing Obsidian vault into a machine-readable
Greenhaven cartridge projection. The visible vault is the authoring source of
truth; all generated machine data belongs under `.greenhaven-agent-manual/generated/`.

## Core Rule

Do not require writers to add YAML, JSON, SQL, `GH[...]` lines, numeric IDs, or
technical frontmatter. Read human prose and folder context, then emit a
reviewable diff. Ambiguity becomes a question in the diff, not a guessed DB
write.

Obsidian is canonical for new cartridge content. Existing migrations, Entity
Card I/O, old Forge exports, and historical seed SQL are compatibility/runtime
material; do not treat them as the authoring source when the vault disagrees.

## Workflow

1. Read `WORLD_MANIFEST.md` as prose. Extract the start location from the
   start-location section described in `references/human-vault-contract.md`.
2. Walk the active world directory recursively. Treat it as the source of authored
   world truth.
3. Classify notes from folder context:
   - `Locations/.../@<location>/<LocationMind.md>` -> location.
   - `Locations/.../@<location>/scenes/@<scene>.md` ->
     location-owned scene in that location.
   - `Locations/.../@<location>/items/@<item>/<ItemMind.md>` -> item, fixture,
     or container present in the containing location.
   - `Locations/.../@<location>/npc/@<npc>/<NpcMind.md>` -> NPC present in the
     containing location.
   - `Locations/.../@<location>/npc/@<npc>/scenes/@<scene>.md` ->
     NPC-owned scene. This includes first meetings, relationship beats,
     conditional behavior, trade, intimacy, fear, betrayal, and companion
     actions.
   - `Economy/items/@<coin>/<CoinMind.md>` -> global currency item, not placed
     in one location by default.
   - `items/<item>/quests/*.md` -> quest or unlock sourced from that item.
   - `npc/<npc>/quests/*.md` -> quest sourced from that NPC.
   - `images/`, `media/`, `portraits/`, and `stickers/` beside an entity ->
     visual asset candidates for that entity.
   - parent/child rendering is structural: do not require NPC, item, or
     location notes to contain manual lists of their quests, scenes, or assets.
4. Generate hidden artifacts only:
   - `.greenhaven-agent-manual/generated/import-diff.md`
   - `.greenhaven-agent-manual/generated/unresolved-links.md`
   - `.greenhaven-agent-manual/generated/world-graph.draft.md`
   - `.greenhaven-agent-manual/generated/cartridge-forge-project/`
5. Validate start location, duplicate slugs, unresolved references, hidden
   exits, quest sources, visual assets, and cartridge scope before proposing any
   import.
6. If implementation code exists, use Cartridge Forge project shapes and
   `export-grinhaven-sql` rather than inventing a parallel cartridge format.
7. Preserve Obsidian-style `@Name` tokens as canonical runtime mention keys in
   every language. Do not translate `display_name`, generated `@mentions`, or
   generated `i18n.display_name` values.
8. Keep existing relationship mechanics. For NPC bonds, map human relationship
   prose into `strings`, memories, companion offers, and quest stages; do not
   invent a second love meter unless the runtime implements it.
9. For NPC visuals, keep `Appearance` separate from `Sexual Appearance`.
   `Appearance` can feed portraits, ordinary scene descriptions, and
   `profile.appearance`; `Sexual Appearance` is preserved for adult-scene
   profile fields but must be stripped from image generation prompts and
   public/default scene briefs.
10. Treat visible NPC notes as character canon only. Compiler/importer field
    mapping lives in this skill and reference docs, not in the human note.
11. Treat `Merchant` sections as trade contracts: extract prices, currency,
    service duration, payment memory, debts, active access, and item/service
    offers.
12. Treat `Materializes` sections as explicit materializer input for every
    target type, not only rooms: locations, items, NPCs, scenes, quests,
    services, access, and states. A missing `@Name` on an `Entity:` line is a
    candidate to create, not an unresolved ordinary mention. Parser-facing keys
    in this block are English (`Entity`, `Type`, `Scope`, `Effect`) even when
    the surrounding prose is Russian.

## References

- Read `references/human-vault-contract.md` when interpreting the writer's
  folder layout.
- Read `references/runtime-at-mentions.md` before generating names, aliases,
  player-facing hooks, narrator briefs, or any prose that contains `@Name`.
- Read `references/cartridge-output-contract.md` when writing generated
  artifacts or planning importer/exporter code.
- Treat `.greenhaven-agent-manual/templates/human/` as the note-shape source for
  expected human sections. There is no visible machine-vault prototype.

## Script

For a deterministic preview before full importer code exists, run:

```bash
python .greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/compile_vault_preview.py
```

It scans the visible vault, writes `import-diff.md`, `unresolved-links.md`, and
`world-graph.draft.md`, reports visual asset candidates/missing canonical
images, and performs no DB writes.

The PowerShell `compile-vault-preview.ps1` file is only a compatibility wrapper
around the Python script. Keep scan and compile logic in Python.

To compile the visible vault into a real Cartridge Forge JSONL project, run:

```bash
python .greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/compile_vault_to_forge.py --vault-root C:\Greenhaven\GreenhavenWorld
```

This writes:

```text
.greenhaven-agent-manual/generated/cartridge-forge-project/
  forge.project.json
  sources.jsonl
  records/*.jsonl
  audit/import-diff.md
  audit/unresolved-links.md
  audit/conflicts.md
  audit/materializes.jsonl
  audit/merchant-contracts.jsonl
  audit/visual-assets.jsonl
```

The section parser lives in `scripts/vault_sections.py`. After compiling,
validate with:

```bash
npm --prefix packages/cartridge-forge run forge -- validate C:\Greenhaven\GreenhavenWorld\.greenhaven-agent-manual\generated\cartridge-forge-project
```

SQL export is validation-gated. The preferred safe wrapper compiles the vault,
validates the Forge project, exports a reviewed SQL draft, and writes an audit
report without touching the DB:

```bash
python .greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/export_vault_sql.py --vault-root C:\Greenhaven\GreenhavenWorld --dry-run
```

To create the next forward-only web-server migration after the dry-run is clean,
run:

```bash
python .greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/export_vault_sql.py --vault-root C:\Greenhaven\GreenhavenWorld --write-migration
```

To prove the full temporary roundtrip through a database, first run the dry-run
SQL export above, then run:

```bash
npm --prefix packages/web-server run obsidian:roundtrip-smoke
```

This imports the generated SQL into a temporary PGlite database, reads
`entities`, `runtime_fields`, and `cartridge_meta` back from the DB, and writes
a new temporary Obsidian vault. Source path and source Markdown are preserved in
DB profile fields so an imported Obsidian note can be exported back to the same
human folder path without losing prose sections.

Manual SQL export remains available for debugging. For a reviewed SQL draft, run:

```bash
npm --prefix packages/cartridge-forge run forge -- export-grinhaven-sql C:\Greenhaven\GreenhavenWorld\.greenhaven-agent-manual\generated\cartridge-forge-project C:\Greenhaven\GreenhavenWorld\.greenhaven-agent-manual\generated\cartridge-forge-project\audit\obsidian-world-preview.sql
```

Use `--force` only for explicit debug work on an invalid project.

To plan missing visual assets without calling an API, run:

```bash
python .greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/generate_vault_images.py plan
```

To initialize local Nano Banana 2 image generation, run:

```bash
python .greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/generate_vault_images.py init
```

The init command prompts for a Gemini API key and writes only
`.greenhaven-agent-manual/local/gemini-image.env`. Never put API keys in
visible Obsidian notes, templates, generated review artifacts, or specs.

To generate a small dry run first:

```bash
python .greenhaven-agent-manual/skills/greenhaven-human-world-transformer/scripts/generate_vault_images.py generate --kind person --limit 3 --dry-run
```

The image generator defaults to `gemini-3.1-flash-image-preview`
(Nano Banana 2) and writes generated assets beside the source entity:

- people: `portraits/default.png`
- items: `images/icon.png`
- locations: `images/establishing.png`
- scenes: the owner's `images/<scene-slug>.png`

## Safety Rules

- Do not move, rename, or rewrite human notes unless explicitly requested.
- Preserve the author's language and phrasing in generated summaries.
- Never silently materialize entities from loose prose. A new materialized
  target needs an explicit `Materializes` section with an `Entity:` target
  line, or it stays in `unresolved-links.md`.
- Do not import directly into the DB from prose. Generate a diff first.
- Do not delete DB rows because a human note disappeared.
