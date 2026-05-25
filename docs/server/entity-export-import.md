# Entity Export/Import System

Новый authoring-канон Greenhaven — Obsidian vault:
`GreenhavenWorld/GreenhavenNoir/`. Писатель и гейммастер правят мир там
обычными заметками без YAML, JSON, SQL и служебных ID. Cartridge-состояние
должно собираться из vault через `.greenhaven-agent-manual/skills/`.

**Entity Card I/O** ниже остается совместимым debug/round-trip инструментом для
существующих NPC и квестов в БД. Он больше не является основной системой
авторинга и не должен использоваться как источник истины, если Obsidian vault
содержит ту же сущность.

---

## Entity Card I/O — legacy/debug Markdown + YAML frontmatter

Совместимый инструмент для точечного экспорта/импорта NPC и квестов из
текущей БД. Один файл `.md` на сущность: YAML-заголовок со структурированными
полями и Markdown-тело с прозовыми секциями.

Для нового контента используйте:

- `greenhaven-world-author` — создать человеческую заметку в Obsidian vault;
- `greenhaven-human-world-transformer` — собрать vault в cartridge diff.

### Файлы

| Файл | Назначение |
|------|-----------|
| `packages/web-server/src/scripts/entity-card-io.ts` | CLI-скрипт: экспорт и импорт |
| `packages/web-server/package.json` (строки 35–37) | npm-скрипты `card:export-npc`, `card:export-quest`, `card:import` |

### Поддерживаемые типы сущностей

- **person** (NPC) — экспорт и импорт
- **quest** — экспорт и импорт

Сцены (scene), локации (location), предметы (item) и остальные `kind` **не
поддерживаются** этой legacy-системой. Для нового контента используйте
Obsidian vault.

### CLI-команды

```sh
# Экспорт одного NPC по id
npm --prefix packages/web-server run card:export-npc -- --id 230501 --out ./exports/my-export

# Экспорт всех NPC
npm --prefix packages/web-server run card:export-npc -- --all --out ./exports/my-export

# Экспорт одного квеста
npm --prefix packages/web-server run card:export-quest -- --id 291100 --out ./exports/my-export

# Экспорт всех квестов
npm --prefix packages/web-server run card:export-quest -- --all --out ./exports/my-export

# Импорт из .md файла (dry-run — без записи в БД)
npm --prefix packages/web-server run card:import -- ./exports/my-export/npcs/230501-mikka.md --dry-run

# Импорт с записью в БД
npm --prefix packages/web-server run card:import -- ./exports/my-export/npcs/230501-mikka.md
```

### Флаг --pgdata

Все команды принимают `--pgdata <путь>` для указания директории PGLite.
Это нужно при работе с десктопной БД (`%APPDATA%/GreenHaven/pgdata`):

```sh
npm --prefix packages/web-server run card:export-npc -- --id 230501 --pgdata "C:/Users/.../AppData/Roaming/GreenHaven/pgdata"
```

**Приложение GreenHaven должно быть закрыто** при чтении/записи PGLite.

### Структура выходных файлов

```
<out>/
  npcs/<id>-<slug>.md
  quests/<id>-<slug>.md
```

Например: `npcs/230501-mikka-quickgrin.md`, `quests/291100-нанять-микку-как-спутницу-и-любовницу.md`.

### Формат файла: YAML frontmatter + Markdown body

```
---
id: 230501
kind: person
display_name: Mikka Quickgrin
cartridge_id: grinhaven-full
aliases:
  - Mikka
  - Микка
species: goblin
...
---

# Mikka Quickgrin

## Summary
Goblin info-broker at Grinhaven Main Market Square...

## Description
Long-form description text here...

## Speech style
plain, fast, transactional...
```

#### Поля frontmatter для NPC (kind: person)

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | number | ID сущности в БД (обязательно) |
| `kind` | string | `"person"` (обязательно) |
| `display_name` | string | Отображаемое имя |
| `cartridge_id` | string | ID картриджа-источника |
| `aliases` | string[] | Псевдонимы для @-упоминаний |
| `species` | string | Раса (goblin, human, elf...) |
| `pronouns` | string | Местоимения |
| `age` | number | Возраст |
| `venue_role` | string | Роль в локации |
| `home_id` | number | ID домашней локации |
| `location_id` | number | ID текущей локации |
| `current_location_id` | number | ID текущей локации |
| `power_center_id` | number | ID центра силы |
| `power_center_role` | string | Роль в центре силы |
| `portrait_set` | object | Набор портретов (default, amused...) |
| `price_list` | object | Прайс-лист услуг |
| `tags` | string[] | Теги |
| `strings` | object | Отношения с игроками (read-only) |
| `quests` | {id, title}[] | Квесты NPC (read-only) |
| `scenes` | {id, title}[] | Сцены с участием NPC (read-only) |
| `extra_profile` | object | Все остальные profile-ключи, не попавшие в основные поля |

