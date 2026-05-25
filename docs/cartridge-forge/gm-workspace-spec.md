# Cartridge Forge GM Workspace Spec

## Status

Draft for immediate implementation. This supersedes the current "JSON-first
inspector" direction. JSON remains available only as a collapsed technical
debug/export layer.

## Product Goal

Cartridge Forge is a game-master workstation for creating and maintaining a
playable cartridge. A GM must be able to open any entity, edit every gameplay
property in normal fields, follow links to related entities, generate missing
content, validate playability, and export back to Greenhaven without reading or
writing raw JSON during ordinary authoring.

## Non-Negotiable Rules

- Default UI never shows raw JSON blocks.
- Every persisted property is visible and editable as its own field.
- No field value is truncated in the editor.
- Links are first-class navigation, not hidden strings.
- Every entity card shows outgoing links and backlinks.
- Technical JSON exists only in a collapsed "Technical data" section for debug.
- Save/export must preserve round-trip compatibility with JSONL and SQL.

## Workspace Layout

The main screen has three working surfaces:

- **Canvas**: graph of locations, scenes, NPCs, quests, items, events,
  activities, relationships, factions, dialogue, and world facts.
- **Entity Card**: the selected entity, with type-specific tabs and editable
  fields.
- **Link Panel**: all connected entities grouped by relationship, with clickable
  chips and create-link actions.

Clicking a chip selects and opens that entity. Example: NPC `Mikka` -> "Gives
quest: Whisper for Coin" opens the quest card. Quest card -> "Giver: Mikka"
opens the NPC card. The navigation keeps a back/forward stack.

## Entity Card Tabs

Every card has:

- **Overview**: name, full description, tags, status, quality/playable flags.
- **Gameplay Fields**: type-specific editable properties.
- **Connections**: outgoing links and backlinks.
- **Visuals**: attached/generate images, stickers, icons, scene plates.
- **Validation**: missing fields, broken links, export risks.
- **Technical Data**: collapsed JSON/debug view.

## Field System

The UI builds an `EntityViewModel` from `IngestRecord`:

- `record`: top-level fields such as kind, slug, name, description, tags.
- `payload`: normalized gameplay fields.
- `profile`: cartridge/runtime profile fields parsed from `db_profile_json`.
- `source`: imported canon fields parsed from `profile.source`.
- `links`: explicit links plus graph-derived backlinks.

The field renderer recursively expands objects and arrays into leaf controls:
`skills[0]`, `inventory[1].slug`, `stages[2].goal`,
`appearance.hands`, `relationship.description`, `mood_axes.warmth`. Empty
objects/arrays render as editable collection sections with add/remove controls.

## Type-Specific Fields

**Location**: kind, parent, exits, scenes, resident NPCs, placed items, events,
activities, quests, power-center role, mood axes, hooks, narrator brief.

**Scene**: location, participants, items, entry state, state fields, transition
rules, model instructions, active hooks.

**NPC / Person**: pronouns, species, occupation, home, faction, archetype,
appearance, backstory, speech style, dialogue registers, skills, inventory,
opinions, relationships, quests given, quests involved in, scene roles.

**Quest**: giver, objective, stages, stage locations, prepared entities, source
item/scene/event, rewards, complications, failure conditions, consequences,
turn-in, related NPCs/items/scenes.

**Item**: kind, holder, location/scene, visual asset, use contract, state,
price/value, rarity, quest usage, inventory behavior.

**Faction**: members, territories, reputation, allies, enemies, laws, resources,
quest hooks, authority boundaries.

**Relationship**: participants, relationship class, trust/warmth/tension,
shared history, opinions, gossip surface, scene hooks, quest hooks.

**Activity**: location, participants, schedule, trigger conditions, steps,
state changes, rewards, risks, follow-up hooks.

**Dialogue**: speaker, counterpart/participants, triggers, registers, lines,
intents, state changes, quest interactions.

**Event**: trigger, location, participants, timeline conditions, consequences,
state changes, generated hooks.

