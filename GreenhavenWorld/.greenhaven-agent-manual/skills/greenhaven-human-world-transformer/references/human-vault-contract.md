# Human Vault Contract

The visible vault is for writers and game masters. It should read like a world
binder, not a database export.

This vault is the canonical source for new cartridge authoring. Runtime seed
SQL, exported entity cards, and historical forge projects can be used as
compatibility references, but the writer-facing vault wins when content differs.

## Visible Root

```text
GreenhavenWorld/
  WORLD_MANIFEST.md
  GreenHavenWorld/
```

`WORLD_MANIFEST.md` is prose. It may contain ordinary Obsidian wikilinks and
plain headings. It must not require YAML/frontmatter or `GH[...]` relation
syntax.

The start location is the first location wikilink under the heading
`Начало игры` / `Start of the game`, especially after labels such as
`Стартовая локация:` or `Start location:`.

## Authoring Layout

```text
GreenHavenWorld/
  Locations/
    @<city or region>/
      @<location>/
        <LocationMind.md>
        images/
        scenes/
          @<scene>.md
        items/
          @<item>/
            <ItemMind.md>
            images/
            quests/
        npc/
          @<npc>/
            <NpcMind.md>
            images/
            scenes/
              @<scene>.md
            quests/
  Economy/
    Currency.md
    items/
      @Gold coin/
        GoldCoinMind.md
```

Folder context is authoring intent:

- folders starting with `@` are human entity markers;
- strip the leading `@` when producing `canonical_name`, `display_name`, and
  slugs;
- a note under a `@location` folder describes that location;
- `scenes/@name` directly under a location means a location-owned scene or
  recurring beat: crowd, patrol, weather, ritual, disaster, ambience, or a
  multi-entity place event;
- `items/@name` means the item/object is physically in that location;
- `npc/@name` means the NPC is normally in that location;
- `quests/` under an item/NPC means the item/NPC is the quest or action source;
- `npc/@name/scenes/@scene.md` means an NPC-owned scene: first
  meeting, relationship beat, conditional behavior, trade, intimacy, fear,
  betrayal, routine, or companion action. It is not a location event and not a
  quest;
- nearby `images/` belong to the nearest entity folder.
- `Economy/items/@name` means a global currency/economy item, not physically
  placed in one location by default.

Renderable parent/child lists are also folder-derived. Writers should not have
to maintain a "quests and scenes" block in the parent NPC, item, or location
note. The transformer must infer and render children from folders:

- `npc/@Mikka/quests/*.md` -> quests shown under @Mikka;
- `npc/@Mikka/scenes/@scene.md` -> NPC scenes shown under @Mikka;
- `items/@Barrels/quests/*.md` -> quests/action unlocks shown under @Barrels;
- `@Location/scenes/@scene.md` -> location scenes shown under that
  location.

Visual files are also folder-derived:

- `npc/@NPC/portraits/default.png` -> portrait for @NPC;
- `npc/@NPC/images/<scene-slug>.png` -> NPC-owned scene plate;
- `items/@Item/images/icon.png` -> item icon;
- `@Location/images/establishing.png` -> location establishing image;
- `@Location/images/<scene-slug>.png` -> location-owned scene plate.
- The same card roles may use `.webm` or `.mp4` instead of a still image.
  Audio files in nearby `media/`, `music/`, or `audio/` folders are imported
  as cartridge music assets and can be triggered from `## Media Script`.
- `## Media Script` is valid in location, NPC, and scene notes. Location
  scripts run on entry, NPC scripts run when dialogue focuses that NPC, and
  scene scripts run when the authored scene opens.

Do not place provider tokens, API keys, or image model configuration in visible
notes. The image generator prompts for a token at initialization time and stores
it only under `.greenhaven-agent-manual/local/`.

Folder context is not final database identity. Generated artifacts must create
stable slugs and preserve path provenance.

Empty `@` folders are placeholders. Do not generate playable cartridge records
from them until they contain a mind note or accepted generated content.

The hidden `.greenhaven-agent-manual/templates/human/` folder is for AI agents
that create starter notes. Humans do not need to edit templates to author the
world.

## Human Entity Names

Use `@Name` for entities in folder names and prose:

```text
@City of Greenhaven
@Town square
@Mikka
@Barrels in the square
@Thief's market
```

Generated names:

- visible runtime mention: `@Mikka`;
- DB `display_name`: `Mikka`;
- forge `canonical_name`: `Mikka`;
- slug: `mikka`.

`@Name` is language-invariant. If a Russian note says that moving barrels opens
a hatch to `@Thief's market`, keep that exact mention token; do not rewrite it
as `@Рынок воров`. Human prose can be in any language, but entity link tokens
are the same tokens Greenhaven's runtime parser will use.

Slug rules:

- remove the leading `@`;
- lowercase;
- remove apostrophes instead of turning them into extra words;
- replace other non-alphanumeric runs with `-`;
- collapse duplicate `-`;
- detect duplicates and write them to `import-diff.md`.

