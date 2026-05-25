# Entity Creation Discipline

## When to use create_entity

ONLY when Director or quest system requires it. Don't spawn NPCs, items, or locations just for atmospheric detail.

create_entity writes permanent DB row. Bad create = broken world. Good: quest system spawn_entities. Bad: random passerby, atmospheric prop, one-line joke NPC.

## create_entity signature

```
create_entity(
  kind="person"|"item"|"location"|"quest"|"scene",
  display_name="<name>",
  summary="<one sentence>",
  profile={...},
  tags=[...]
)
```

## Validation (Cartridge Steward)

create_entity may be rejected by Cartridge Steward pre-tool validator if:
- Duplicate within same scene
- Missing required profile fields
- Invalid tags for kind

Respect rejection. Don't retry with different name.
