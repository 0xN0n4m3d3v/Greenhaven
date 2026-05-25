from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
import re
from typing import Any, Iterable

from vault_scan import (
    MENTION_PATTERN,
    Entity,
    clean_mention,
    default_vault_root,
    get_slug,
    heading_ranges,
    mention_index,
    read_text,
    scan_vault,
)


SECTION_PATTERN = re.compile(r"(?m)^##\s+(.+?)\s*$")
WIKILINK_PATTERN = re.compile(r"\[\[([^|\]]+)(?:\|[^\]]+)?\]\]")
MATERIALIZES_FIELD_PATTERN = re.compile(
    r"^\s*(?:-\s*)?(Entity|Type|Scope|Effect)\s*:\s*(.*?)\s*$",
    re.I,
)
PRICE_PATTERN = re.compile(
    r"(?P<amount>\d+)\s+(?P<coin>@Gold coin|@Silver coin|@Copper coin)",
    re.I,
)

# OWV-12 hardening: a *new* logical stage starts when a line opens with
# either `<digits>.` / `<digits>)` followed by whitespace, or a list-
# bullet marker (`-`, `*`, `•`) followed by whitespace. Lines without a
# marker — including indented continuations the writer wraps onto the
# next line — fold into the active stage instead of becoming new ones.
STAGE_MARKER_RE = re.compile(r"^(?:\d+[.)]\s+|[-*•]\s+)")
STAGE_ID_PREFIX_RE = re.compile(r"^(?P<id>[a-z][a-z0-9_-]{1,80})\s*:\s+(?P<goal>.+)$")
STAGE_FIELD_RE = re.compile(r"^\s*(?:-\s*)?(?P<key>[a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(?P<value>.*?)\s*$")
RELATIONSHIP_BUCKET_RE = re.compile(
    r"^(?P<sign>[+-])\s*strings(?:\s*(?:for me|для меня))?\s*:?\s*(?P<value>.*)$",
    re.I,
)
COMPANION_RULE_RE = re.compile(
    r"^(?:[-*â€¢]\s*)?(?P<label>[A-Za-z][A-Za-z -]*(?:\([^)]+\))?)\s*:\s*(?P<value>.*)$"
)
QUEST_STRING_RE = re.compile(
    r"(?:(?P<quality>strong|deep|severe|minor|small)\s+)?(?P<sign>[+-])\s*strings?\s+with\s+(?P<rest>.+)$",
    re.I,
)
QUEST_XP_RE = re.compile(r"(?P<amount>[+-]?\d{1,6})\s*(?:xp|experience)\b", re.I)
QUEST_ITEM_RE = re.compile(r"^(?:item|inventory|reward item|gain)\s*:\s*(?P<rest>.+)$", re.I)
QUEST_STATUS_RE = re.compile(r"^status\s*:\s*(?P<rest>.+)$", re.I)
QUEST_STATUS_KINDS = {
    "trust",
    "fear",
    "hostile",
    "wounded",
    "missing",
    "dead",
    "companion",
}


SECTION_ALIASES: dict[str, set[str]] = {
    "identity": {"identity", "канон", "канон персонажа"},
    "appearance": {"appearance", "внешний вид"},
    "sexual_appearance": {"sexual appearance", "внешний вид для секса"},
    "voice": {"voice", "голос", "голос и реплики"},
    "relationship": {"relationship", "отношения"},
    "romance": {"romance", "романтика"},
    "skills": {"skills", "навыки"},
    "behavior": {"behavior", "поведение", "ход сцены"},
    "merchant": {"merchant", "торговец", "торговля"},
    "materializes": {"materializes", "материализует", "материализация"},
    "inventory": {"inventory", "инвентарь"},
    "location_canon": {"канон места", "описание для мастера"},
    "location_brief": {"как площадь ощущается", "что здесь есть"},
    "location_rules": {"правила локации", "не делать"},
    "item_canon": {"канон предмета"},
    "item_description": {"описание"},
    "item_usage": {"использование"},
    # OBSIDIAN-VAULT-IMPORT-1 (2026-05-18) — live English vault NPC
    # headings authored by the world-building agents. Without these
    # the rich live-vault NPC structure (role, want, fear, secret,
    # routine, relationship triggers, memory hooks, companion rules,
    # portrait brief) silently collapsed into the H1+identity fallback
    # used by `public_summary`, so the GUI-imported cartridge could
    # not see the canonical NPC frame the writers spent time on.
    "npc_role": {"role", "роль"},
    "npc_want": {"want", "чего хочу", "цель персонажа"},
    "npc_fear": {"fear", "чего боюсь", "страх"},
    "npc_secret": {
        "secret",
        "pressure",
        "secret / pressure",
        "secret/pressure",
        "тайна",
        "давление",
    },
    "npc_routine": {"routine", "распорядок", "распорядок дня"},
    "npc_relationship_triggers": {
        "relationship triggers",
        "триггеры отношений",
    },
    "npc_memory_hooks": {"memory hooks", "хуки памяти", "якоря памяти"},
    "npc_companion_rules": {
        "companion rules",
        "правила спутника",
        "правила компаньона",
    },
    "npc_appearance_for_portrait": {
        "appearance for portrait",
        "портрет",
        "брифинг портрета",
    },
    # OWV-12 hardening: include the live action-unlock vault headings.
    # Action-unlock quests (e.g. `Way to Thief's market`) author the
    # source frame under `## Источник действия`, the conditions block
    # under `## Условия`, and the player-facing instruction under
    # `## Как игрок может это сделать` — without those aliases the
    # quest parser used to silently fall through to `public_summary`,
    # which leaked the raw `# Title` line into the generated
    # `objective` / `stages[].goal` fields.
    "quest_source": {
        "источник",
        "источник действия",
        "условия",
        "source",
    },
    "quest_hook": {"крючок", "завязка", "hook"},
    "quest_objective": {
        "цель",
        "как игрок может это сделать",
        "objective",
    },
    "quest_stages": {"стадии", "stages", "beat by beat"},
    "quest_rewards": {
        "награды и последствия",
        "rewards",
        "reward",
        "reward and consequence",
        "rewards and consequences",
    },
    "quest_failure": {
        "не делать",
        "do not",
        "do not do here",
        "failure",
    },
    # OBSIDIAN-VAULT-IMPORT-1 — split success vs failure result so
    # the GUI cartridge can surface the writer's two-sided outcome
    # instead of folding everything into one `failure` bucket.
    "quest_success_result": {"success result", "результат успеха"},
    "quest_failure_result": {"failure result", "результат провала"},
    "scene_trigger": {
        "триггер",
        "когда включается",
        "где и когда",
        "where and when",
    },
    "scene_hook": {"hook", "крючок"},
    "scene_behavior": {"поведение", "ход сцены", "beat by beat"},
    "scene_state": {"инструменты и состояние", "игровое состояние"},
    "scene_do_not": {"не делать", "do not do here"},
    # OBSIDIAN-VAULT-IMPORT-1 — live-vault scene structure. Beat By
    # Beat anchors the runtime turn cadence; Player Choices is the
    # action menu the broker should reference; Memory And String
    # Changes is the post-scene strings/memory plan; Success Result
    # / Failure Result are the two-sided outcome plan used by the
    # narrator and the materializer.
    "scene_beat_by_beat": {"beat by beat", "ход сцены"},
    "scene_player_choices": {"player choices", "варианты для игрока"},
    "scene_memory_and_string_changes": {
        "memory and string changes",
        "memory hooks",
        "memory hook",
        "memory changes",
        "string changes",
        "изменения памяти и строк",
        "изменения строк",
    },
    "scene_success_result": {"success result", "результат успеха"},
    "scene_failure_result": {"failure result", "результат провала"},
    "coins": {"coins"},
    "exchange_rate": {"exchange rate"},
    "trade_memory": {"trade memory"},
}


