# Cartridge Output Contract

Generated artifacts live under:

```text
.greenhaven-agent-manual/generated/
  import-diff.md
  unresolved-links.md
  world-graph.draft.md
  image-generation-plan.md
  image-generation-plan.jsonl
  cartridge-forge-project/
    forge.project.json
    sources.jsonl
    records/
      locations.jsonl
      scenes.jsonl
      people.jsonl
      items.jsonl
      quests.jsonl
      world-facts.jsonl
    visual-packs/
```

Prefer existing Cartridge Forge shapes:

- `forge.project.json` with `target_cartridge_id`, normally `grinhaven-full`;
- `records/*.jsonl` using `greenhaven.cartridge_ingest_record.v1`;
- visual packs compatible with Cartridge Forge / Sticker Studio;
- SQL output through the existing `export-grinhaven-sql` path when code support
  exists.

Do not compile from old machine-vault prototypes or exported entity cards when
the Obsidian vault exists. Those artifacts are legacy/debug inputs only.

## Entity Name Mapping

Human `@` markers are not stored with the leading `@`.

| Human source | Cartridge field |
| --- | --- |
| folder `@Mikka` | `canonical_name: "Mikka"` |
| runtime display | `display_name: "Mikka"` in generated SQL/entity row |
| player-facing prose | `@Mikka` |
| slug | `mikka` |
| path provenance | original vault path under `payload.source_path` |

When generating records, include useful aliases in `payload.db_profile_json` or
payload fields that become `entities.profile.aliases`. This lets Greenhaven's
runtime `scanMentions()` resolve both canonical names and authored aliases.

Do not generate `display_name` values that include `@`.
Do not translate generated `display_name` values in i18n. If the target output
requires `i18n.display_name`, fill every language with the exact canonical
`display_name`. Localized labels can live in prose fields, but runtime mentions
must remain `@Mikka`, `@Town square`, `@Thief's market`, etc. in every language.

## Required Diff Sections

`import-diff.md` should include:

1. Start location candidate and source wikilink from `WORLD_MANIFEST.md`.
2. New or changed locations.
3. NPC placement inferred from folder context.
4. Item/object placement inferred from folder context.
5. Quest/action sources inferred from `quests/` folders.
6. Scene ownership inferred from `scenes/` folders, including NPC behavior
   scenes.
7. Renderable parent/child lists inferred from folder structure, without
   requiring manual index links in parent notes.
8. Hidden discoveries and exits inferred from prose.
9. Materialization candidates from explicit `Materializes` sections.
10. Merchant offers, prices, and payment-memory contracts.
11. Visual asset candidates.
12. Runtime `@` mention risks: duplicate first names, unresolved `@Name`, names
   that differ only by case/apostrophe, or names not present in generated
   display names/aliases.
13. Blocking ambiguities.

## Runtime Mapping Targets

- Start location -> `cartridge_meta.starting_location_id` after canonical entity
  resolution.
- Location notes -> `entities.kind = location`, topology, exits, narrator brief.
- Location scene notes -> `entities.kind = scene`, participant ids, state
  fields, model instructions, location id, and no single NPC owner.
- NPC-owned scene notes -> `entities.kind = scene` or entity-instruction
  candidates with `owner_npc`, location context, trigger/visibility when
  present, allowed actions, forbidden generic behavior, and runtime state
  changes. Conditional behavior scenes can also project `behavior_owner`,
  trigger, and priority.
- NPC notes -> `entities.kind = person`, profile/persona/appearance.
- Item notes -> item/fixture/container entities and placement.
- Quest notes -> quest records, source entity, stages, prepared entities.
- Secret openings -> runtime field, action/unlock, reveal rule, optional quest
  fallback if generic actions are not implemented yet.
- Currency item notes -> global item definitions and canonical value in copper
  units.
- NPC `Merchant` sections -> merchant offers, direct prices, payment/debt
  memory rules, active-service state, and expiration terms.
- `Materializes` sections -> validated materializer blueprints for any target
  type: location, item, NPC, scene, quest, service, access, or state. Parser
  keys are English (`Entity`, `Type`, `Scope`, `Effect`). Existing targets
  become open/link operations; missing targets become reviewable
  create-candidates with source path provenance.
- NPC `Appearance` -> `profile.appearance`; this can inform portraits and
  public/default descriptions.
- NPC `Sexual Appearance` -> `profile.sexual_appearance`,
  `profile.intimacy_boundaries`, and `profile.adult_scene_guidance`; this must
  stay out of image-generation prompts and public/default scene briefs.

## Current Sample Mapping

The current human vault should map roughly as:

- `@Town square/TownSquareMind.md` -> location `town-square`.
- `@Mikka/MikkaMind.md` -> person `mikka`, home/location `town-square`.
- `@Barrels in the square/BarrelsMind.md` -> item/fixture
  `barrels-in-the-square`, location `town-square`.
- `Way to Thief's market.md` under the barrels' `quests/` folder -> action
  unlock sourced from `barrels-in-the-square`, not an ordinary unrelated quest.
- `@Thief's market/Thief'sMarketMind.md` -> hidden/reveal location
  `thiefs-market`.

Do not apply DB writes without a reviewable diff and validation pass.

## Visual Asset Planning

The Python image planner/generator reads the same vault scan as the compiler and
produces review artifacts before any provider call:

- `.greenhaven-agent-manual/generated/image-generation-plan.md`
- `.greenhaven-agent-manual/generated/image-generation-plan.jsonl`

Default output paths:

| Entity kind | Role | Output |
| --- | --- | --- |
| person | `portrait` | `npc/@NPC/portraits/default.png` |
| item | `item_icon` | `items/@Item/images/icon.png` |
| location | `location_view` | `@Location/images/establishing.png` |
| scene | `scene_plate` | owner `images/<scene-slug>.png` |

The local provider key is never part of generated artifacts. If initialized, it
lives under `.greenhaven-agent-manual/local/gemini-image.env`, which is a local
secret path.
