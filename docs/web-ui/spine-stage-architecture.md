# SpineStage Architecture

Внутренняя документация UI-агента: как устроен Spine2D-рантайм для
персонажей в Greenhaven, какие он принимает команды, какой asset pipeline.

## Цель

Дать персонажам Greenhaven (NPCs, companions, player avatar при
необходимости) **скелетную 2D-анимацию** через Spine2D, реагирующую на
игровые события: смена режима, диалог, бой, интим.

Это уникальный визуальный угол Greenhaven относительно конкурентов
(Friends & Fables — top-down карты + статичные портреты; RoleForge —
hand-drawn maps + grid). Мы не делаем карту мира — мы делаем *живых
персонажей в кадре*.

## Runtime stack

- **Pixi.js v8** — WebGL/WebGPU 2D-рендер. Один canvas, один RAF, scene
  graph.
- **`@esotericsoftware/spine-pixi-v8`** — официальная Spine + Pixi v8
  интеграция от Esoteric.
- Singleplayer + Electron — ассеты лежат локально в `public/spine/`,
  не CDN.
- **Mobile is not supported for this stage.** Keep all assets under 2K
  (1440p).

## Компоненты и хуки

### `<SpineStage />`

Один WebGL canvas, рендерится в GameScreen в зоне между ChatHeader и
MessageFlow (точное место — настраивается layout-стилями). Лениво
монтируется при `mode !== "exploration"` или при наличии диалогового
партнёра. В exploration mode без NPC — скрыт.

Ответственности:

- Pixi App init / teardown.
- Загрузка скелетов NPC по `usePersonaAssets`.
- Применение Pixi-фильтров на основе `mode` (saturation, contrast,
  color matrix).
- Composer overlay (рамки, vignette).
- Reduced-motion fallback: статичная idle-поза, без анимаций.

### `useSpineDirector`

Хук-режиссёр. Слушает SSE и game state, отдаёт команды `<SpineStage />`
через ref. Не рендерит UI сам.

Триггеры → команды:

| Событие / state change                      | Команда стейджу                                          |
| ------------------------------------------- | -------------------------------------------------------- |
| `mode:changed` (с `cue`)                    | `playForAll("mode_<mode>_enter")` + apply mode filter    |
| `dialogue:engaged { npcId }`                | `focus(npcId)` + `play(npcId, "talk_neutral")`           |
| `dialogue:partner_switched { from, to }`    | `unfocus(from)` + `focus(to)`                            |
| `narrate` stream с автором=NPC              | `play(npcId, talkAnimByLength)` пока стрим идёт          |
| `dice:rolled { rollerId, targetId }` (boom) | `play(rollerId, "combat_attack")` + targetId reaction    |
| `damage:dealt { entityId, severity }`       | `play(entityId, "combat_hurt")` (или `idle` если minor)  |
| intimacy beat events (с NSFW unlock)        | `play(npcId, "<oral_sex|vagina_sex|anal_sex>")`          |
| `combat:position_changed { entityId, to }`  | `moveTo(entityId, lane(to))`                             |
| state HP < 20% игрока                       | apply heartbeat shader pulse через filter                |

### `usePersonaAssets`

Кэширующий загрузчик. Для каждого `personaId`:

1. Читает `public/spine/persona/<personaId>/manifest.json`.
2. Если не существует — резолвится в **placeholder asset** (грубый
   серый силуэт со базовыми анимациями). Это значит UI работает до
   того как художник нарисует ассеты.
3. Загружает `skeleton.skel`, `atlas.atlas`, `atlas.png` через Pixi
   loader.
4. Если `useEntitlements().nsfw_2026` true И persona имеет `nsfw/`
   подпапку — догружает NSFW pack.
5. Возвращает `{ skeleton, animations: string[], hasNSFW: bool }`.

### `useEntitlements`

Локальный feature-flag хук. Читает из `clientStorage` (через
`CLIENT_STORAGE_KEYS`). Для core game всегда `true`. Для NSFW —
`false` пока пользователь не активировал DLC-ключ через
Settings → Add-ons.

Ключ DLC проверяется офлайн через подпись (публичный ключ зашит в
бандл). Backend выдаёт ключи отдельно на лендинге (вне scope UI).

## Asset layout

Каждый персонаж = одна папка:

```
public/spine/persona/<personaId>/
  manifest.json
  skeleton.skel
  atlas.atlas
  atlas.png            # 1-2 листа, до 4096×4096 каждый
  nsfw/                # опциональный NSFW-пак, грузится только с
                       # entitlement
    skeleton.skel      # либо тот же скелет с extra animations
    atlas.atlas
    atlas.png
```

