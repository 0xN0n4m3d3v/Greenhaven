# Strings graph endpoint

## Spec ID

BE-2026-05-05-strings-graph-endpoint

## Status

Implemented

## Owner

- UI side: ui-ux-agent
- Backend side: backend-agent
- Created: 2026-05-05

## Backend Resolution

Implemented on 2026-05-05.

- Added `GET /api/player/:id/strings/graph`.
- Expanded durable `string:changed` with `stringId`, `from`, `to`, `kind`, `intensity`, `valence`, `turnId`, and `summary`.
- Current directed edge model is `player -> npc`; backend derives `kind` from the existing integer strings count until typed relationship storage exists.
- `summary` uses the latest stored `string:changed.summary` or `reason`, with a deterministic fallback string.
- Mirror frontend contract: `docs/web-ui/frontend-agent-specs/strings-web.md`.

## UI Scenario

Greenhaven позиционируется как «психологический LitRPG-роман» — отношения
и эмоциональные «strings» между героем и NPC являются *центральной*
игровой механикой, а не периферийной.

UI реализует **Strings Web** — гибрид:

- В rail постоянно виден компактный `RelationDial` (3 ближайших NPC,
  тонкие нити к центру, толщина = strings count, цвет = доминирующий kind).
- Клик → fullscreen `RelationsTapestry` модалка с force-directed-style
  графом всех strings игрока: узлы NPC + герой, edges = strings,
  фильтры по kind, drill-down до конкретного string-event.

Сейчас `useStringsFor(entityId, playerId)` возвращает только count.
Этого недостаточно — нужны типы, интенсивности, и граф-структура.

## Required Server Capability

Сервер должен отдавать **граф strings** для игрока: ноды (NPC + игрок) и
edges (strings со типом и интенсивностью), плюс per-string drill-down с
последним связанным memory/event.

## Contract

### HTTP

- Endpoint: `GET /api/player/:id/strings/graph`
- Method: `GET`
- Auth/session assumptions: тот же auth, что и существующие
  `/api/player/:id/*` endpoints.
- Request: `:id` — player id.
- Response (success, 200):

  ```json
  {
    "playerId": 42,
    "asOfTurn": "turn_abc123",
    "nodes": [
      { "id": 42, "kind": "player", "name": "Hero" },
      { "id": 7,  "kind": "npc",    "name": "Mira",
        "portraitPersonaId": "persona_mira" },
      { "id": 11, "kind": "npc",    "name": "Jorek",
        "portraitPersonaId": "persona_jorek" }
    ],
    "edges": [
      {
        "id": "string_001",
        "from": 42,
        "to": 7,
        "kind": "love",
        "intensity": 0.78,
        "valence": "positive",
        "lastEventId": "event_xyz",
        "lastTurnId": "turn_abc",
        "summary": "shared a quiet moment after combat"
      }
    ]
  }
  ```

- Errors:
  - `404` если player не найден;
  - `500` стандартный shape.
- Idempotency: read-only, безопасно поллить.
- Cache / staleness: UI считает данные актуальными как минимум до
  следующего `string:changed` SSE события (см. ниже). Допустимо
  поллить раз в 30 секунд если SSE не доступен.

### SSE / `gui_events`

UI хочет инвалидацию по событию, чтобы не поллить:

- Event type: `string:changed` (существующий уже частично — нужно
  расширить если payload неполный)
- Durable `gui_events`: yes
- Replay: yes
- Payload минимум:

  ```json
  {
    "stringId": "string_001",
    "from": 42,
    "to": 7,
    "kind": "love",
    "intensity": 0.78,
    "delta": "+0.05",
    "turnId": "..."
  }
  ```

- При получении этого события UI инвалидирует кэш graph и/или применяет
  patch локально.

### Edge fields

- `id`: уникальный string id (для drill-down и dedupe).
- `from` / `to`: node id'ы. Strings направлены: `from` — кто чувствует,
  `to` — к кому.