#### Поля frontmatter для квеста (kind: quest)

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | number | ID сущности в БД (обязательно) |
| `kind` | string | `"quest"` (обязательно) |
| `display_name` | string | Отображаемое имя |
| `cartridge_id` | string | ID картриджа-источника |
| `giver_entity_id` | number | ID NPC-квестодателя |
| `source_entity_id` | number | ID источника квеста |
| `location_id` | number | ID локации |
| `tags` | string[] | Теги |
| `stages` | object[] | Стадии квеста (id, title, next_stage, description) |
| `extra_profile` | object | Нестандартные profile-ключи |

#### Прозовые секции в body (Markdown-заголовки ##)

**NPC:**
- `## Summary` — краткое описание (маппится на `entities.summary`)
- `## Description` — полное описание
- `## Archetype` — архетип персонажа
- `## Role` — роль в мире
- `## Personality` — характер
- `## Speech style` — речевой стиль
- `## Narrator brief` — инструкция для нарратора
- `## Goal` — цель персонажа
- `## Consent register` — регистр согласия (для интимных сцен)
- `## Backstory` — предыстория
- `## System prompt overlay` — оверлей системного промпта

**Квест:**
- `## Summary` — краткое описание (маппится на `entities.summary`)
- `## Description` — полное описание
- `## Hook` — зацепка для игрока
- `## Goal` — цель квеста
- `## Accept condition` — условие принятия
- `## Bridge summary` — мостовое описание
- `## Narrator brief` — инструкция для нарратора

#### Read-only блоки (не редактируются при импорте)

- `## Memory bank (read-only; top 12 by salience)` — топ-12 записей памяти NPC.
  Выгружается для контекста, но **не импортируется обратно**. Формат каждой
  записи:
  ```
  - (sal 0.85, imp 0.90) [private] about=Игрок {tag1,tag2}: текст памяти
  ```
- `local_density`, `local_density_summary`, `transitive_density_summary` в
  profile — вычисляемые индексы плотности мира. Не экспортируются и не
  перезаписываются при импорте.

### Процесс импорта (недеструктивный merge)

1. Файл парсится: извлекается YAML-фронтматтер и тело
2. Валидация: `id` (положительное целое), `kind` (`person` или `quest`)
3. Загрузка существующей сущности из БД (отказ, если не найдена — карточки
   только round-trip)
4. Построение нового profile:
   - База: существующий `profile` из БД (все DB-ключи выживают)
   - YAML-ключи из фронтматтера применяются поверх
   - `extra_profile` применяется поверх
   - Прозовые секции из body применяются поверх
   - `display_name`, `summary`, `tags` обновляются отдельно
5. `--dry-run` показывает diff в JSON без записи в БД
6. Без `--dry-run` выполняет `UPDATE entities SET ...`

Ключевое свойство: всё, что НЕ упомянуто в файле, остаётся нетронутым в БД.
Никакого деструктивного перезаписывания.

### Что НЕ экспортируется в чистых БД

- `npc_memories` — только если есть записи в БД (после реальной игры)
- `player_quests` — только если игрок принял квесты
- `chat_messages` — история чата не входит в карточку

---

## Важные ограничения

1. **Entity Card I/O не поддерживает scenes и locations.** Только `person` (NPC) и `quest`.
   Для массового создания/редактирования сцен и локаций используйте прямые SQL-миграции
   (паттерн: новая миграция с INSERT/UPDATE).

2. **Entity Card I/O только round-trip.** Нельзя создать новую сущность из `.md` файла — 
   только обновить существующую. Для создания новых сущностей используйте SQL-миграции.

3. **Закрывайте десктопное приложение** при работе с `--pgdata`. PGLite эксклюзивно
   лочит файлы БД.

4. **Read-only блоки не импортируются.** Memory bank, strings, quests, scenes
   в NPC-карточке — для контекста. Редактирование этих данных происходит
   только через игровой процесс или прямые SQL-запросы.

## Удалённые системы

Следующие системы удалены 2026-05-14 в пользу единой Entity Card I/O:

- **SillyTavern Character Card v2** — `security/silly-tavern-card.ts`, `routes/cards.ts`,
  `CharacterCardsTab.tsx`. PNG-формат для community interop. Удалён: не использовался в
  основном игровом цикле, дублировал экспорт NPC.

- **Cartridge Forge agent-pack** — `packages/cartridge-forge`. JSONL-формат для массового
  авторства контента. Удалён из web-server (не был интегрирован в рантайм).

- **Grinhaven Compile** — `scripts/compile-grinhaven-cartridge.ts`,
  `scripts/repair-grinhaven-yaml.ts`, `scripts/verify-grinhaven-release-cartridge.ts`.
  YAML→SQL пайплайн. Удалён: контент уже загружен через миграции 0082/0084.
