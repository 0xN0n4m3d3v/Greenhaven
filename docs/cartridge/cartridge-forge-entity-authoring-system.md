# Cartridge Forge Entity Authoring System

## Goal

Cartridge Forge must create playable Greenhaven cartridges as a connected world
graph, not isolated rows. The authoring hierarchy is:

```text
cartridge
  power_center
    location
      scene
        NPC / item / event / clue
          quest hook
            quest stages
              rewards / consequences / state changes
```

Every entity must have a canonical slug, source/provenance, gameplay purpose,
visual generation brief, and links to the entities it depends on.

## Research Notes

The workflow layer should follow a node-editor model: React Flow supports
sub-flows for grouped child nodes, Rete separates editor graph data from engine
processing, and n8n keeps workflow executions inspectable with status, timing,
and node-level data. Narrative tools such as QuestMap, Arcweave, Drafft, and
NarrativeFlow converge on the same pattern: visual maps plus structured detail
tables for characters, locations, items, quests, variables, and conditions.

For image generation, ComfyUI's node/workflow model is the strongest local
reference for repeatable visual pipelines. Gemini API image generation supports
text-to-image, image+text editing, multi-image composition, iterative
refinement, and Imagen for higher-quality specialized output. Forge should keep
provider adapters replaceable: Gemini first because Sticker Studio already uses
it, ComfyUI later for local/advanced pipelines.

Sources:

- React Flow sub-flows: https://reactflow.dev/learn/layouting/sub-flows
- Rete editor/engine concepts: https://retejs.org/docs/concepts/editor
- n8n executions: https://docs.n8n.io/workflows/executions/
- ComfyUI docs: https://docs.comfy.org/
- Gemini image generation: https://ai.google.dev/gemini-api/docs/image-generation
- Arcweave: https://arcweave.com/
- Drafft: https://drafft.dev/
- NarrativeFlow: https://narrativeflow.dev/

## Workbench Areas

Forge should have six persistent workbench lanes:

1. **World Graph** - cartridge, power centers, locations, parent/exit graph.
2. **Scene Board** - scenes inside selected location with participants, objects,
   mood, entry conditions, and state fields.
3. **Cast & Props** - NPCs and items attached to locations/scenes.
4. **Quest Graph** - quests from NPCs, items, or environmental clues.
5. **Visual Studio** - reference images, sticker variants, item icons, location
   plates, scene plates, manifests, and asset attachment.
6. **Execution Log** - validate, AI-fill, generate visuals, attach, export.

## Location Entry

Required fields:

- `slug`, `canonical_name`, `summary`, `tags`
- `location_kind`: hub, room, street, building, district, wilderness, dungeon
- `parent_slug`, `power_center_role`, `exits`
- `narrator_brief`, `mood_axes`, `default_hooks`
- `scene_slugs`, `resident_npc_slugs`, `placed_item_slugs`
- `visual_brief`: architecture, palette, lighting, recognizable features

Validation:

- Must have at least one exit unless it is a root power center.
- Must have at least three playable hooks.
- Must link to at least one scene after authoring is complete.
- Must not reference numeric database ids.

## Scene Entry

Required fields:

- `location_slug`, `participant_slugs`, `item_slugs`
- `entry_conditions`, `exit_conditions`
- `state_fields`: flags, clocks, hazards, tension, intimacy, pressure
- `model_instructions`: what the GM must surface within two turns
- `scene_plate_brief`: composition, focal point, emotional temperature

Scenes are the runtime stage for interaction. They should answer: who is here,
what can be touched, what pressure exists, what changes if the player acts
unexpectedly.

## NPC Entry

Required fields:

- `home_slug` or `faction_slug`
- `role`, `desire`, `fear`, `leverage`, `relationship_defaults`
- `speech_style`, `registers`, `forbidden_voice_drift`
- `quest_giver_profile`: yes/no, trusted topics, price, refusal style
- `visual_identity`: body, face, silhouette, outfit, repeated marks
- `sticker_pack`: neutral, pleased, suspicious, angry, wounded, intimate,
  bargaining, quest-giver, travel-ready

NPC generation must produce both game data and visual briefs. A generated NPC is
not complete until it has a reason to talk, a reason to refuse, a scene anchor,
and a visual identity that can survive multiple sticker generations.

## Item Entry

Required fields:

- `item_kind`: quest_hook, tool, consumable, key, trade_good, weapon, document,
  relic, clothing, container, clue
- `location_slug` or `holder_slug`
- `use_contract`: what player actions it supports
- `trade_contract`: price, barter tags, refusal/acceptance conditions
- `quest_contract`: can start, advance, block, or complete a quest
- `visual_identity`: silhouette, material, scale, marks, damage, icon prompt

Items must be interactable. Decorative props belong in scene text; authored
items need state consequences.

## Quest Entry

Quest sources can be:

- NPC request;
- item discovery;
- environmental clue;
- faction/order notice;
- event outcome.

Required fields:

- `giver_slug` or `source_item_slug` or `source_scene_slug`
- `start_location_slug`
- `objective`, `stakes`, `player_freedom`
- `prepared_entity_slugs`: NPCs/items/locations/scenes needed to run it
- `stages`: accept, investigate, act, complication, resolution
- `success_state_changes`, `failure_state_changes`, `rewards`
- `followup_hooks`: at least one continuation or consequence

Quests should avoid single-track errands. Every quest needs at least one
nonstandard action route: bargain, theft, deception, violence, refusal,
shortcut, asking a different NPC, or using the wrong item creatively.

## Visual Asset Entry

Every cartridge entity can have visual assets:

- NPC: reference + expression/action stickers.
- Location: establishing plate + detail hook plates.
- Scene: mood plate + state variant plates.
- Item: inventory icon + close detail image.
- Quest: card art only when needed for marketing/UI.

Visual packs store:

```text
visual-packs/<pack-name>/
  character.yaml
  reference.png
  raw/*.png
  stickers/*.png
  manifest.jsonl
```

The manifest attaches to entity payloads by `entity_slug`. Generation jobs must
store provider, model, prompt, seed/request id when available, source entity,
and review status.

## AI Generation Rules

- Generate structured cartridge fields first, then visual prompts.
- Keep slugs canonical. Do not invent aliases as a workaround.
- Use compact context: selected entity, linked parents/children, sources, and
  current validation errors.
- All AI output lands as a patch or draft until validation accepts it.
- Image generation must preserve visual identity by reusing reference prompts
  and prior approved images.

## Next Implementation Slices

1. Add entity hierarchy endpoints and UI filters by parent/location.
2. Add per-kind detail wizards for location, scene, NPC, item, quest.
3. Add visual generation jobs and asset gallery.
4. Add quest-source creation from selected NPC/item/scene.
5. Add graph validation: missing scenes, orphan NPCs/items, quest dependencies.
6. Add live preview export and import pipeline handoff.
