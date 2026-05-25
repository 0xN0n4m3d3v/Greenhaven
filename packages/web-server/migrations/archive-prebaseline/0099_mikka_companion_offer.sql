-- Mikka Quickgrin (230501) — companion + lover recruitment.
--
-- Story design. Mikka has a hidden_crush on the active protagonist
-- (authored on her profile). She will never confess it in words, but
-- she has a price: if the player pays her market rate up front, she
-- closes her stall, leaves the corner she has worked for eleven years,
-- and travels with the player as both adventure partner and lover.
-- This is the closest thing to a confession her own rules allow —
-- "I'm worth this much, you paid it, I'm with you now."
--
-- Mechanics:
--   1. `profile.companion_offer` describes the hireable terms in a
--      machine-readable block. Broker prompts will see it in the
--      DIALOGUE PARTNER preamble and offer the deal when the player
--      asks for company / travel / partner.
--   2. `profile.combat_kit` + `profile.social_kit` give the broker a
--      compact menu of what Mikka actually contributes during play.
--   3. A new quest entity (291100) anchors the recruitment arc with
--      explicit stages: offered → paid → travelling → first_lover_beat
--      → trust_test. Until paid, the quest sits at `offered`. The
--      broker advances it through the existing `advance_quest` tool
--      after `inventory_transfer` confirms the payment.
--   4. Mikka's hidden_crush trait is preserved verbatim, with one
--      runtime modulation: once `companion_offer.accepted_at_turn`
--      is set, she stops `do_not: contracts longer than a single
--      night` and replaces it with `binds_to_protagonist=true`. She
--      still refuses to say "I love you" aloud — paying for her IS
--      her confession.

UPDATE entities
   SET profile = profile
              || jsonb_build_object(
        'companion_offer', jsonb_build_object(
          'kind', 'paid_companion_and_lover',
          'price', jsonb_build_object('currency', 'silver', 'amount', 500),
          'price_label', '500 серебра вперёд за весь срок до отказа одной из сторон',
          'unlocks', jsonb_build_array(
            'closes_market_stall',
            'set_companion_follow',
            'travel_with_player',
            'intimacy_partner',
            'shares_room_when_resting',
            'speaks_first_with_locals_she_knows'
          ),
          'terms', jsonb_build_array(
            'плата вперёд, без рассрочки и торга вниз',
            'разрыв в любой момент без штрафа — но плата не возвращается',
            'правила её работы остаются её правилами: ни крови, ни видимых меток, ни обещаний третьим лицам',
            'её приватные правила про чувства не часть контракта — она их не озвучивает'
          ),
          'broker_hint', jsonb_build_object(
            'offer_phrasing', 'Если протагонист просит её пойти вместе/нанимает в спутники/предлагает дорогу, она называет цену вслух — пятьсот серебра одним кошельком — и ждёт ответа без давления. Если игрок передаёт сумму через inventory_transfer, она закрывает лоток, складывает счёты в холщовую сумку, бросает ключ от ящика с письмами Тилли Хопджой через площадь и уходит с протагонистом.',
            'on_payment',
              'call inventory_transfer first (player → Mikka, 500 silver); then advance_quest(quest_entity_id=291100, to=accepted); then set_companion(npc=230501, action=follow); then add_memory(owner=230501, about=<player_id>, importance=0.85, visibility=private, tags=["hidden_crush","accepted","bound_for_road"], text="он/она заплатил(а) полную цену. лоток закрыт. это не любовь вслух — это любовь делом. вслух — никогда."); then narrate the leaving from Mikka POV.',
            'refuse_below_price',
              'Если игрок предлагает меньше — Микка не торгуется вниз. Спокойно говорит: «дешевле я с тобой не пойду — это не про деньги, это про правило». Не оскорбляется, остаётся доступной как обычный платный партнёр на разовую сцену.'
          ),
          'accepted_at_turn', null,
          'broken_at_turn', null
        ),
        'combat_kit', jsonb_build_object(
          'role', 'fast_skirmisher_and_finisher',
          'preferred_weapon', 'short blade (нож-«писарь» из-под стойки)',
          'strengths', jsonb_build_array(
            'быстрая, бьёт в стыки доспеха',
            'видит замки и засовы как читает шрифт',
            'считает шансы вслух перед боем — экономит игроку проверку'
          ),
          'weaknesses', jsonb_build_array(
            'без брони, ломается в долгом бою',
            'не маг и не лекарь, ничего волшебного не носит'
          ),
          'opening_lines', jsonb_build_array(
            '«ты по горлу, я по сухожилию — и не дёргаемся»',
            '«не геройствуй, давай сначала посмотрим»'
          )
        ),
        'social_kit', jsonb_build_object(
          'role', 'street_broker_and_lockpick',
          'strengths', jsonb_build_array(
            'знает половину Стилгейта по именам и долгам',
            'читает любые письма / счета / квитанции',
            'умеет торговаться за двоих, если речь не про неё самой',
            'находит ночлег и подкуп в чужом городе быстрее любого квартирьера'
          ),
          'cannot', jsonb_build_array(
            'выступать перед двором или гильдией от чужого имени',
            'давать клятвы кровью / магией',
            'выдавать чужие письма, прочитанные на её столе'
          )
        )
      )
 WHERE id = 230501
   AND kind = 'person';