- `kind`: enum категории. UI ожидает минимум:
  - `"love"`, `"desire"`, `"trust"`, `"debt"`, `"rivalry"`, `"fear"`,
    `"resentment"`, `"loyalty"`, `"contempt"`, `"awe"`.
  - Backend может расширять; UI отображает unknown как neutral grey.
- `intensity`: float [0.0, 1.0]. UI маппит в толщину линии.
- `valence`: `"positive" | "negative" | "ambivalent"`. UI маппит в цвет
  (warm / cold / mixed gradient).
- `lastEventId` + `lastTurnId`: для drill-down — UI запросит этот event
  через существующий `/api/session/:id/events?eventId=...` или показывает
  summary inline.
- `summary`: короткая player-facing prose (1 строка), уже локализованная
  на язык сессии.

### Node fields

- `id`: entity id (player id или npc id).
- `kind`: `"player" | "npc"`.
- `name`: player-facing prose, уже локализованная.
- `portraitPersonaId`: optional — чтобы UI мог отрендерить Spine portrait
  в графе.

## Localization

- `summary` приходит уже локализованным на язык сессии (как narrate text).
- `kind`, `valence`, `delta` — машинные enum'ы / числа, UI локализует
  через i18n keys.
- `name` — может быть player-facing (имя NPC).

## Ordering & Persistence Guarantees

- Граф отражает state **после** текущего применённого turn'а
  (`asOfTurn`).
- При параллельных turn'ах — UI берёт последний по `releaseSeq`.
- Persistence: durable, переживает reload.

## Error & Edge Cases

- Игрок без strings: `nodes: [player]`, `edges: []`. Не 404.
- NPC удалён из мира (`companion:removed` etc.): edge остаётся, но node
  получает флаг `"archived": true`. UI рендерит пригашённым.
- Строки выше 1.0 / ниже 0.0: backend клемпит, UI считает out-of-range
  багом и логирует.

## Non-Goals

- UI не нужна история всех string-событий в этом endpoint'е — это
  отдельный запрос (`/api/string/:id/history`, может быть Фаза 4).
- Не нужны прогноз / рекомендации (что-то типа «relationship trajectory»).
- Не делать write-эндпоинт — strings меняются только через игровой turn,
  не через UI.

## Acceptance

- [ ] `GET /api/player/:id/strings/graph` возвращает контракт выше;
- [ ] `string:changed` SSE event эмитится при каждом изменении;
- [ ] payload содержит все обязательные поля;
- [ ] replay через `/api/session/:id/events` возвращает `string:changed`
      в правильном порядке;
- [ ] поллинг и SSE дают согласованную картину (eventual consistency на
      одном turn boundary).

## Suggested Server Touchpoints

(Подсказка.)

- `packages/web-server/src/strings/*` (если такая директория существует)
  или новая.
- Migration если требуется хранилище для kind/intensity (есть ли уже?).
- Hono route в `packages/web-server/src/server.ts` (или где собираются
  /api/player/* routes).

## Verification (frontend side)

- Ручной сценарий: пройти диалог с NPC, увидеть string:changed event,
  открыть RelationsTapestry — увидеть edge.
- Reload: после relationship moment в середине сессии, перезагрузить —
  edge остался, intensity тот же.
- Frontend-проверки:
  - `npm --prefix packages/web-ui run build`
  - `npm --prefix packages/web-ui run i18n:check`

## Open Questions

- Хранится ли `summary` уже-локализованной в БД, или генерируется
  on-the-fly? Если последнее — есть ли кэш?
- Нужна ли пагинация для игроков с >100 strings? UI пока считает что
  весь граф влезает в один response.
- Backward strings: если NPC чувствует к игроку отдельно от того, что
  игрок чувствует к NPC — это два отдельных edge или один с двумя
  intensity? UI предполагает два edge (направленные).

## Links

- `docs/web-ui/ui-ux-agent-guide.md` §State And Hooks (`useStringsFor`)
- `docs/web-ui/components.md` (если описаны rail-виджеты)
- зеркальная FE-спека после реализации:
  `docs/web-ui/frontend-agent-specs/strings-web.md` (TBD)
