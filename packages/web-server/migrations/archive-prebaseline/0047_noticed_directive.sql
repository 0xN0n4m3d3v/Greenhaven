-- Spec 32 §11 — diegetic "the NPC noticed" event. Adds a `noticed`
-- directive tag the narrator can emit to surface a brief read-receipt
-- ("Mikka heard that") near the NPCCard avatar.
--
-- Payload: {"npc_name": "Mikka Quickgrin", "reason": "string?"}.
-- Server emits dialogue:noticed; bridge relays to runtime bus;
-- ModeBanner surfaces in stack.

INSERT INTO directive_tag_types (tag, sse_event, payload_schema) VALUES
  ('noticed', 'dialogue:noticed', '{"npc_name":"string","reason":"string?"}'::jsonb)
ON CONFLICT (tag) DO NOTHING;