# BRIDGE-ENGLISH-HEADINGS-1 (2026-05-18): the visible Obsidian vault
# is English-first. Keep the legacy Russian aliases above, but extend the
# bridge with the English contract used by GreenHavenWorld notes so authored
# location/item fields survive compile instead of collapsing into prose
# fallbacks. Alias conflicts are trimmed where they caused real payload
# corruption: a scene `## Beat By Beat` block must not also become
# `scene_behavior`, and quest stages should not steal scene cadence headings.
SECTION_ALIASES["location_canon"] |= {
    "place canon",
    "location canon",
}
SECTION_ALIASES["location_brief"] |= {
    "location brief",
    "place brief",
    "sensory brief",
    "overview",
}
SECTION_ALIASES["location_rules"] |= {
    "location rules",
    "city rules",
    "do not",
    "do not do here",
}
SECTION_ALIASES.update(
    {
        "location_first_entry": {
            "first entry bubble",
            "first-entry bubble",
            "intro bubble",
            "introduction bubble",
        },
        "location_sensory_identity": {
            "sensory identity",
            "sensory identity and mood",
            "senses",
            "how the city feels",
        },
        "location_visible_exits": {
            "visible exits",
            "exits",
            "visible routes",
        },
        "location_points_of_interest": {
            "points of interest",
            "points of interest here",
            "points of interest in the port itself",
            "things to notice",
            "what is here",
            "what is inside",
        },
        "location_immediate_actions": {
            "immediate player actions",
            "immediate actions",
            "available actions",
            "player actions",
            "playable hooks",
        },
        "location_hostile_pressure": {
            "hostile and rival pressure",
            "hostile pressure",
            "hostile pressure already in play",
            "rival pressure",
            "threats",
        },
        "location_adventure_threat": {
            "adventure threat",
            "dangers",
            "threat profile",
        },
        "location_memory_hooks": {
            "memory and consequence hooks",
            "location memory hooks",
            "consequence hooks",
            "memory",
        },
        "location_establishing_image": {
            "establishing image brief",
            "establishing image",
            "location image brief",
            "appearance for establishing image",
            "visual brief",
        },
        "location_public_scenes": {
            "public scenes",
            "public scenes authored in this round",
            "location-owned scenes",
            "location owned scenes",
        },
        "location_companion_stake": {
            "companion stake",
        },
        "media_script": {
            "media script",
            "music script",
            "audio script",
            "scene media",
            "location media",
        },
        "item_threat_profile": {
            "threat profile",
        },
        "item_cross_hub_reach": {
            "cross-hub reach",
            "cross hub reach",
        },
        "item_visual_brief": {
            "visual brief",
            "image brief",
            "icon brief",
        },
        "item_do_not": {
            "do not do here",
            "do not",
            "item rules",
        },
    }
)
SECTION_ALIASES["item_canon"] |= {"item canon"}
SECTION_ALIASES["item_description"] |= {"description", "item description"}
SECTION_ALIASES["item_usage"] |= {"usage", "item usage", "use"}
SECTION_ALIASES["quest_source"] |= {"given by", "giver", "quest giver"}
SECTION_ALIASES["romance"] |= {
    "romance / trust hooks",
    "romance / temptation hooks",
}
SECTION_ALIASES["npc_routine"] |= {"routine with the hero"}
SECTION_ALIASES["scene_trigger"] |= {"trigger"}
SECTION_ALIASES["scene_behavior"] |= {"scene"}
SECTION_ALIASES["scene_player_choices"] |= {"player choice"}
SECTION_ALIASES["scene_state"] |= {
    "scene state",
    "tools and state",
    "instruments and state",
    "game state",
}
SECTION_ALIASES["scene_behavior"] |= {"scene behavior"}
SECTION_ALIASES["quest_stages"].discard("beat by beat")
SECTION_ALIASES["scene_behavior"].discard("beat by beat")
SECTION_ALIASES["quest_stages"] -= SECTION_ALIASES["scene_beat_by_beat"]
SECTION_ALIASES["scene_behavior"] -= SECTION_ALIASES["scene_beat_by_beat"]
SECTION_ALIASES["behavior"] -= SECTION_ALIASES["scene_beat_by_beat"]