Examples:

| Human name | Preferred slug |
| --- | --- |
| `@Town square` | `town-square` |
| `@Mikka` | `mikka` |
| `@Barrels in the square` | `barrels-in-the-square` |
| `@Thief's market` | `thiefs-market` |

## Human Prose Rules

Accept normal prose such as:

- "if the player moves the barrels, a hatch opens";
- "this leads to Thief's market";
- "Mikka asks for help because she is being watched";
- "this object is scenery, not something the player can carry".

Turn these into candidate relations in the diff. If multiple targets or effects
are possible, write the ambiguity instead of guessing.

## Currency And Merchants

Currency is authored as ordinary item notes under `GreenHavenWorld/Economy/`.
The canonical starter money is:

- `@Copper coin` = 1 copper unit;
- `@Silver coin` = 10 copper units;
- `@Gold coin` = 100 copper units.

NPCs that sell goods or services may include a `Merchant` section. Compile it
into merchant offers, price rows, payment-memory rules, debt/credit notes, and
active-service state candidates. A merchant price must name the currency through
runtime mentions, not localized aliases.

Payment memory is part of gameplay state: the seller remembers who paid, what
was paid, what was bought, whether change was returned, whether a debt/advance
remains, and whether a temporary right is active or expired.

## Materializes

`Materializes` is the universal authoring block for any action, purchase, scene,
or quest that creates or opens another entity. It is not limited to rooms,
inns, shelters, or locations.

Supported target types include location, item, NPC, scene, quest, service,
access, and state. Parser-facing keys in this block are always English:
`Entity`, `Type`, `Scope`, and `Effect`. The surrounding prose may be in any
language, but these keys stay English.

```md
## Materializes

- Когда герой платит за временное укрытие:
  - Entity: @Back room under Thief's market
  - Type: location/shelter
  - Scope: @Thief's market
  - Effect: у героя есть оплаченный доступ на одну ночь.
```

If the target note exists, compile it as a link/open operation. If the target
note does not exist, compile it as an explicit materialization candidate with
source provenance and reviewable diff output. Loose prose without this section
must not silently create new entities.

## Relationship Prose

Human NPC notes may describe relationships naturally:

- "влюбилась в героя с первого взгляда";
- "trust opens after the player protects her";
- "if betrayed, she leaves the party";
- "+1 string when the player keeps her secret".

Compile these into existing Greenhaven mechanics: `strings`, memories,
quest-stage rewards, companion state, and NPC-specific offers. Do not generate a
parallel relationship table from prose.

## NPC-Owned Scenes

NPC-owned scenes describe what belongs to a character rather than to the
location: first meetings, private beats, trade beats, intimacy consent,
combat/fear behavior, betrayal, loyalty, routines, and companion actions. They
are how authoring keeps one character's scenes in one human-editable place.

Examples:

- "the first time the hero sees @Mikka, she hides a sudden attraction behind a
  business mask";
- "when violence starts, @Mikka tries to escape";
- "if cornered, @Mikka throws knives";
- "if in melee, @Mikka uses her dagger to create an opening";
- "if the player lies about payment, @Mikka refuses service and may lose
  strings";
- "if the player makes an adult offer, @Mikka checks price/consent/boundaries".

Compile these into NPC behavior data, scene records, or entity instructions with
trigger, priority, allowed actions, forbidden generic behavior, and runtime
state changes. Do not replace authored behavior with generic de-escalation.
If the scene is not conditional behavior, compile it as an NPC-owned scene with
the NPC as owner and the containing location as context.

## NPC Appearance Prose

NPC notes generate two appearance sections by default:

- `Appearance` is visible, non-explicit character appearance: face, clothes,
  height, build, proportions, posture, species traits, scars, claws, tail,
  gait, clothing silhouette, and ordinary scene description.
- `Sexual Appearance` is adult-only character appearance for sexual scenes:
  adult body canon, intimacy boundaries, consent rules, and adult-scene
  guidance.

Preserve both when authored. Suggested compile targets:

- `profile.appearance`;
- `profile.sexual_appearance`;
- `profile.intimacy_boundaries`;
- `profile.adult_scene_guidance`.

`Appearance` may feed portrait prompts and public scene briefs.
`Sexual Appearance` must not feed image generation prompts or ordinary public
scenes.
When an adult NPC note already contains concrete adult anatomical detail,
preserve the content in the adult-only compiled profile instead of summarizing
it away. Add consent and scene-surfacing rules separately; do not use them to
erase the author's canon.

Visible NPC notes must not contain mapping prose such as `profile.*`, "compiler
should", "image generator should", or "runtime should". The note is character
canon; this reference defines the machine mapping.

Legacy notes with a single `Анатомия и 21+ канон` section should be treated as
adult-only by visual tooling until a writer splits them into `Appearance` and
`Sexual Appearance`.
