# Greenhaven Note Placement

Use these conventions unless the existing local folder already proves another
human-friendly convention.

## Locations

`Locations/@City of Greenhaven/@Town square/TownSquareMind.md`

Locations can contain:

- `npc/`
- `items/`
- `scenes/`
- `images/`
- direct `quests/` only for place-authored quests.

## Scenes

`@Location/scenes/@Scene Name.md`

Location scenes are beats owned by the place: crowd events, patrols, public
rituals, weather, disasters, ambience, or multi-entity pressure that is not
primarily one NPC's scene. They can mention participants, visible props, state
changes, and conditions for appearing. They are not standalone places unless
the writer says the player can travel there.

Do not put a single NPC's first meeting, romance beat, trade beat, combat
reaction, fear response, betrayal beat, or personal routine under
`@Location/scenes/`. Put those under the NPC.

## NPCs

`@Location/npc/@Mikka/MikkaMind.md`

NPC notes own persona, voice, relationship rules, inventory carried by the NPC,
and quests the NPC gives.

Every NPC should include these two English headings by default:

- `Appearance` - visible, non-explicit face, clothing, body type, species
  traits, posture, movement, scars, claws, and portrait-safe silhouette.
- `Sexual Appearance` - adult-only appearance for sexual scenes, boundaries,
  consent rules, and adult-scene guidance.

Portrait/image generation may use `Appearance` and must ignore
`Sexual Appearance`.

Keep this as character canon, preferably first-person prose. Do not write
compiler/importer rules, `profile.*` field names, image-generation rules, or
"do not translate" reminders into the visible NPC note.

Do not add a manual "quests and scenes" index inside the NPC note. If a quest
or NPC scene sits under this NPC's `quests/` or `scenes/` folder, the
compiler and any rendered world view must show it automatically from structure.

NPC-owned scenes live under the NPC:

`@Location/npc/@Mikka/scenes/@Mikka violence starts.md`

Use these for first encounters, relationship beats, conditional behavior,
combat reactions, escape, trade responses, intimacy consent beats, betrayal,
fear, loyalty, routines, or companion actions. They are not quests unless the
player receives an explicit objective.

## Items

`@Location/items/@Barrels in the square/BarrelsMind.md`

Items include carryable items, fixtures, containers, doors, clues, letters,
hatches, stalls, and scenery with gameplay affordances.

Global economy items can live under:

`GreenHavenWorld/Economy/items/@Gold coin/GoldCoinMind.md`

Currency is still authored as items. Use the canonical coin mentions:
`@Gold coin`, `@Silver coin`, and `@Copper coin`.

## Merchants

NPCs that sell goods, information, rooms, storage, passage, protection, or any
other service should include a `Merchant` section. Keep it readable as character
canon, not compiler instructions.

Write direct prices in coin mentions:

- `прочитать письмо - 2 @Copper coin`;
- `безопасное хранение на ночь - 3 @Silver coin`;
- `тихий торговый жетон на день - 1 @Gold coin`.

The merchant should also say what they remember about payment: who paid, how
much, for what, whether change was returned, whether the service is active,
whether there is debt or credit, and when temporary access expires.

## Materializes

Use `Materializes` when a note says that an action, purchase, scene, or quest
creates or opens another game entity. This is universal: it is not only for
rooms or shelters.

Supported target types include:

- location;
- item;
- NPC;
- scene;
- quest;
- service;
- access;
- state.

Use a small human-readable block:

```md
## Materializes

- Когда герой платит за временное укрытие:
  - Entity: @Back room under Thief's market
  - Type: location/shelter
  - Scope: @Thief's market
  - Effect: у героя есть оплаченный доступ на одну ночь.
```

If the target note already exists, the compiler links to it. If the target note
does not exist, the compiler treats it as an explicit materialization candidate
instead of a broken ordinary `@` mention.

## Visual Assets

Keep images beside the entity they depict:

- NPC portrait: `npc/@NPC/portraits/default.png`
- NPC scene plate: `npc/@NPC/images/<scene-slug>.png`
- item icon: `items/@Item/images/icon.png`
- location establishing image: `@Location/images/establishing.png`
- location scene plate: `@Location/images/<scene-slug>.png`

Do not write API keys, provider tokens, or model settings into notes. The
transformer skill plans and generates images from hidden local config.

## Quests And Action Unlocks

Put a quest under the thing that starts it:

- NPC giver -> `npc/@NPC/quests/Quest Name.md`
- object interaction -> `items/@Item/quests/Quest Name.md`
- place-authored event -> `@Location/quests/Quest Name.md`

If a quest is mostly "do X to reveal Y", write it as an action unlock note.

The source is the folder that contains `quests/`. Do not duplicate that source
with a hand-maintained list in the parent note.
