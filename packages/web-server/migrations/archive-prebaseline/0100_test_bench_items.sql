-- Test-bench items: enchanted blades + Eris currency.
--
-- Creates three entities for development testing:
--   295001 — Eris Coin (mid-tier currency, see Nectar's membership fee)
--   295010 — Бритвоязычный клинок (enchanted blade)
--   295011 — Лунный шёлк (enchanted blade)
--
-- The grants themselves are done by `scripts/test-grant.ts` when the
-- operator runs it offline. This migration only ensures the entity
-- rows exist so inventory_entries.item_entity_id FK is satisfied.

INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES (
  295001,
  'item',
  'Eris Coin',
  'Лёгкая медная монета в полпальца ширины с выбитой пчелой на аверсе. Базовая ходовая монета Гринхейвена; 100 эрис ≈ 1 серебру.',
  jsonb_build_object(
    'cartridge_id', 'grinhaven-full',
    'source_category', 'test_bench.currency',
    'category', 'currency',
    'stackable', true,
    'max_stack', 99999
  ),
  ARRAY['item','currency','test_bench']
),
(
  295010,
  'item',
  'Бритвоязычный клинок',
  'Парный кинжал длиной с локоть, выкованный в Серебряных Подвалах. Лезвие воронёное, рукоять обмотана чёрной кожей; вдоль фуллера тянется руническая нитка, которая теплеет в ладони владельца и потухает, когда клинок покидает её хват. Зачарование: первый удар за ход бьёт через любую броню кроме магической.',
  jsonb_build_object(
    'cartridge_id', 'grinhaven-full',
    'source_category', 'test_bench.weapon',
    'category', 'weapon',
    'subtype', 'dagger',
    'stackable', false,
    'enchanted', true,
    'enchantment', jsonb_build_object(
      'name', 'razor_tongue',
      'effect', 'first strike per turn ignores non-magical armor',
      'attunement_required', false,
      'tier', 'rare'
    ),
    'damage', jsonb_build_object('die', 'd6', 'count', 1, 'type', 'piercing'),
    'weight_kg', 0.4
  ),
  ARRAY['item','weapon','dagger','enchanted','test_bench']
),
(
  295011,
  'item',
  'Лунный шёлк',
  'Прямой длинный нож с лезвием цвета лунного света; рукоять — белая кость, оплетённая серебряной проволокой. Когда лезвие покидает ножны в темноте, оно мягко светится холодным светом — ровно настолько, чтобы видеть свою цель, но не настолько, чтобы быть замеченным дальше десяти шагов. Зачарование: бесшумный удар; цель не слышит замаха.',
  jsonb_build_object(
    'cartridge_id', 'grinhaven-full',
    'source_category', 'test_bench.weapon',
    'category', 'weapon',
    'subtype', 'long_dagger',
    'stackable', false,
    'enchanted', true,
    'enchantment', jsonb_build_object(
      'name', 'moon_silk',
      'effect', 'silent strike; no sound until impact; faint cold light when drawn in darkness',
      'attunement_required', false,
      'tier', 'rare'
    ),
    'damage', jsonb_build_object('die', 'd8', 'count', 1, 'type', 'piercing'),
    'weight_kg', 0.6
  ),
  ARRAY['item','weapon','dagger','enchanted','test_bench']
)
ON CONFLICT (id) DO UPDATE
  SET kind = EXCLUDED.kind,
      display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags;

-- Register Eris and the enchanted blades in the items table so
-- inventory_transfer / equip_item / use_item find them by slug too.
INSERT INTO items (id, slug, category, weight_kg, stackable, max_stack, legacy_entity_id)
VALUES
  (295001, 'eris_coin', 'currency', 0, true, 99999, 295001),
  (295010, 'razortongue_blade', 'weapon', 0.4, false, 1, 295010),
  (295011, 'moon_silk_blade', 'weapon', 0.6, false, 1, 295011)
ON CONFLICT (id) DO UPDATE
  SET slug = EXCLUDED.slug,
      category = EXCLUDED.category,
      weight_kg = EXCLUDED.weight_kg,
      stackable = EXCLUDED.stackable,
      max_stack = EXCLUDED.max_stack,
      legacy_entity_id = EXCLUDED.legacy_entity_id;