-- The recruitment quest entity. Stage IDs are referenced by the
-- companion_offer.broker_hint above.
INSERT INTO entities (id, kind, display_name, summary, profile, tags)
VALUES (
  291100,
  'quest',
  'Нанять Микку как спутницу и любовницу',
  'Микка Хитрогрин с Главной Рыночной Площади Гринхейвена согласна закрыть свой стол и уйти с протагонистом как спутница и любовница за 500 серебра одним платежом. Цена — её способ обойти собственное правило «не путать работу с собой».',
  jsonb_build_object(
    'cartridge_id', 'grinhaven-full',
    'source_category', 'authored.companion_recruitment',
    'giver_entity_id', 230501,
    'source_entity_id', 230501,
    'location_id', 201236,
    'narrator_brief',
      'Этот квест становится видимым, как только протагонист и Микка оказываются за её столом и игрок начинает разговор про путешествие/спутницу/найм. Микка называет цену один раз и ждёт. Если игрок платит — стадия offered → accepted, set_companion(follow), память (private) о решении. Если игрок не платит — квест остаётся в offered и доступен любым следующим визитом.',
    'goal_text',
      'Нанять Микку как спутницу и любовницу за 500 серебра одним платежом, либо отказаться и оставить дверь открытой.',
    'accept_condition',
      'Передать 500 серебра Микке через inventory_transfer на одном из ходов в Уголке Микки.',
    'tags', jsonb_build_array('recruitment','companion','intimacy','goblin','market'),
    'stages', jsonb_build_array(
      jsonb_build_object(
        'id', 'offered',
        'title', 'Микка назвала цену',
        'next_stage', 'accepted',
        'description', 'Микка вслух называет цену пятьсот серебра и ждёт ответа. Без давления.'
      ),
      jsonb_build_object(
        'id', 'accepted',
        'title', 'Сделка закрыта',
        'next_stage', 'on_the_road',
        'description', 'Платёж получен. Микка собирает счёты в сумку, отдаёт ключ от ящика писем Тилли, выходит из-под арки лотка к протагонисту. Брокер вызывает set_companion(follow).'
      ),
      jsonb_build_object(
        'id', 'on_the_road',
        'title', 'Первая ночь дороги',
        'next_stage', 'first_lover_beat',
        'description', 'Первая локация после рынка. Микка ведёт себя как спутница: торгуется за двоих, читает любые бумаги, делит ночлег. До первой интимной сцены не настаивает.'
      ),
      jsonb_build_object(
        'id', 'first_lover_beat',
        'title', 'Первая ночь как любовницы',
        'next_stage', 'trust_test',
        'description', 'Первая интимная сцена после найма. По правилам её consent_register — взаимно и не травмирующе. Микка по-прежнему не произносит «люблю».'
      ),
      jsonb_build_object(
        'id', 'trust_test',
        'title', 'Проверка верности контракту',
        'description', 'Сцена, где протагонист может предать её — либо проверить и удержать. Через этот стейдж проходит decay её правил: либо она впервые осторожно даёт намёк на чувства поступком (не словами), либо разрывает контракт и возвращается на угол.'
      )
    )
  ),
  ARRAY['quest','recruitment','companion','intimacy','authored']
)
ON CONFLICT (id) DO UPDATE
  SET kind = EXCLUDED.kind,
      display_name = EXCLUDED.display_name,
      summary = EXCLUDED.summary,
      profile = EXCLUDED.profile,
      tags = EXCLUDED.tags;

-- Refresh Mikka's local_density.npc_ids untouched (still herself), but
-- ensure 291100 ends up in 201236.local_density.quest_ids so the market
-- preamble surfaces it to the broker on entry.
UPDATE entities loc
   SET profile = jsonb_set(
       COALESCE(loc.profile, '{}'::jsonb),
       '{local_density,quest_ids}',
       (
         SELECT COALESCE(jsonb_agg(q.id ORDER BY q.id), '[]'::jsonb)
           FROM entities q
          WHERE q.kind = 'quest'
            AND q.profile->>'location_id' = loc.id::text
       ),
       true
     )
 WHERE loc.id = 201236
   AND loc.kind = 'location';