@dataclass(frozen=True)
class NoteSections:
    entity: Entity
    heading: str | None
    sections: dict[str, str]


@dataclass(frozen=True)
class MaterializesEntry:
    source_mention: str
    source_path: str
    entity: str
    entity_slug: str
    target_status: str
    trigger_condition: str
    trigger_source: str
    type: str
    scope: str
    effect: str


@dataclass(frozen=True)
class MerchantOffer:
    source_mention: str
    source_path: str
    line: str
    copper_value: int
    coins: tuple[dict[str, int | str], ...]


@dataclass(frozen=True)
class ManifestInfo:
    start_wikilink: str | None
    start_mention: str | None
    start_slug: str | None
    source_path: str


@dataclass(frozen=True)
class QuestStage:
    """One stage entry pulled from a `## Стадии` / `## Stages` list.

    ``goal`` is the prose body of the stage with the leading number /
    bullet trimmed. ``mentions`` preserves every canonical ``@Name`` token
    *in original order* (deduped) so quest preparation code can hand the
    runtime the same set of entities the writer named.
    """

    stage_slug: str
    stage_id: str
    goal: str
    mentions: tuple[str, ...]
    next_stage: str | dict[str, Any] | None = None
    prerequisites: tuple[dict[str, Any], ...] = ()
    turns_remaining: int | None = None
    on_timeout: dict[str, Any] | None = None
    advance_on: str | None = None


@dataclass(frozen=True)
class ParsedQuest:
    """Reusable quest-note view consumed by ``compile_vault_to_forge``.

    The compiler used to inline `section(note, 'quest_objective')` / its
    siblings plus a one-off stage parser, which made every consumer
    re-derive the same shape. ``parse_quest_sections`` centralises the
    extraction so OWV-12 tests and future runtime importers see one
    canonical structure.
    """

    source_path: str
    source: str
    hook: str
    objective: str
    rewards: str
    failure: str
    stages: tuple[QuestStage, ...]
    stage_mentions: tuple[str, ...]
    materialized_slugs: tuple[str, ...]


def split_sections(text: str) -> tuple[str | None, dict[str, str]]:
    heading_match = re.search(r"(?m)^#\s+(.+?)\s*$", text)
    heading = heading_match.group(1).strip() if heading_match else None
    matches = list(SECTION_PATTERN.finditer(text))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        key = normalize_heading(match.group(1))
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[key] = text[match.end() : end].strip()
    return heading, sections


def note_sections(entity: Entity) -> NoteSections:
    heading, sections = split_sections(entity.text)
    return NoteSections(entity=entity, heading=heading, sections=sections)


def section(note: NoteSections, canonical: str, default: str = "") -> str:
    aliases = SECTION_ALIASES.get(canonical, {canonical})
    for alias in aliases:
        value = note.sections.get(normalize_heading(alias))
        if value:
            return value.strip()
    return default


def first_non_empty(*values: str) -> str:
    for value in values:
        cleaned = value.strip()
        if cleaned:
            return cleaned
    return ""


def short_text(text: str, max_chars: int = 600) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    if len(cleaned) <= max_chars:
        return cleaned or "Greenhaven authored world note."
    truncated = cleaned[: max_chars - 1].rstrip()
    return f"{truncated}."


def public_summary(note: NoteSections, max_chars: int = 600) -> str:
    if note.entity.kind == "person":
        text = first_non_empty(
            section(note, "identity"),
            section(note, "appearance"),
            note.entity.text,
        )
        return short_text(text, max_chars)
    if note.entity.kind == "location":
        text = first_non_empty(
            section(note, "location_canon"),
            section(note, "location_brief"),
            note.entity.text,
        )
        return short_text(text, max_chars)
    if note.entity.kind == "item":
        text = first_non_empty(
            section(note, "item_canon"),
            section(note, "item_description"),
            note.entity.text,
        )
        return short_text(text, max_chars)
    if note.entity.kind == "quest":
        text = first_non_empty(
            section(note, "quest_hook"),
            section(note, "quest_objective"),
            note.entity.text,
        )
        return short_text(text, max_chars)
    if note.entity.kind == "scene":
        text = first_non_empty(
            section(note, "scene_trigger"),
            section(note, "scene_behavior"),
            note.entity.text,
        )
        return short_text(text, max_chars)
    return short_text(note.entity.text, max_chars)


def parse_manifest(vault: Path, entities: Iterable[Entity]) -> ManifestInfo:
    manifest = vault / "WORLD_MANIFEST.md"
    if not manifest.is_file():
        return ManifestInfo(None, None, None, "WORLD_MANIFEST.md")
    text = read_text(manifest)
    start_block = manifest_start_block(text)
    wikilink = None
    match = WIKILINK_PATTERN.search(start_block)
    if match:
        wikilink = match.group(1).strip()

    start_mention = None
    if wikilink:
        start_mention = resolve_wikilink_to_mention(wikilink, entities)
    if not start_mention:
        mention = MENTION_PATTERN.search(start_block)
        if mention:
            start_mention = clean_mention(mention.group(0))

    return ManifestInfo(
        start_wikilink=wikilink,
        start_mention=start_mention,
        start_slug=get_slug(start_mention) if start_mention else None,
        source_path="WORLD_MANIFEST.md",
    )


def manifest_start_block(text: str) -> str:
    matches = list(SECTION_PATTERN.finditer(text))
    for index, match in enumerate(matches):
        heading = normalize_heading(match.group(1))
        if heading not in {"начало игры", "start of the game"}:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        return text[match.end() : end]
    return text


