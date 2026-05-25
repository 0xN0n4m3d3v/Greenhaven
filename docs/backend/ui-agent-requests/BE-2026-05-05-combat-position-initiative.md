# Combat position + initiative payload

## Spec ID

BE-2026-05-05-combat-position-initiative

## Status

Implemented

## Owner

- UI side: ui-ux-agent
- Backend side: backend-agent
- Created: 2026-05-05

## Backend Resolution

Implemented on 2026-05-05.

- Added durable `combat:initiative_set` on entry into combat mode.
- Added optional tactical fields to combat `dice:rolled` and `damage:dealt`.
- Added durable `combat:position_changed` when damage tooling receives `target_position_after`.
- Position enum is `front | mid | back`; backend does not emit `down`, so UI should use `damage:dealt.defeated` for downed presentation.
- No explicit `combat:ended`; mode transition away from combat remains the end signal.
- Mirror frontend contract: `docs/web-ui/frontend-agent-specs/combat-theatre.md`.

## UI Scenario

UI реализует **Combat Theatre** — не тактический грид (это территория
RoleForge / Friends & Fables), а театральную сцену:

- В combat mode появляется `InitiativeBar` поверх chat-stage с очерёдностью
  ходов и узкими HP-полосами.
- Сцена делится на три горизонтальные полосы — `front / mid / back` — и
  Spine-портреты персонажей физически перемещаются между ними от раунда
  к раунду (через анимации move).
- Risk meter рядом с dice до броска — backend hint-ы от которых зависит
  ожидаемый исход.

Сейчас combat events (`dice:rolled`, `npc:initiative`) приходят, но без
позиции и без явного initiative_order. UI вынужден догадываться.

## Required Server Capability

Сервер должен:

1. Эмитить `combat:initiative_set` в начале combat encounter с полным
   порядком ходов.
2. Включать поле `combat_position` (enum) в combat-related events.
3. Эмитить `combat:position_changed` при движении персонажа между lanes.
4. Опционально: `dice:risk_estimated` событие до самого `dice:rolled` с
   ожидаемой вероятностью успеха для UI risk meter.

## Contract

### SSE / `gui_events` — `combat:initiative_set`

- Durable: yes (нужно для replay)
- Замена / дополнение существующего `npc:initiative`? — backend-агент решит
  (можно объединить, можно оставить параллельно).
- Payload:

  ```json
  {
    "encounterId": "encounter_001",
    "turnId": "...",
    "order": [
      { "entityId": 42, "kind": "player", "name": "Hero",
        "initiative": 18, "position": "mid" },
      { "entityId": 7,  "kind": "npc",    "name": "Bandit Alpha",
        "initiative": 14, "position": "front",
        "portraitPersonaId": "persona_bandit" }
    ]
  }
  ```

### SSE / `gui_events` — `combat:position_changed`

- Durable: yes
- Payload:

  ```json
  {
    "encounterId": "encounter_001",
    "entityId": 7,
    "from": "front",
    "to": "mid",
    "reason": "advance",
    "turnId": "..."
  }
  ```

- `reason`: enum `"advance" | "retreat" | "knockback" | "flank" |
  "teleport" | "knockdown"`. UI маппит в Spine animation tag.

### Расширение существующих combat events

В `dice:rolled` и других combat-events добавить опциональные поля:

```json
{
  "rollerEntityId": 42,
  "rollerPosition": "mid",
  "targetEntityId": 7,
  "targetPosition": "front"
}
```

Чтобы UI мог анимировать «Hero attacks from mid → front» без отдельного
запроса.

### SSE / `gui_events` — `dice:risk_estimated` (опционально, можно отложить)

- Durable: no (transient hint, можно потерять при reload)
- Payload:

  ```json
  {
    "checkId": "check_001",
    "estimatedSuccessProbability": 0.65,
    "modifiers": [
      { "label": "advantage", "value": "+0.10" },
      { "label": "wounded",   "value": "-0.05" }
    ]
  }
  ```