### `manifest.json`

```json
{
  "id": "persona_mira",
  "version": 1,
  "skeleton": "skeleton.skel",
  "atlas": "atlas.atlas",
  "default_idle": "idle",
  "scale": 0.5,
  "animations": [
    "idle",
    "talk_neutral",
    "talk_excited",
    "talk_sad",
    "mode_combat_enter",
    "mode_intimacy_enter",
    "mode_rest_enter",
    "mode_dialogue_enter",
    "mode_exploration_enter",
    "mode_travel_enter",
    "combat_attack",
    "combat_hurt"
  ],
  "nsfw_animations": [
    "oral_sex",
    "vagina_sex",
    "anal_sex"
  ]
}
```

Авто-генерируется скриптом `scripts/spine-manifest.mjs` из Spine
export'а — художник не пишет JSON руками.

### Animation tag enum (canonical)

UI знает об этих тегах. Персонаж не обязан иметь все, отсутствующие
заменяются на `idle` с warning в `logFrontend`.

```
Core idle/talk:
  idle
  talk_neutral
  talk_excited
  talk_sad

Mode enters:
  mode_exploration_enter
  mode_dialogue_enter
  mode_travel_enter
  mode_rest_enter
  mode_combat_enter
  mode_intimacy_enter

Combat:
  combat_attack
  combat_hurt

NSFW (gated):
  oral_sex
  vagina_sex
  anal_sex
```

## Mode → visual preset map

Для каждого mode UI применяет ко всему `<SpineStage />` пресет:

| Mode          | Filter                            | Sound bed     | Composer style       |
| ------------- | --------------------------------- | ------------- | -------------------- |
| `exploration` | base saturation 1.0               | wind/ambient  | normal               |
| `dialogue`    | mid focus, soft vignette          | room tone     | `>` quote prefix     |
| `travel`      | parallax fog, blue tint           | road/wind     | normal + ellipsis    |
| `rest`        | warm sepia tint, slow pulse       | hearth/tone   | placeholder ellipsis |
| `combat`      | high contrast, red rim, fast cuts | drums tense   | imperative italic    |
| `intimacy`    | desaturated warm, soft blur       | sparse warm   | soft caret           |

`cue` от backend (см. `BE-2026-05-05-mode-changed-cue-field.md`)
модулирует:

- `triumphant` → ease-out 1200ms + ascending sting + golden vignette flash
- `grim` → ease-in 1500ms + descending sting + ash particles
- `tender` → ease-in-out 2000ms + warm fade
- `abrupt` → linear 200ms + cymbal sting + red flash
- `contemplative` → ease-out 2500ms + low drone fade
- `neutral` → linear 500ms

## Reduced motion

При `prefers-reduced-motion: reduce` (или `useReducedMotion()` true):

- Анимации кадрятся в idle frame; transitions делаются мгновенно.
- Pixi filters остаются (статические).
- Sound bed cross-fade всё ещё работает (это не motion).
- Spine `playForAll` no-op'ит, кроме первого idle.

## Performance budget

- 2 NPC одновременно в кадре максимум в M1. Дальше — пуллинг (cached
  skeletons, swap текстур по personaId).
- Один Pixi App, один RAF, один WebGL context.
- Atlas suggestions: 1–2 листа 4096×4096 на персонажа. Total в памяти
  — 2 × 50MB = ~100MB GPU peak. OK для desktop.
- Stop RAF когда canvas hidden (`mode === "exploration"` && нет
  диалогового партнёра).

## Открытые вопросы (для следующих итераций)

- Lipsync по audio? Сейчас нет — `talk_*` варьируется по длине delta
  стрима. Можно добавить позже через WebAudio analyser.
- Несколько одновременных combat-целей (3+ NPC в кадре) — нужно ли
  расширять "lane" модель за пределы front/mid/back?
- Spine events (Spine может эмитить события на конкретных кадрах
  анимации) — пока не используем; могут пригодиться для синхронизации
  sting'ов с пиковыми моментами анимации.

## Связанные документы

- `BE-2026-05-05-mode-changed-cue-field.md` — backend spec.
- `BE-2026-05-05-strings-graph-endpoint.md` — backend spec.
- `BE-2026-05-05-combat-position-initiative.md` — backend spec.
- `docs/web-ui/ui-ux-agent-guide.md` — общее UI/UX правило.