def resolve_wikilink_to_mention(wikilink: str, entities: Iterable[Entity]) -> str | None:
    target = wikilink.strip().replace("\\", "/")
    target_stem = Path(target).stem.lower()
    for entity in entities:
        if Path(entity.path).stem.lower() == target_stem:
            return entity.mention
        if entity.display.lower() == target_stem:
            return entity.mention
        if entity.slug == get_slug(target_stem):
            return entity.mention
    return None


def parse_materializes(
    note: NoteSections,
    all_mentions: dict[str, list[Entity]],
) -> list[MaterializesEntry]:
    out: list[MaterializesEntry] = []
    block = section(note, "materializes")
    if not block:
        return out

    current: dict[str, str] | None = None
    current_field: str | None = None
    for raw_line in block.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        trigger = re.match(r"^[-*Ã¢â‚¬Â¢]\s*(?P<trigger>.+?):\s*$", stripped)
        if trigger and not MATERIALIZES_FIELD_PATTERN.match(line):
            if current and current.get("entity"):
                out.append(materializes_entry(note, current, all_mentions))
            current = {"trigger_condition": trigger.group("trigger").strip()}
            current_field = None
            continue
        field = MATERIALIZES_FIELD_PATTERN.match(line)
        if field:
            key = field.group(1).lower()
            value = field.group(2).strip()
            current_field = key
            if key == "entity":
                if current and current.get("entity"):
                    out.append(materializes_entry(note, current, all_mentions))
                    current = {}
                if current is None:
                    current = {}
                mention = first_mention(value)
                current["entity"] = mention or value.strip()
            elif current is not None:
                current[key] = value
            continue

        if current is not None and current_field and line.startswith((" ", "\t")):
            continuation = line.strip()
            if continuation:
                current[current_field] = f"{current.get(current_field, '')} {continuation}".strip()

    if current:
        out.append(materializes_entry(note, current, all_mentions))
    return out


def materializes_entry(
    note: NoteSections,
    fields: dict[str, str],
    all_mentions: dict[str, list[Entity]],
) -> MaterializesEntry:
    target = fields.get("entity", "").strip()
    mention = first_mention(target) or target
    if mention and not mention.startswith("@"):
        mention = f"@{mention}"
    status = "existing" if mention in all_mentions else "new"
    return MaterializesEntry(
        source_mention=note.entity.mention,
        source_path=note.entity.path,
        entity=mention,
        entity_slug=get_slug(mention),
        target_status=status,
        trigger_condition=fields.get("trigger_condition", "").strip(),
        trigger_source=classify_materializer_trigger(
            note.entity.kind,
            fields.get("trigger_condition", ""),
            fields.get("type", ""),
            fields.get("effect", ""),
        ),
        type=fields.get("type", "unknown").strip() or "unknown",
        scope=fields.get("scope", "").strip(),
        effect=fields.get("effect", "").strip(),
    )


def classify_materializer_trigger(
    source_kind: str,
    condition: str,
    type_value: str,
    effect: str,
) -> str:
    """Classify a human Materializes trigger into a conservative runtime bucket.

    This does not auto-execute anything by itself. It gives the broker and
    future arbiters a stable source label so deterministic triggers can be
    routed without re-parsing prose from scratch.
    """

    text = f"{condition} {type_value} {effect}".lower()
    if source_kind == "quest":
        return "quest_stage"
    if source_kind == "scene":
        return "scene_choice"
    if source_kind == "item":
        return "item_use"
    if "uses " in text or "use " in text or "used " in text:
        return "item_use"
    if "stage" in text or "quest" in text or "reward" in text:
        return "quest_stage"
    if "choice" in text or "scene" in text or "success" in text or "failure" in text:
        return "scene_choice"
    if "string" in text or "trust" in text or "relationship" in text or "companion" in text:
        return "relationship"
    if source_kind == "location":
        return "location_explore"
    return "manual_only"


def parse_merchant_offers(note: NoteSections) -> list[MerchantOffer]:
    block = section(note, "merchant")
    if not block:
        return []
    offers: list[MerchantOffer] = []
    for raw_line in block.splitlines():
        line = raw_line.strip()
        if not line.startswith("-"):
            continue
        prices = list(PRICE_PATTERN.finditer(line))
        if not prices:
            continue
        coins: list[dict[str, int | str]] = []
        total = 0
        for price in prices:
            amount = int(price.group("amount"))
            coin = normalize_coin(price.group("coin"))
            total += amount * coin_value(coin)
            coins.append({"coin": coin, "amount": amount})
        offers.append(
            MerchantOffer(
                source_mention=note.entity.mention,
                source_path=note.entity.path,
                line=line.lstrip("- ").strip(),
                copper_value=total,
                coins=tuple(coins),
            )
        )
    return offers


def parse_currency_values(note: NoteSections) -> dict[str, int] | None:
    if note.entity.kind != "item":
        return None
    if "@copper coin" in note.entity.mention.lower():
        return {"copper_value": 1}
    if "@silver coin" in note.entity.mention.lower():
        return {"copper_value": 10}
    if "@gold coin" in note.entity.mention.lower():
        return {"copper_value": 100}
    text = note.entity.text.lower()
    if "валюта" not in text and "currency" not in text:
        return None
    match = re.search(r"номинал:\s*(\d+)\s+@copper coin", text, re.I)
    if match:
        return {"copper_value": int(match.group(1))}
    return {"copper_value": 1}


def enclosing_location_slug(entity: Entity, entities: Iterable[Entity]) -> str | None:
    location_mentions = {item.mention: item for item in entities if item.kind == "location"}
    own_parts = entity.parts
    for part in reversed(own_parts):
        if not part.startswith("@"):
            continue
        mention = part
        target = location_mentions.get(mention)
        if target and target.mention != entity.mention:
            return target.slug
        if entity.kind == "location" and target and target.mention == entity.mention:
            continue
    return None


