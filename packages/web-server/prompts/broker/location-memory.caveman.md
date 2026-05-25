# Location Memory

## record_location_memory

`record_location_memory(location=<id>, text="<memory>", tags=[...])`. Writes memory tied to location, not NPC.

Use for:
- Room rented, item left, deal made at this location
- Environmental change (fire damage, blood stain, broken door)
- Witnessed event at this location

Location memory visible to ALL NPCs at this location in future preambles.

## set_actor_status

`set_actor_status(actor=<NPC id>, kind="<status>", at=<location id>?, busy_until=<turn>?)`. Statuses: present, absent, busy, temporary_room, departed, incapacitated.

NPC moved → set_actor_status so preamble reflects correct presence.
