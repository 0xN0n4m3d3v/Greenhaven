# Cartridge authoring guide

## Current workflow: Obsidian first

The active game-master workflow is now Obsidian-first:

```text
GreenhavenWorld/
|-- WORLD_MANIFEST.md
|-- GreenHavenWorld/
`-- .greenhaven-agent-manual/
```

Authors write locations, NPCs, quests, scenes, items, media, and boot assets as
human Markdown notes under `GreenHavenWorld/`. The transformer compiles that
vault into Cartridge Forge records, import jobs, asset manifests, and the
default packaged cartridge database.

The older SQL and JSONL sections below are still useful for generated datasets,
low-level debugging, and historical migrations. They are not the recommended
starting point for a game master building a playable world.

For current media rules, see
[media-and-boot-assets.md](media-and-boot-assets.md) and
`Gamemasters-v2/03-mechanics/Media.md`.

Autonomous research agents that generate new cartridge datasets should use the
strict JSONL pack format in
[agent-dataset-pipeline.md](agent-dataset-pipeline.md). That format requires
stable slugs, explicit location/NPC/quest links, source provenance, and
validation before generated content becomes a migration.

Game-master authoring now starts with
[cartridge-forge.md](cartridge-forge.md). Visual assets for NPCs, locations,
buildings, scenes, and items are produced through the Node Sticker Studio flow
in [sticker-studio-node.md](sticker-studio-node.md) and attached to Forge
records before export.

Compiled Greenhaven cartridges ultimately become database content plus an asset
manifest/cache. The cartridge IS the world: NPCs, locations, scenes, items,
quests, sex moves, surfaces, persona archetypes, media, and boot atmosphere all
become runtime state. Author current playable content in the Obsidian vault,
not in application code.

## Entity shape

Every "thing" in the world is a row in [entities](../db/schema.md). Defined at [packages/web-server/migrations/0001_cartridge.sql:25-39](../../packages/web-server/migrations/0001_cartridge.sql#L25-L39):

```sql
INSERT INTO entities (id, kind, display_name, summary, profile, tags, i18n)
VALUES (
  200, 'person', 'Mikka Quickgrin',
  'Goblin info-broker working Quickgrin Lane.',
  '{...}'::jsonb,
  ARRAY['intimacy', 'merchant'],
  '{"ru": {...}, "ja": {...}}'::jsonb
);
```

| Column | Notes |
|---|---|
| `id` | Reserved ranges: locations 100-199, NPCs 200-299, items 300-399, quests 700-799. `0004_sequence_fix.sql` pushes the BIGSERIAL counter past these so dynamic creates don't collide. |
| `kind` | `'person' \| 'location' \| 'scene' \| 'item' \| 'quest' \| 'event' \| 'district' \| 'service' \| 'thread' \| 'world' \| 'class' \| 'skill'`. |
| `display_name` | Canonical English form. The `@`-mention key. NEVER change after content lands — it's the FK that prose uses. |
| `summary` | Short brief. Surfaces in preamble. |
| `profile` | Free-form JSONB. Kind-specific bag — see [Profile fields](#profile-fields). |
| `tags` | TEXT[]. Fast-search side-channel. Conventions in [Tags conventions](#tags-conventions). |
| `i18n` | JSONB `{lang: {display_name?, summary?, profile_text?}}`. See [i18n](#i18n). |

After the entity row, declare its runtime fields (`runtime_fields` + `runtime_values`) and any cartridge instructions (`entity_instructions`). The `entity_instructions` block surfaces narrative rules + quick-action buttons gated by `applies_when` predicates — see [packages/web-server/migrations/0001_cartridge.sql:114-122](../../packages/web-server/migrations/0001_cartridge.sql#L114-L122).

## Profile fields

The `profile` JSONB carries everything kind-specific. Common keys:

**For `kind='person'` (NPCs):**

| Key | Type | Meaning |
|---|---|---|
| `species` | `string` | "human", "goblin", "elf", … |
| `narrator_brief` | `string` | What the narrator should know about this NPC |
| `archetype` | `string` | "info-broker", "innkeeper", "thug" |
| `speech_style` | `string` | Voice declaration. Driven by NPC Voice Engine + Voice Warden. See [persona-and-voice.md](persona-and-voice.md). |
| `persona` | `string` | Multi-paragraph persona description; same purpose as speech_style but richer. |
| `home_id` | `number` | The NPC's default location. Companions override (companion's "home" = player's location). |
| `sex_move` | `object` | Permanent post-intimacy effect. See [sex-moves.md](sex-moves.md). |
| `depart_when` | `predicate` | Companion auto-depart trigger. See [depart-conditions.md](depart-conditions.md). |
| `applies_when` | `predicate[]` | Cartridge-author rules for special states (immune-while, hostile-when). |

**For `kind='location'`:**

| Key | Type | Meaning |
|---|---|---|
| `exits` | `number[]` | Adjacency. Drives sidebar EXITS list and `move_player` validation. |
| `narrator_brief` | `string` | Scene-painting brief for the narrator. |
| `tags` | `string[]` | "indoor", "market", "danger" |
| `hidden_until_stage` | `string` | Quest gating. See below. |

**For `kind='quest'`:** see [db/quest-schema.md](../db/quest-schema.md).

**For `kind='item'`:** see [db/inventory.md](../db/inventory.md). Player-facing items also get an `items` row via the spec-35 consolidation; cartridge author writes the `entities` row, the back-fill (or runtime call) creates the `items` row.

**For `kind='world'`:** at most one per cartridge. `content_rating` (`'PG-13' | '21+' | …`), `tone` (`'openly erotic' | 'suggestive' | 'family-friendly'`), `narrator_brief` (global tone primer).

The engine reads `cartridge_meta` ([packages/web-server/migrations/0018_cartridge_meta.sql](../../packages/web-server/migrations/0018_cartridge_meta.sql)) for global pointers such as `starting_location_id`, `currency_item_id`, `default_class_id`, and reset seeds. Player display names are created by the character flow, not seeded by cartridge metadata. Engine code goes through `getMeta()` / `getMetaRequired()` ([packages/web-server/src/cartridge.ts](../../packages/web-server/src/cartridge.ts)) — never reference numeric ids of cartridge content directly.

## i18n

Translations live in two places:

1. **`entities.i18n`** — JSONB keyed by ISO-639 short code:
   ```json
   {
     "ru": {"display_name": "Микка Хитрогрин", "summary": "..."},
     "ja": {"display_name": "ミッカ・クイックグリン", "summary": "..."}
   }
   ```
   `@`-mentions ALWAYS use the canonical English `display_name` — the i18n entries are for prose only. Translating `@`-tokens breaks the click affordance.
2. **`mechanic_i18n_translations`** (migration `0040`) — UI labels for condition slugs, surface names, dice categories. Mounted at `/api/i18n` — frontend pulls.

`buildTurnContext` resolves the active player's `preferred_language` and renders the localized `display_name` / `summary` / `profile.narrator_brief` in the preamble. The narrator writes prose in that language, with `@`-mentions left in canonical English (per [packages/web-server/prompts/greenhaven.md:14](../../packages/web-server/prompts/greenhaven.md#L14)).

### Canonical mention keys

`display_name` is the runtime `@`-mention key, not a prose label. Treat it like
an Obsidian link target: `@Mikka Quickgrin` stays `@Mikka Quickgrin` in Russian,
Japanese, and every other language. Translate prose around the token, not the
token itself. Historical examples that show translated `i18n.display_name`
values are fossils; forward migrations normalize them back to the canonical
name because translated mentions break click, movement, dialogue, and discovery
affordances.

### Localization authoring workflow

Current localization storage is field-first: `entities.i18n[field][lang]`.
Older examples in this document may show legacy language-first JSON; new
cartridge content must use the field-first shape because that is what
`localizeEntity()`, strict cartridge validation, and the migration packs use.

Do not edit the large localization migrations by hand for routine translation
work. Export a normalized authoring pack, review it, diff it, then generate an
additive SQL migration.

Export JSON:

```powershell
npm --prefix packages/web-server run cartridge:i18n:export -- --format json --out C:\tmp\greenhaven-i18n.json
```

Export CSV for spreadsheet review:

```powershell
npm --prefix packages/web-server run cartridge:i18n:export -- --format csv --out C:\tmp\greenhaven-i18n.csv
```

Diff a reviewed pack against the current cartridge:

```powershell
npm --prefix packages/web-server run cartridge:i18n:diff -- --file C:\tmp\greenhaven-i18n.json
```

Generate migration SQL:

```powershell
npm --prefix packages/web-server run cartridge:i18n:migration -- --file C:\tmp\greenhaven-i18n.json --out C:\tmp\greenhaven-i18n-migration.sql
```

Release gate:

```powershell
npm --prefix packages/web-server run cartridge:i18n:check
```

Translator rule: edit only translation values for prose fields. For
`field="display_name"`, every language value must remain identical to the base
canonical name. Do not edit `entryId`, `source`, `entityId`, `field`, `path`,
`mechanicKey`, `originTemplateId`, canonical `display_name`, ids, slugs, or
`@` mention targets. The authoring pack schema is
`greenhaven.cartridge_i18n_authoring.v1`; see
[Spec 111](../../packages/web-server/plans/execution-roadmap/specs/111-cartridge-localization-authoring-workflow.md).

## Tags conventions

`tags TEXT[]` is the fast-search side-channel. The engine relies on a stable convention so cartridge authors and tools agree:

| Tag | Meaning |
|---|---|
| `intimacy` | NPC has intimacy hooks (sex_move, intimacy quests) |
| `merchant` | NPC trades inventory; surfaces in shop affordances |
| `combat` | NPC is statted for combat (HP, AC, prof) |
| `quest_giver` | Has at least one quest hook in `entity_instructions` |
| `currency` / `consumable` / `weapon` / `armor` / `material` / `quest_hook` | Item categories — drive the `items.category` mapping in mig 0046 |
| `inventory` | Item should be backfilled into `items` (vs scene fixture) |
| `companion_eligible` | Can be set as a companion via `set_companion(follow)` |
| `boss` | Combat encounter wraps in a multi-stage dynamic quest |
| `scene_fixture` | Skip from `items` backfill (Heavy Crate, Vendor's Cart) |
| `hidden` | Don't list in normal preamble; surface only via specific affordance |

`gin(tags)` index makes tag-filter queries fast. `search_entities(tag=…)` uses it.

## hidden_until_stage gating

Entities can be **gated** by quest stage. The pattern: an entity exists in the cartridge from day one (so ids are stable), but `profile.hidden_until_stage` blocks it from surfacing until a specific quest reaches a specific stage.

Used by:
- **Quest-spawned scenes/locations** — e.g. `kind='location'` for the cellar entrance, `hidden_until_stage='find_entrance'` on the Lost Cache quest. The location is real but not enumerable.
- **Boss combat foes** — multi-foe encounter wraps in a quest; foes #2 and #3 are seeded but `hidden_until_stage='turn_of_battle'` until the player reaches that stage.

Filtering in queries: `WHERE (profile->>'hidden_until_stage') IS NULL` — you'll see this pattern in `/api/session/:id/locations` ([packages/web-server/src/routes/session.ts:165](../../packages/web-server/src/routes/session.ts#L165)) and in `buildTurnContext`.

The narrator can still spawn a fresh entity inline via `create_entity` — that's the dynamic content path. Use `hidden_until_stage` for cartridge-prepared canon that has a known reveal point.

`spawn_entities[]` on `create_quest` is the live path: when a quest is started, optional entities are created or unhidden. See [quest-recipes.md](quest-recipes.md).

## Sources

- [packages/web-server/migrations/0001_cartridge.sql](../../packages/web-server/migrations/0001_cartridge.sql) — base schema for entities + runtime_fields + entity_instructions
- [packages/web-server/migrations/0003_seed_quickgrin.sql](../../packages/web-server/migrations/0003_seed_quickgrin.sql) — first cartridge seed; reference for shape
- [packages/web-server/src/cartridge.ts](../../packages/web-server/src/cartridge.ts) — engine-side `getMeta`/`getMetaRequired`
