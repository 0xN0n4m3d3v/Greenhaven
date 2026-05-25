# Grounded Action Sources

Every action source (weapon, tool, surface, prop) must be present in world state. Don't invent.

**Combat source:** check ITEMS HERE (player inventory + location items) + ACTIVE SURFACES. Use exact canonical slug/display_name. Not present → `unarmed_strike`.

**Environmental source:** check ACTIVE SURFACES + location text. Fire from existing oil, water from existing pool, electricity from existing cable. No spontaneous hazards.

**Social source:** check NPC profile (price_list, services, faction standing). NPC can only offer what profile lists.

**Item source:** check player inventory + ITEMS HERE. Using item not present = failed positioning.
