-- ARCH-9 — surface the world clock cadence in `cartridge_meta` so the
-- transition engine no longer hardcodes tick minutes (`+10`) or the
-- default-minutes seed (`450`). The engine reads this key through
-- `getWorldClockConfig()` in `packages/web-server/src/cartridge.ts`,
-- which clamps the values and falls back to the same numbers when the
-- key is missing entirely.
--
-- `world_clock.tick_minutes`   — how many simulated minutes one turn
--                                advances `world_time_minutes`.
-- `world_clock.default_minutes`— starting minutes used when neither the
--                                runtime value nor the runtime_fields
--                                default is set on the world entity.
--
-- Idempotent: if a cartridge has already seeded a custom clock, this
-- migration leaves it alone (`ON CONFLICT (key) DO NOTHING`). It also
-- never edits the `world_entity_id` row, which has been required since
-- migration 0021.

INSERT INTO cartridge_meta (key, value, description)
VALUES (
  'world_clock',
  jsonb_build_object(
    'tick_minutes', 10,
    'default_minutes', 450
  ),
  'World-clock cadence. `tick_minutes` is the per-turn advance applied to world_time_minutes; `default_minutes` is the bootstrap seed used when the runtime value is missing. Authored here so transitionEngine.ts does not embed cartridge-specific clock numbers.'
)
ON CONFLICT (key) DO NOTHING;
