# Mode-changed cue field

## Spec ID

BE-2026-05-05-mode-changed-cue-field

## Status

Implemented

## Owner

- UI side: ui-ux-agent
- Backend side: backend-agent
- Created: 2026-05-05

## Backend Resolution

Implemented on 2026-05-05.

- `mode:changed` now keeps legacy `mode`/`prev` and adds `from_mode`, `to_mode`, `cue`, `reason`, and `turnId`.
- Cue/reason classification is deterministic; first-session mode defaults to `cue: "neutral"` and `reason: "unknown"`.
- Combat exit uses text/action hints for `triumphant`, `grim`, or neutral fallback.
- Mirror frontend contract: `docs/web-ui/frontend-agent-specs/mode-as-stage.md`.

## UI Scenario

UI реализует **Mode-as-Stage** — при смене игрового режима
(`exploration / dialogue / rest / combat / intimacy / travel`) меняется не
только background hue, но и весь шелл: типографика композера, рамки,
ритм EventCard'ов, ambient bed cross-fade, и (главное) Spine2D-анимация
персонажей в кадре проигрывает соответствующий `mode_<mode>_enter`.

Чтобы режиссировать переход, UI должен знать **характер** перехода. Один и
тот же `combat → exploration` ощущается по-разному после победы (триумф) и
после бегства (тревога).

## Required Server Capability

Сервер должен расширить существующее событие `mode:changed` дополнительным
полем `cue`, описывающим эмоциональный/драматический характер перехода.

## Contract

### SSE / `gui_events`

- Event type: `mode:changed` (существующий)
- Durable `gui_events`: yes (как сейчас)
- Replay endpoint: `GET /api/session/:id/events`
- Ordering: `releaseSeq`, then `eventId` (как сейчас)
- Dedupe key: `eventId`
- Payload (расширение существующего):

  ```json
  {
    "from_mode": "combat",
    "to_mode": "exploration",
    "cue": "triumphant",
    "turnId": "...",
    "reason": "boss_defeated"
  }
  ```

- Reload/replay parity: обязателен.
- Legacy: поле `cue` опционально на стороне клиента; UI fallback'ит на
  `"neutral"` если поле отсутствует. Старые события без `cue` не ломаются.

### Cue enum

Допустимые значения `cue`:

- `"neutral"` — рутинный переход без эмоциональной окраски (default).
- `"triumphant"` — победа, успех, разрешение конфликта в пользу игрока.
- `"grim"` — поражение, потеря, провал броска с последствиями.
- `"tender"` — интимный, доверительный, мягкий переход (часто перед
  intimacy / rest).
- `"abrupt"` — резкая смена обстоятельств (нападение, тревога, раскрытие).
- `"contemplative"` — переход в размышление, замедление, observe.

UI маппит cue → анимационный preset (продолжительность fade, sound sting
из ambient pool, easing, Pixi filter intensity).

### Reason field

`reason` — машинный enum (свободная строка не нужна), используется для
логики UI:

- `"boss_defeated"`, `"enemy_routed"`, `"escaped"`,
- `"invitation_accepted"`, `"intimate_initiated"`,
- `"rest_started"`, `"rest_ended"`,
- `"travel_started"`, `"travel_arrived"`,
- `"dialogue_engaged"`, `"dialogue_concluded"`,
- `"scene_resolved"`, `"scene_cut"`,
- `"unknown"` (fallback).

Не финальный список — backend-агент может расширять, UI читает как opaque
строку и подставляет локализованный label.

## Localization

- `cue` и `reason` — машинные enum'ы, UI локализует через i18n keys
  (`mode.cue.triumphant`, `mode.reason.boss_defeated` и т.д.).
- Никакой player-facing prose в payload не нужен.

## Ordering & Persistence Guarantees

- Эмитится в момент фактической смены режима (как сейчас).
- Сохраняется при reload (durable).
- Если переход случился во время cancelled turn'а — событие НЕ
  эмитится (как сейчас).

## Error & Edge Cases

- Если backend не может определить `cue` уверенно — отдаёт `"neutral"`.
- При reconnect посреди стрима replay добивает событие из durable стора.
- Несколько `mode:changed` в одном turn'е разрешены (например
  `exploration → combat → exploration`); каждое со своим `cue`.

## Non-Goals

- UI-агент не диктует визуальную/звуковую реализацию каждого cue —
  это UI domain.
- Не нужно эмитить отдельные `cue:*` события — расширяем существующее.
- Не добавлять `intensity: 0..1` поле; cue — категориальный enum, не
  скалярный.

## Acceptance

- [ ] поле `cue` присутствует в payload `mode:changed` events для всех
      новых turn'ов;
- [ ] поле `reason` присутствует и принимает значения из enum выше;
- [ ] существующие SSE-подписчики не падают (обратная совместимость);
- [ ] replay parity: live SSE и `/api/session/:id/events` дают то же
      payload;
- [ ] regression-тесты mode-transitions (если есть в `packages/web-server`)
      проходят.

## Suggested Server Touchpoints

(Подсказка, не предписание.)

- `packages/web-server/src/postTurnPipeline.ts` — место эмиссии mode events.
- `packages/web-server/src/sse/*` — type definitions.
- Возможно отдельный модуль для классификации `cue` (анализ результата
  turn'а: победа/поражение/нейтральный).

## Verification (frontend side)

- Ручной сценарий: спровоцировать combat → exploration после победы и
  после поражения, убедиться что `cue: "triumphant"` vs `"grim"` приходит.
- Reload: после exit dialogue в середине turn'а, после reload
  `mode:changed` событие приходит из replay с тем же `cue`.
- Frontend-проверки после реализации:
  - `npm --prefix packages/web-ui run build`
  - `npm --prefix packages/web-ui run i18n:check`
  - mode-transition smoke на dev-сервере.

## Open Questions

- Является ли `cue` строго детерминированным от `reason`, или они
  независимы? UI предполагает независимость (cue = эмоциональная окраска,
  reason = механическая причина).
- Нужна ли `cue` для самого первого `mode:changed` при загрузке сессии,
  или только для transitions внутри сессии?

## Links

- `docs/web-ui/spine-stage-architecture.md` (как UI использует cue)
- `docs/web-ui/ui-ux-agent-guide.md` §Screen Anatomy
- зеркальная FE-спека после реализации:
  `docs/web-ui/frontend-agent-specs/mode-as-stage.md` (TBD)
