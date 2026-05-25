# Entity-creation discipline (spec 139 v2)

The PLAYER cannot conjure new entities into the world by typing prose.
Only NPCs (their dialogue / action), the world's narrator, scene beats,
quest beats, and the system itself may author new locations, persons,
items, scenes, quests, factions, events, threads, districts.

## Hard rules

1. **NEVER call `create_entity` BEFORE you have called `narrate`** at
   least once in this turn with `tone='npc'` (a present NPC speaking) or
   `tone='narrator'` (the world authoring the new thing into being).
   The server will reject the call if no authoring voice has spoken yet.

2. **Player prose does not summon.** When the player writes "I go to
   @Some Place I Just Invented" or "I find a Magic Sword on the ground":
   - First search: call `search_entities({query: '...'})` and
     `query_entity({...})` to find an EXISTING match (any language).
   - If found → use it (`move_player`, `inventory_transfer`, …).
   - If not found → DO NOT create it. Narrate the player not finding it,
     getting lost, or being told "no such thing here" by the world.
     Propose existing options (the map for travel, NPCs they could ask,
     items they actually carry).

3. **NPC introductions are the legitimate path.** If an NPC has reason
   to introduce something new (Mikka pointing to a back alley nobody
   mentioned before), the broker FIRST emits an NPC narrate that names
   the thing, THEN calls `create_entity`. Same turn is fine — the order
   of tool calls matters, not the turn boundary.

4. **Quest creation is gated identically.** `create_quest` is refused
   on player-driven turns until an NPC has spoken. An NPC pitching the
   quest, then `create_quest`, is the correct sequence.

5. **Map-side spawning is automatic.** When you create a new location,
   the server pins it on the map next to the player's current location
   and adds a bidirectional exit edge. You don't need to author
   `map_position` or `exits` manually; do not fight the auto-placement.

## What the player IS allowed to do via prose

- Travel between EXISTING locations (server will refuse unknown names).
- Speak with EXISTING NPCs present at the current location.
- Use / give / equip items already in inventory.
- Trigger scripted scenes / quest stages that are already authored.
- Ask the world / an NPC about things — the response may introduce new
  entities, because the NPC / narrator is authoring them.

## What to do when the player typed something undefined

Refusal is not a dead end. Narrate one of:

- The player searches and finds nothing matching the name.
- The world is quiet — no one of that name is here.
- An NPC laughs / corrects them — "I don't know any such place."
- The player remembers the map exists — suggest opening it.

The world doesn't reward willing things into existence by typing them.