def location_parent_slug(entity: Entity, entities: Iterable[Entity]) -> str | None:
    if entity.kind != "location":
        return None
    location_mentions = {item.mention: item for item in entities if item.kind == "location"}
    seen_self = False
    for part in reversed(entity.parts):
        if not part.startswith("@"):
            continue
        if not seen_self and part == entity.mention:
            seen_self = True
            continue
        target = location_mentions.get(part)
        if target:
            return target.slug
    return None


def owner_slug(entity: Entity) -> str | None:
    return get_slug(entity.owner) if entity.owner else None


def mentions_in_text(text: str) -> list[str]:
    out: list[str] = []
    for match in MENTION_PATTERN.finditer(text):
        mention = clean_mention(match.group(0))
        if mention not in out:
            out.append(mention)
    return out


def parse_relationship_trigger_rules(value: str) -> list[dict[str, Any]]:
    """Parse NPC `Relationship Triggers` prose into bounded string deltas.

    The human contract intentionally stays markdown-first. Writers use
    `+strings:` / `-strings:` buckets and ordinary bullets; this helper keeps
    that visible shape while giving runtime a deterministic packet to inspect.
    Non-bucket prose is preserved only in the original `relationship_triggers`
    field emitted by `npc_payload()`.
    """

    rules: list[dict[str, Any]] = []
    current_delta: int | None = None
    active: dict[str, Any] | None = None

    def finish() -> None:
        nonlocal active
        if not active:
            return
        condition = str(active.get("condition", "")).strip()
        if condition:
            active["condition"] = re.sub(r"\s+", " ", condition)
            active["mentions"] = _contract_mentions_in_text(condition)
            rules.append(active)
        active = None

    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            finish()
            continue
        bucket = RELATIONSHIP_BUCKET_RE.match(line)
        if not bucket and re.match(r"^[-*â€¢]\s+[+-]\s*strings", line, re.I):
            bucket = RELATIONSHIP_BUCKET_RE.match(_strip_list_marker(line))
        if bucket:
            finish()
            current_delta = 1 if bucket.group("sign") == "+" else -1
            inline = bucket.group("value").strip()
            if inline:
                active = {
                    "kind": "strings_delta",
                    "delta": current_delta,
                    "condition": _strip_list_marker(inline),
                    "source": "npc_relationship_triggers",
                }
            continue
        if current_delta is None:
            continue
        if _is_list_item(line):
            finish()
            active = {
                "kind": "strings_delta",
                "delta": current_delta,
                "condition": _strip_list_marker(line),
                "source": "npc_relationship_triggers",
            }
            continue
        if active:
            active["condition"] = f"{active['condition']} {line}".strip()

    finish()
    return rules


def parse_companion_rule_contract(value: str) -> dict[str, Any] | None:
    """Parse NPC `Companion Rules` into a stable, low-risk contract packet."""

    rules: list[dict[str, Any]] = []
    active: dict[str, Any] | None = None

    def finish() -> None:
        nonlocal active
        if not active:
            return
        text = str(active.get("text", "")).strip()
        if text:
            active["text"] = re.sub(r"\s+", " ", text)
            active["mentions"] = _contract_mentions_in_text(text)
            rules.append(active)
        active = None

    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            finish()
            continue
        match = COMPANION_RULE_RE.match(line)
        if match:
            finish()
            label = match.group("label").strip()
            active = {
                "kind": _companion_rule_kind(label),
                "label": label,
                "text": match.group("value").strip(),
                "source": "npc_companion_rules",
            }
            continue
        if active:
            active["text"] = f"{active['text']} {_strip_list_marker(line)}".strip()

    finish()

    raw = re.sub(r"\s+", " ", value).strip()
    if not rules and raw:
        rules.append(
            {
                "kind": "manual_only",
                "label": "Companion Rules",
                "text": raw,
                "mentions": _contract_mentions_in_text(raw),
                "source": "npc_companion_rules",
            }
        )
    if not rules:
        return None
    return {
        "schema_version": "greenhaven.companion_rules.v1",
        "can_be_companion": True,
        "portability": _companion_portability(rules),
        "rules": rules,
    }


def parse_quest_reward_contract(value: str) -> dict[str, Any]:
    """Parse `Reward And Consequence` into the runtime's reward object.

    The existing quest runtime already knows how to apply top-level `xp`,
    `strings`, `memory`, and field-patch rewards. This bridge parser extracts
    the low-risk forms common in human notes and preserves the rest under
    `manual_only` so prose is not mistaken for executed state.
    """

    rewards: dict[str, Any] = {
        "schema_version": "greenhaven.quest_rewards.v1",
    }
    strings: list[dict[str, Any]] = []
    companions: list[dict[str, Any]] = []
    memories: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []
    statuses: list[dict[str, Any]] = []
    manual: list[str] = []
    xp_total = 0

    for raw_line in value.splitlines():
        line = _strip_list_marker(raw_line.strip())
        if not line:
            continue
        xp_match = QUEST_XP_RE.search(line)
        if xp_match:
            xp_total += int(xp_match.group("amount"))
            continue
        string_match = QUEST_STRING_RE.search(line)
        if string_match:
            mentions = _contract_mentions_in_text(string_match.group("rest"))
            if not mentions:
                npc = first_mention(string_match.group("rest"))
                mentions = [npc] if npc else []
            if mentions:
                delta = _quest_string_delta(
                    string_match.group("sign"),
                    string_match.group("quality") or "",
                )
                for npc in mentions[:8]:
                    strings.append(
                        {
                            "npc": npc,
                            "delta": delta,
                            "reason": re.sub(r"\s+", " ", line).strip(),
                        }
                    )
                continue
        item_match = QUEST_ITEM_RE.match(line)
        if item_match:
            mentions = _contract_mentions_in_text(item_match.group("rest"))
            if mentions:
                count = _parse_reward_count(item_match.group("rest"))
                for item in mentions[:8]:
                    items.append(
                        {
                            "item": item,
                            "count": count,
                            "reason": re.sub(r"\s+", " ", line).strip(),
                        }
                    )
                continue
        status_match = QUEST_STATUS_RE.match(line)
        if status_match:
            status = _parse_reward_status(status_match.group("rest"), line)
            if status:
                statuses.append(status)
                continue
        if line.lower().startswith("companion:"):
            mentions = _contract_mentions_in_text(line)
            if mentions:
                companions.append(
                    {
                        "npc": mentions[0],
                        "action": "follow",
                        "reason": re.sub(r"\s+", " ", line).strip(),
                    }
                )
                continue
        if line.lower().startswith("memory:"):
            mentions = _contract_mentions_in_text(line)
            text = re.sub(r"\s+", " ", line).strip()
            for mention in mentions[:8]:
                memories.append(
                    {
                        "owner": mention,
                        "about": "current_player",
                        "text": text,
                        "importance": 0.6,
                    }
                )
            if mentions:
                continue
        manual.append(re.sub(r"\s+", " ", line).strip())

    if xp_total:
        rewards["xp"] = xp_total
    if strings:
        rewards["strings"] = strings
    if items:
        rewards["items"] = items
    if statuses:
        rewards["statuses"] = statuses
    if companions:
        rewards["companions"] = companions
    if memories:
        rewards["memories"] = memories
    if manual:
        rewards["manual_only"] = manual
    if value.strip():
        rewards["raw"] = value.strip()
    return rewards