- Эмитится **до** `dice:rolled`, чтобы UI отрисовал risk meter.
- Если backend этого не может — UI скрывает risk meter, не блокер.

### Position enum

`combat_position`: `"front" | "mid" | "back"`.

- `front` — рядом с врагом, melee range.
- `mid` — средняя дистанция, hybrid.
- `back` — дальняя дистанция, ranged / support.

UI рендерит как три горизонтальные полосы сверху вниз:
front (наверху сцены ближе к зрителю) → back (вглубь сцены).

## Localization

- `name` — player-facing prose, уже локализованная.
- `kind`, `position`, `reason` — машинные enum'ы, UI локализует.
- `initiative` — число, без локализации.
- `modifiers[].label` — машинный enum или уже-локализованный? UI ожидает
  enum (`"advantage", "wounded", "flanked"`...) и локализует сам.

## Ordering & Persistence Guarantees

- `combat:initiative_set` durable, эмитится один раз на encounter.
- `combat:position_changed` durable, эмитится при каждой смене.
- При reload UI восстанавливает state: последний `initiative_set` +
  все `position_changed` после него = текущая раскладка.
- Если encounter завершился (`combat:ended` / mode переключился) — UI
  скрывает Combat Theatre overlay, но события остаются в timeline.

## Error & Edge Cases

- Player умер посреди encounter'а: `position: "down"` или отдельный
  флаг? UI предлагает `position: "down"` (отрисовка лежащего портрета).
  Backend-агент решит финал.
- NPC появился посреди encounter'а: `combat:initiative_inserted` event
  с тем же payload что `initiative_set`, но с одной строкой.
- Encounter без NPC (player vs environment): `order` содержит только
  player, UI скрывает initiative bar.

## Non-Goals

- UI **не** хочет тактический грид с координатами (RoleForge территория).
  Только три enum-полосы.
- Не нужны hit chances per-attack — только общая `risk_estimated` до
  броска.
- Не нужны area-of-effect templates / cone calculations.

## Acceptance

- [ ] `combat:initiative_set` эмитится в начале каждого encounter'а;
- [ ] `combat:position_changed` эмитится при каждом движении между lanes;
- [ ] существующие combat events расширены полями `rollerPosition` /
      `targetPosition` где применимо;
- [ ] replay parity для всех новых событий;
- [ ] существующие clients не падают при отсутствии новых полей
      (backwards-compat).

## Suggested Server Touchpoints

(Подсказка.)

- `packages/web-server/src/combat/*` (если есть отдельный combat-движок)
  или там, где сейчас обрабатывается `dice:rolled`.
- `packages/web-server/migrations/*` если позиции хранятся persistently.

## Verification (frontend side)

- Ручной сценарий: войти в combat, увидеть initiative bar; провести
  атаку, увидеть `position_changed` если NPC двигается; reload —
  раскладка восстанавливается.
- Frontend-проверки:
  - `npm --prefix packages/web-ui run build`
  - `npm --prefix packages/web-ui run i18n:check`

## Open Questions

- Эмитится ли `combat:initiative_set` один раз на весь encounter, или
  пере-эмитится каждый round? UI предполагает один раз + per-change
  events.
- Считается ли companion в `order`? UI ожидает `kind: "companion"` если
  есть.
- Нужен ли `combat:ended` явный event, или mode-переключение достаточно?
  UI предполагает что mode `combat → exploration` достаточен (см. также
  `BE-2026-05-05-mode-changed-cue-field.md`).

## Links

- `docs/web-ui/ui-ux-agent-guide.md`
- `BE-2026-05-05-mode-changed-cue-field.md` (mode events взаимодействуют)
- зеркальная FE-спека после реализации:
  `docs/web-ui/frontend-agent-specs/combat-theatre.md` (TBD)
