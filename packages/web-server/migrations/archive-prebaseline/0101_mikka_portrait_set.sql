-- Spec 139 v2 — bind Mikka Quickgrin's portrait_set so the chat / NPC
-- card / first-encounter reveal can render her real face.
--
-- Asset files copied to packages/web-ui/public/assets/portraits/mikka/
-- and served as /assets/portraits/mikka/{1,2}.png by Vite + the
-- embedded Electron server.
--
-- Idempotent: jsonb_set with create_missing=true.

UPDATE entities
SET profile = jsonb_set(
    COALESCE(profile, '{}'::jsonb),
    '{portrait_set}',
    '{
      "default":  "/assets/portraits/mikka/2.png",
      "neutral":  "/assets/portraits/mikka/2.png",
      "amused":   "/assets/portraits/mikka/2.png",
      "open":     "/assets/portraits/mikka/2.png",
      "wanting":  "/assets/portraits/mikka/2.png",
      "guarded":  "/assets/portraits/mikka/1.png",
      "wounded":  "/assets/portraits/mikka/1.png"
    }'::jsonb,
    true
  ),
  updated_at = now()
WHERE kind = 'person'
  AND display_name ILIKE 'Mikka%';