def _quest_string_delta(sign: str, quality: str) -> int:
    magnitude = 2 if quality.lower() in {"strong", "deep", "severe"} else 1
    return magnitude if sign == "+" else -magnitude


def _parse_reward_count(text: str) -> int:
    match = re.search(r"(?:x|count\s*[:=]?\s*)(\d{1,2})\b", text, re.I)
    if not match:
        match = re.search(r"\b(\d{1,2})\s*(?:copies|items|pcs)\b", text, re.I)
    if not match:
        return 1
    count = int(match.group(1))
    return max(1, min(99, count))


def _parse_reward_status(rest: str, original_line: str) -> dict[str, Any] | None:
    mentions = _contract_mentions_in_text(rest)
    if not mentions:
        return None
    actor = mentions[0]
    lowered = rest.lower()
    kind = next((candidate for candidate in QUEST_STATUS_KINDS if candidate in lowered), None)
    if not kind:
        return None
    after_kind = re.split(rf"\b{re.escape(kind)}\b\s*[:=]?\s*", rest, maxsplit=1, flags=re.I)
    value = after_kind[1].strip() if len(after_kind) > 1 else kind
    value = re.sub(r"\bintensity\s*[:=]?\s*\d+(?:\.\d+)?\b", "", value, flags=re.I)
    value = re.sub(r"\s+", " ", value).strip(" .;-") or kind
    intensity_match = re.search(r"\bintensity\s*[:=]?\s*(0(?:\.\d+)?|1(?:\.0+)?)\b", rest, re.I)
    intensity = float(intensity_match.group(1)) if intensity_match else 0.5
    return {
        "actor": actor,
        "status_kind": kind,
        "status_value": value[:80],
        "intensity": max(0.0, min(1.0, intensity)),
        "reason": re.sub(r"\s+", " ", original_line).strip(),
    }


def _is_list_item(value: str) -> bool:
    return bool(re.match(r"^[-*â€¢]\s+", value))


def _strip_list_marker(value: str) -> str:
    return re.sub(r"^[-*â€¢]\s+", "", value.strip()).strip()


def _companion_rule_kind(label: str) -> str:
    lowered = label.lower()
    if "join" in lowered:
        return "join_condition"
    if "refusal" in lowered or "refuse" in lowered:
        return "refusal_condition"
    if "loyalty" in lowered or "pressure" in lowered:
        return "loyalty_pressure"
    if "depart" in lowered or "leave" in lowered:
        return "depart_condition"
    if "follow" in lowered:
        return "follow_style"
    if "inventory" in lowered:
        return "inventory_baseline"
    if "world" in lowered or "cartridge" in lowered or "travel" in lowered:
        return "new_world_reaction"
    return re.sub(r"[^a-z0-9]+", "_", lowered).strip("_") or "manual_only"


def _companion_portability(rules: list[dict[str, Any]]) -> str:
    for rule in rules:
        kind = str(rule.get("kind", ""))
        text = str(rule.get("text", "")).lower()
        if kind == "new_world_reaction" or "cartridge" in text:
            return "conditional_portable"
    return "world_bound"


def _contract_mentions_in_text(text: str) -> list[str]:
    out: list[str] = []
    for mention in mentions_in_text(text):
        cleaned = re.sub(r"(?i)'s\s+.*$", "", mention).strip()
        cleaned = re.split(
            r"(?i)\s+(?:in|at|with|while|when|if|without|before|after|from|for|and|or|but)\b",
            cleaned,
            maxsplit=1,
        )[0].strip()
        if cleaned and cleaned not in out:
            out.append(cleaned)
    return out


def first_mention(text: str) -> str | None:
    match = MENTION_PATTERN.search(text)
    return clean_mention(match.group(0)) if match else None


def normalize_heading(value: str) -> str:
    """Normalize an authored markdown section heading for alias lookup.

    Gamemasters-v2 documents headings as `## Identity — кто я`,
    `## First Entry Bubble — первый кадр`, etc. Writers naturally copy
    those visible headings into vault notes, so the parser must treat the
    explanatory suffix after a spaced dash as documentation chrome, not as
    part of the contract key. Hyphenated contract names such as
    `Cross-Hub Reach` stay intact because only spaced dash separators are
    stripped.
    """

    cleaned = re.sub(r"\s+", " ", value.strip().lower())
    return re.split(r"\s+[—–-]\s+", cleaned, maxsplit=1)[0].strip()


def normalize_coin(value: str) -> str:
    coin = clean_mention(value)
    return coin if coin.startswith("@") else f"@{coin}"


def coin_value(coin: str) -> int:
    lowered = coin.lower()
    if lowered == "@gold coin":
        return 100
    if lowered == "@silver coin":
        return 10
    return 1


