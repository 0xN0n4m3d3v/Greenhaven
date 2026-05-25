# Inventory model

Greenhaven has two inventory systems that coexist after migration `0046`.
Player-facing inventory uses the new `items` + `player_inventory` pair (spec
35); legacy `inventory_entries` stays for entity-to-entity transfers (NPC
inventories, container inventories).

## Schema

**Legacy generic inventory** —
[packages/web-server/migrations/0001_cartridge.sql:81-87](../../packages/web-server/migrations/0001_cartridge.sql#L81-L87):

```sql
CREATE TABLE inventory_entries (
  holder_entity_id BIGINT,
  item_entity_id   BIGINT,
  count            INT CHECK (count >= 0),
  metadata         JSONB,
  PRIMARY KEY (holder_entity_id, item_entity_id)
);
```

`holder_entity_id` and `item_entity_id` both FK → `entities`. Used for
non-player holders: NPC inventories, container inventories, scene fixtures
(Heavy Crate, Vendor's Cart).

**New player inventory** — spec 35, consolidated by
[packages/web-server/migrations/0046_inventory_consolidation.sql](../../packages/web-server/migrations/0046_inventory_consolidation.sql):

```sql
CREATE TABLE items (
  id              SERIAL PRIMARY KEY,
  slug            TEXT UNIQUE,
  category        TEXT,        -- 'currency'|'consumable'|'weapon'|'armor'|'quest'|'material'|'tool'
  weight_kg       NUMERIC(5,2),
  stackable       BOOL,
  max_stack       INT,
  behaviour       JSONB,        -- applies_surface, effect='heal', modifiers
  legacy_entity_id BIGINT       -- back-link to entities[kind='item']
);

CREATE TABLE player_inventory (
  id        SERIAL PRIMARY KEY,
  player_id BIGINT,
  item_id   INT REFERENCES items(id),
  quantity  INT,
  equipped  BOOL,
  meta      JSONB
);
```

Idempotency rule: `UNIQUE (player_id, item_id) WHERE equipped=false` (one stack
of unequipped) + `UNIQUE (player_id, item_id) WHERE equipped=true` (single
equipped instance). See
[packages/web-server/migrations/0046_inventory_consolidation.sql:36-39](../../packages/web-server/migrations/0046_inventory_consolidation.sql#L36-L39).

`items.legacy_entity_id` is the bridge: the same Healing Potion exists as
`entities[id=303, kind='item']` AND as
`items[slug='healing_potion', legacy_entity_id=303]`. Tools accept either id and
resolve.

Runtime item spawns follow the same bridge. `create_entity(kind='item')` and
`create_quest.spawn_entities[].kind='item'` automatically create an `items` row
unless the entity is tagged/profiled as a fixture, obstacle, container, scenery,
or `inventory_item=false`. If the profile has `holder_entity_id` or `home_id`
and that holder is not the active player, the entity is also placed in
`inventory_entries`. Direct player grants must use `inventory_transfer`, not
item spawn.

## Holders

Three holder types:

1. **Players.** Use the `player_inventory` table (NEW system). `give_to_npc`,
   `use_item`, `equip_item` target this. Inventory readers (`query_inventory`)
   read from here when `holder` resolves to a `players` row.
2. **NPCs.** Use `inventory_entries` (LEGACY). NPCs trading items, dropping
   loot, etc. transfer through `inventory_entries`.
3. **Containers / scene fixtures.** Use `inventory_entries`. The Heavy Crate,
   the Vendor's Cart — these are entities `kind='item'` but they ARE holders (an
   item that contains items). Migration 0046 explicitly skips these from the
   items backfill.

`inventory_transfer`
([packages/web-server/src/tools/inventory.ts](../../packages/web-server/src/tools/inventory.ts))
is the bridge: it inspects both sides and routes to the right tables.

Inventory SSE is shared through `emitPlayerInventoryEvents` in
[packages/web-server/src/tools/inventoryCommon.ts](../../packages/web-server/src/tools/inventoryCommon.ts).
`inventory.ts` and `inventoryExt.ts` both use that helper for
`inventory:changed` and `currency:changed`, so the payload shape has one owner.

## Mutations

The tools that mutate inventory:

- **`inventory_transfer`** —
  [packages/web-server/src/tools/inventory.ts](../../packages/web-server/src/tools/inventory.ts).
  Atomic transfer. Handles player->player, player->NPC/container,
  NPC/container->player, and NPC/container->NPC/container. Uses the strict
  canonical shape `{from|from_player_id, to|to_player_id, item, count}`;
  `from`/`to` may be holder names or numeric entity ids, and `item` may be
  slug/display name/numeric item id/numeric item entity id. Emits
  `inventory:changed`, and `currency:changed` when the moved item is currency.
- **`use_item`** —
  [packages/web-server/src/tools/inventoryExt.ts](../../packages/web-server/src/tools/inventoryExt.ts).
  Player uses an item. Validates target/effect first, then consumes atomically.
  Supports `behaviour.applies_surface` and `behaviour.effect='heal'`.
- **`equip_item`** —
  [packages/web-server/src/tools/inventoryExt.ts](../../packages/web-server/src/tools/inventoryExt.ts).
  Sets `player_inventory.equipped=true` idempotently, and unequips by merging
  back into the unequipped stack when needed. This avoids partial-unique-index
  conflicts.
- **`give_to_npc`** —
  [packages/web-server/src/tools/inventoryExt.ts](../../packages/web-server/src/tools/inventoryExt.ts).
  Sugar: player -> NPC/container transfer recorded in `inventory_entries`.
- **`query_inventory`** —
  [packages/web-server/src/tools/inventory.ts](../../packages/web-server/src/tools/inventory.ts).
  Read. Resolves holder, returns either `player_inventory` rows (with `items`
  join) or `inventory_entries` rows (with `entities` join).

Combat tools also touch inventory: `damage` can trigger durability decrements
via `behaviour.degrades_on_use`; `apply_surface(kind='fire')` on a location with
flammable items can degrade them.

The cartridge author's mental model: ship items as `items` rows for
player-facing things (potions, weapons, armor); ship as `entities[kind='item']`
for scene fixtures and NPC-only props.

The broker's mental model is stricter: visible take/give/use objects must be
materialized before narration treats them as interactable. Prose alone is not
inventory state.

## Sources

- [packages/web-server/migrations/0001_cartridge.sql](../../packages/web-server/migrations/0001_cartridge.sql)
  — legacy `inventory_entries`
- [packages/web-server/migrations/0046_inventory_consolidation.sql](../../packages/web-server/migrations/0046_inventory_consolidation.sql)
  — new `items` + `player_inventory` consolidation
- [packages/web-server/migrations/0073_dynamic_item_materialization.sql](../../packages/web-server/migrations/0073_dynamic_item_materialization.sql)
  — runtime item backfill into the inventory bridge
- [packages/web-server/src/tools/inventory.ts](../../packages/web-server/src/tools/inventory.ts)
  — `inventory_transfer`, `query_inventory`
- [packages/web-server/src/tools/inventoryExt.ts](../../packages/web-server/src/tools/inventoryExt.ts)
  — `use_item`, `equip_item`, `give_to_npc`
