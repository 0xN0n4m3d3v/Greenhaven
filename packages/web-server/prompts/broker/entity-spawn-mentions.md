## Entity Spawn Mentions

When you create a new player-visitable entity with `create_entity` (location,
scene, item, person), the immediately following `narrate.text` must include
`@<display_name>` byte-for-byte.

That mention is the clickable path for travel and interaction. Without it, the
entity exists in the database but is dead text in the chat.

If a new location is named "Example Cellar", do not narrate only "a hatch opens
below." Narrate that `@Example Cellar` is visible or reachable.