def parse_quest_sections(
    note: NoteSections,
    *,
    all_mentions: dict[str, list[Entity]] | None = None,
    max_stages: int = 6,
    stage_goal_max_chars: int = 180,
) -> ParsedQuest:
    """Extract the structured quest view from a quest note.

    Stages are numbered ``stage-1`` … ``stage-N`` and capped at
    ``max_stages``. Each stage's ``goal`` is trimmed and length-capped
    (``stage_goal_max_chars``) to keep downstream payloads small.
    ``stage_mentions`` is the dedup'd set of ``@Name`` tokens that
    appeared in any stage line; ``materialized_slugs`` is the slug list
    derived from the optional ``## Materializes`` block. When no stages
    line is present the parser synthesises a single ``stage-1`` whose
    goal mirrors ``quest_objective`` (falling back to ``public_summary``)
    so quest consumers always have something deterministic to display.

    Pure helper: no filesystem reads, no mutation. Exported so OWV-12
    tests can pin its behaviour without exercising the whole compiler.
    """

    block = section(note, "quest_stages")
    logical_stages = _stage_blocks(block)

    stage_entries: list[QuestStage] = []
    stage_mention_order: list[str] = []
    for block_index, stage_block in enumerate(logical_stages):
        directive = _parse_next_stage_directive(stage_block)
        if directive is not None:
            if stage_entries:
                stage_entries[-1] = replace(stage_entries[-1], next_stage=directive)
            continue
        if len(stage_entries) >= max_stages:
            continue
        stage = _parse_stage_block(
            stage_block,
            index=len(stage_entries),
            stage_goal_max_chars=stage_goal_max_chars,
        )
        mentions = stage.mentions
        for mention in mentions:
            if mention not in stage_mention_order:
                stage_mention_order.append(mention)
        stage_entries.append(stage)

    stage_entries = _wire_linear_next_stages(stage_entries)

    objective = section(note, "quest_objective")
    if not stage_entries:
        # Last-resort fallback: pick the first populated section
        # (objective → hook → raw note text with H1 dropped). The
        # H1 strip stops the `# Title` line from leaking into the
        # generated goal for action-unlock notes that omit
        # `## Стадии`.
        hook = section(note, "quest_hook")
        raw_fallback = _strip_h1(note.entity.text)
        fallback_goal = short_text(
            first_non_empty(objective, hook, raw_fallback),
            stage_goal_max_chars,
        )
        if fallback_goal:
            stage_entries.append(
                QuestStage(
                    stage_slug="stage-1",
                    stage_id="stage-1",
                    goal=fallback_goal,
                    mentions=(),
                )
            )

    mat_slugs: list[str] = []
    if all_mentions is not None:
        for entry in parse_materializes(note, all_mentions):
            if entry.entity_slug and entry.entity_slug not in mat_slugs:
                mat_slugs.append(entry.entity_slug)

    return ParsedQuest(
        source_path=note.entity.path,
        source=section(note, "quest_source"),
        hook=section(note, "quest_hook"),
        objective=objective,
        rewards=section(note, "quest_rewards"),
        failure=section(note, "quest_failure"),
        stages=tuple(stage_entries),
        stage_mentions=tuple(stage_mention_order),
        materialized_slugs=tuple(mat_slugs),
    )


def _merge_stage_lines(block: str) -> list[str]:
    """Convert a `## Стадии` block into a list of logical stage goals.

    Each line that starts with a stage marker (numeric or bullet)
    opens a new stage. Lines without a marker — typically the
    indented continuation Russian writers use to wrap a long stage
    onto a second line — fold into the active stage. A blank line is
    skipped but does *not* break the active stage so multi-paragraph
    stages collapse into one goal.

    Pre-OWV-12-hardening behaviour stripped digits + dashes off every
    line and emitted each as its own stage, so a wrap like
    ``1. Goal text…\\n   tail`` became two fake stages (`Goal text…`
    and `tail`). This helper closes that bug.
    """

    return [re.sub(r"\s+", " ", block).strip() for block in _stage_blocks(block)]


def _stage_blocks(block: str) -> list[str]:
    """Split a `## Stages` block into top-level stage blocks.

    Nested markdown list rows such as `   - kind: choice` belong to the
    current stage/directive. Only top-level list markers open a new
    block. This keeps the `Gamemasters-v2` `next_stage:` examples from
    being split into fake stages.
    """

    if not block:
        return []
    stages: list[list[str]] = []
    for raw_line in block.splitlines():
        if not raw_line.strip():
            continue
        marker = STAGE_MARKER_RE.match(raw_line)
        if marker:
            stages.append([raw_line[marker.end():].strip()])
            continue
        text = raw_line.strip()
        if not text:
            continue
        if stages:
            stages[-1].append(text)
        else:
            stages.append([text])
    return ["\n".join(lines).strip() for lines in stages if any(line.strip() for line in lines)]


def _parse_stage_block(
    block: str,
    *,
    index: int,
    stage_goal_max_chars: int,
) -> QuestStage:
    fields: dict[str, str] = {}
    body_lines: list[str] = []
    known_stage_fields = {
        "id",
        "stage_id",
        "stage",
        "turns_remaining",
        "timeout_action",
        "timeout_target",
        "advance_on",
    }
    for raw_line in block.splitlines():
        parsed = _parse_stage_field(raw_line)
        if parsed and parsed[0] in known_stage_fields:
            key, value = parsed
            fields[key] = value
            continue
        body_lines.append(raw_line.strip())

    stage_id = fields.get("id") or fields.get("stage_id") or fields.get("stage")
    goal_lines = [line for line in body_lines if line]
    if goal_lines:
        explicit = STAGE_ID_PREFIX_RE.match(goal_lines[0])
        if explicit:
            stage_id = stage_id or explicit.group("id")
            goal_lines[0] = explicit.group("goal").strip()

    stage_id = _safe_stage_id(stage_id, index)
    goal = short_text(" ".join(goal_lines).strip(), stage_goal_max_chars)
    mentions = tuple(mentions_in_text(block))
    turns_remaining = _parse_int(fields.get("turns_remaining"))
    timeout_action = fields.get("timeout_action")
    timeout_target = fields.get("timeout_target")
    on_timeout: dict[str, Any] | None = None
    if timeout_action:
        action = timeout_action.strip()
        if action == "advance_to" and timeout_target:
            on_timeout = {"action": "advance_to", "target_stage_id": timeout_target.strip()}
        elif action:
            on_timeout = {"action": action}
    return QuestStage(
        stage_slug=stage_id,
        stage_id=stage_id,
        goal=goal,
        mentions=mentions,
        prerequisites=tuple(),
        turns_remaining=turns_remaining,
        on_timeout=on_timeout,
        advance_on=fields.get("advance_on"),
    )