**World Fact**: canon text, category, affected entities, constraints, source,
where it should surface in gameplay.

## Link Model

Forge must compute and display:

- outgoing `record.links`;
- payload links such as `giver_slug`, `home_slug`, `location_slug`,
  `participant_slugs`, `prepared_entity_slugs`;
- backlinks from other records;
- visual asset links.

Each link row shows relation, target name, target type, validation state, and
actions: open, unlink, change target, create reciprocal link when appropriate.

## Canvas Focus & Search

The canvas always keeps the full project graph in memory, but the visible graph
may be narrowed without deleting or mutating records.

- Clicking any entity node selects it and shows the local subgraph: the selected
  node plus all directly connected incoming/outgoing neighbors.
- Focus/search mode lays visible nodes out as a compact table anchored at the
  selected or first matched node, so related entities are adjacent even when
  their saved full-graph positions are far apart.
- Clicking another visible node while already in focus mode only selects and
  opens that card; the compact table must not be rebuilt or shuffled.
- Re-focusing a compact graph is an explicit action: double-click the node or
  use the node context action to show links around that card. Re-focus uses the
  clicked node's current visible position as the anchor.
- Search filters entities by slug, type, name, tags, summary, payload fields,
  and links. Matching nodes are shown with their immediate neighbors so the GM
  sees context before opening a card.
- Pressing Enter in search opens the first direct match and switches to local
  focus mode.
- Pressing Esc or "Show all" clears focus/search, restores the full graph, and
  returns every node to its saved canvas position.
- Record lists and graph summaries must reflect the same visible scope as the
  canvas.

## Authoring Actions

Every entity supports context actions:

- create linked quest;
- create linked scene;
- create linked NPC/item/event/activity/dialogue as relevant;
- generate missing fields with AI;
- generate visual pack;
- validate this entity;
- show only local subgraph.

Actions must create both the new record and the correct link/backlink where the
contract requires it.

## Persistence Contract

All edits autosave through `PUT /api/projects/:slug/records/:recordSlug`.
Structured fields update the source object and then write back to:

- `payload`;
- `payload.db_profile_json`;
- `links`;
- top-level `IngestRecord` fields.

Export to SQL must merge edited fields into the database profile, not discard
them. Import/repair must not compact or truncate full descriptions.

## Validation

Validation must flag:

- broken links and missing backlinks;
- quest without giver/stages/prepared entities;
- NPC without home/faction/dialogue capability;
- scene without location/participants/state fields;
- item without holder/location/use contract;
- location without exits/scenes/hooks;
- any entity with technical JSON visible as primary GM content.

## Implementation Plan

1. Add `EntityViewModel` builder on the server with `fields`, `links`,
   `backlinks`, `tabs`, and `validation`.
2. Replace inspector body with GM card tabs and link panel.
3. Add typed field controls for text, long text, number, boolean, enum, slug
   reference, slug list, object collection, and array collection.
4. Add click navigation and back/forward history.
5. Hide JSON behind collapsed technical data.
6. Add create-link, unlink, change-target, and create-related-entity actions.
7. Add Playwright smoke for every entity type and bidirectional navigation.

## Acceptance Tests

- NPC card opens linked quest; quest card opens linked NPC.
- Quest stage location chip opens the location card.
- Location card lists scenes, resident NPCs, events, activities, quests.
- Relationship card opens both participants and all linked quests/scenes.
- Item card opens holder/location and all quests using the item.
- Every type exposes all leaf properties as editable fields.
- Technical JSON is collapsed by default.
- Editing a nested field persists after reload and survives SQL export/import.
- Full descriptions over 2,000 characters stay intact in the editor.
- Clicking a node in a 1,000+ entity project hides unrelated nodes and leaves
  only directly connected entities visible.
- Focused nodes are arranged as a compact table, while Esc restores their
  original full-graph coordinates.
- Searching a slug narrows the graph, and Enter opens that entity's local
  subgraph.