def _parse_next_stage_directive(block: str) -> str | dict[str, Any] | None:
    lines = [line.strip() for line in block.splitlines() if line.strip()]
    if not lines:
        return None
    first = _parse_stage_field(lines[0])
    if not first or first[0] != "next_stage":
        return None
    if first[1]:
        return first[1]
    if not any(_parse_stage_field(line) == ("kind", "choice") for line in lines[1:]):
        return None

    options: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    current_prereq: dict[str, Any] | None = None
    in_prerequisites = False
    for line in lines[1:]:
        parsed = _parse_stage_field(line)
        if not parsed:
            continue
        key, value = parsed
        if key == "target_stage_id":
            if current is not None:
                if current_prereq:
                    current.setdefault("prerequisites", []).append(current_prereq)
                options.append(current)
            current = {"target_stage_id": value}
            current_prereq = None
            in_prerequisites = False
            continue
        if current is None:
            continue
        if key == "label":
            current["label"] = value
        elif key == "prerequisites":
            in_prerequisites = True
            current_prereq = None
        elif in_prerequisites and key == "type":
            if current_prereq:
                current.setdefault("prerequisites", []).append(current_prereq)
            current_prereq = {"type": value}
        elif in_prerequisites and current_prereq is not None:
            current_prereq[key] = _parse_scalar(value)
    if current is not None:
        if current_prereq:
            current.setdefault("prerequisites", []).append(current_prereq)
        options.append(current)

    return {"kind": "choice", "options": options}


def _parse_stage_field(line: str) -> tuple[str, str] | None:
    match = STAGE_FIELD_RE.match(line)
    if not match:
        return None
    return match.group("key").strip().lower().replace("-", "_"), match.group("value").strip()


def _parse_scalar(value: str) -> Any:
    as_int = _parse_int(value)
    if as_int is not None:
        return as_int
    lowered = value.strip().lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    return value


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value.strip())
    except ValueError:
        return None


def _safe_stage_id(value: str | None, index: int) -> str:
    if value:
        raw = value.strip().lower()
        raw = re.sub(r"[^a-z0-9_-]+", "-", raw).strip("-_")
        if raw and re.match(r"^[a-z][a-z0-9_-]*$", raw):
            return raw[:80]
    return f"stage-{index + 1}"


def _wire_linear_next_stages(stages: list[QuestStage]) -> list[QuestStage]:
    wired: list[QuestStage] = []
    for index, stage in enumerate(stages):
        if stage.next_stage is None and index + 1 < len(stages):
            wired.append(replace(stage, next_stage=stages[index + 1].stage_id))
        else:
            wired.append(stage)
    return wired


def _strip_h1(text: str) -> str:
    """Drop a leading markdown H1 line from raw note text.

    Operates on raw multiline note text so the parser's last-resort
    fallback never leaks the ``# Title`` line into a quest's
    ``objective`` / ``stages[].goal``. The H1 is identified by a line
    that matches ``^\\s*#\\s+...`` (one ``#`` plus whitespace plus
    content); ``##``/``###`` section headers are left untouched.
    """

    if not text:
        return text
    lines = text.splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and re.match(r"^\s*#\s+", lines[0]):
        lines.pop(0)
    return "\n".join(lines).lstrip()


def duplicate_slugs(entities: Iterable[Entity]) -> dict[str, list[Entity]]:
    """Return entities that share the same slug.

    The slug collision check complements ``duplicate_mentions`` from
    ``vault_scan``: two writer-authored notes whose ``display_name``
    differs only by punctuation or whitespace (`@Mikka_x` vs
    `@Mikka-x`) collapse onto the same slug, which would later silently
    overwrite each other in the Forge ``records_by_slug`` map. The
    compiler raises on this before writing anything.
    """

    buckets: dict[str, list[Entity]] = {}
    for entity in entities:
        if not entity.slug:
            continue
        buckets.setdefault(entity.slug, []).append(entity)
    return {slug: group for slug, group in buckets.items() if len(group) > 1}


def duplicate_display_names(entities: Iterable[Entity]) -> dict[str, list[Entity]]:
    """Return entities that share the same canonical ``display`` value.

    Mirrors ``duplicate_mentions`` but keys by raw ``display`` instead of
    the ``@Display`` mention. The two checks usually overlap, but a
    location named ``Mikka`` and a person named ``Mikka`` collide on
    display_name without sharing a mention namespace — both still trip
    the compiler.
    """

    buckets: dict[str, list[Entity]] = {}
    for entity in entities:
        display = entity.display.strip()
        if not display:
            continue
        buckets.setdefault(display, []).append(entity)
    return {name: group for name, group in buckets.items() if len(group) > 1}


def load_notes(vault: Path | None = None) -> list[NoteSections]:
    root = vault or default_vault_root(__file__)
    return [note_sections(entity) for entity in scan_vault(root)]


def all_mentions(notes: Iterable[NoteSections]) -> dict[str, list[Entity]]:
    return mention_index(note.entity for note in notes)
