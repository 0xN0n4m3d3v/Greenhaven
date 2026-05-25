from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Iterable


MENTION_PATTERN = re.compile(r"@[A-Za-z0-9][A-Za-z0-9' -]*[A-Za-z0-9]")
SECTION_PATTERN = re.compile(r"(?m)^##\s+(.+?)\s*$")
MATERIALIZES_HEADINGS = {"materializes"}
MATERIALIZES_FIELD_PATTERN = re.compile(r"^\s*(?:-\s*)?(Entity|Type)\s*:\s*(.+?)\s*$", re.I)
DEFAULT_WORLD_DIR = "GreenHavenWorld"


@dataclass(frozen=True)
class Entity:
    display: str
    mention: str
    kind: str
    slug: str
    path: str
    abs_path: Path
    owner: str | None
    parent: str | None
    relation: str | None
    text: str
    parts: tuple[str, ...]


def default_vault_root(script_file: str | Path) -> Path:
    return Path(script_file).resolve().parents[4]


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _safe_world_dir(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip().strip("`").strip().replace("\\", "/").rstrip("/")
    if not cleaned or cleaned.startswith("/") or ":" in cleaned:
        return None
    if cleaned == ".." or cleaned.startswith("../") or "/../" in cleaned:
        return None
    if "/" in cleaned:
        return None
    return cleaned


def active_world_dir(vault_root: Path, override: str | None = None) -> str:
    explicit = _safe_world_dir(override)
    if explicit:
        return explicit
    manifest = vault_root / "WORLD_MANIFEST.md"
    if manifest.is_file():
        text = read_text(manifest)
        matches = list(SECTION_PATTERN.finditer(text))
        for index, match in enumerate(matches):
            heading = match.group(1).strip().lower()
            if heading != "active world root":
                continue
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            block = text[match.end() : end]
            code = re.search(r"```(?:text|md|markdown)?\s*(.+?)\s*```", block, re.S)
            candidates = [code.group(1) if code else block]
            candidates.extend(block.splitlines())
            for candidate in candidates:
                cleaned = _safe_world_dir(candidate)
                if cleaned and (vault_root / cleaned).is_dir():
                    return cleaned
    if (vault_root / DEFAULT_WORLD_DIR).is_dir():
        return DEFAULT_WORLD_DIR
    content_roots = [
        child.name
        for child in vault_root.iterdir()
        if child.is_dir()
        and not child.name.startswith(".")
        and (child / "Locations").is_dir()
    ]
    if len(content_roots) == 1:
        return content_roots[0]
    return DEFAULT_WORLD_DIR


def get_slug(name: str) -> str:
    value = name.strip()
    if value.startswith("@"):
        value = value[1:]
    value = value.lower().replace("'", "")
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value or "unnamed"


def get_entity_kind(relative_path: str) -> str:
    normalized = relative_path.replace("\\", "/")
    if re.search(r"/quests/[^/]+\.md$", normalized):
        return "quest"
    if re.search(r"/scenes/@[^/]+\.md$", normalized):
        return "scene"
    if re.search(r"/scenes/@[^/]+/", normalized):
        return "scene"
    if re.search(r"/npc/@[^/]+/[^/]+Mind\.md$", normalized):
        return "person"
    if re.search(r"/items/@[^/]+/[^/]+Mind\.md$", normalized):
        return "item"
    if re.search(r"/Locations/.+Mind\.md$", normalized):
        return "location"
    return "note"


def get_at_folder_after(parts: tuple[str, ...], segment: str) -> str | None:
    for index, part in enumerate(parts[:-1]):
        if part == segment and parts[index + 1].startswith("@"):
            return parts[index + 1]
    return None


def get_at_folder_before(parts: tuple[str, ...], segment: str) -> str | None:
    for index, part in enumerate(parts):
        if part != segment:
            continue
        for back in range(index - 1, -1, -1):
            if parts[back].startswith("@"):
                return parts[back]
    return None


def get_owner_npc(parts: tuple[str, ...]) -> str | None:
    return get_at_folder_after(parts, "npc")


def get_scene_title(parts: tuple[str, ...], fallback_file_name: str, heading: str | None) -> str:
    for index, part in enumerate(parts[:-1]):
        if part != "scenes":
            continue
        candidate = parts[index + 1]
        if candidate.endswith(".md"):
            return Path(candidate).stem
        if candidate.startswith("@"):
            return candidate
    if heading:
        return heading
    return Path(fallback_file_name).stem


def get_structural_parent(kind: str, parts: tuple[str, ...]) -> tuple[str, str] | None:
    if kind == "quest":
        parent = get_at_folder_before(parts, "quests")
        return (parent, "quest_source") if parent else None
    if kind == "scene":
        parent = get_at_folder_before(parts, "scenes")
        if not parent:
            return None
        relation = "npc_scene" if get_owner_npc(parts) else "location_scene"
        return parent, relation
    if kind == "person":
        parent = get_at_folder_before(parts, "npc")
        return (parent, "contains_npc") if parent else None
    if kind == "item":
        parent = get_at_folder_before(parts, "items")
        return (parent, "contains_item") if parent else None
    return None


def first_heading(text: str) -> str | None:
    match = re.search(r"(?m)^#\s+(.+?)\s*$", text)
    return match.group(1).strip() if match else None


def scan_vault(vault_root: Path, world_dir: str | None = None) -> list[Entity]:
    vault = vault_root.resolve()
    active_dir = active_world_dir(vault, world_dir)
    world_root = vault / active_dir
    if not world_root.is_dir():
        raise FileNotFoundError(f"Missing active world root {active_dir} under {vault}")

    entities: list[Entity] = []
    for note in sorted(world_root.rglob("*.md")):
        relative = note.relative_to(vault).as_posix()
        parts = tuple(relative.split("/"))
        entity_folder = next((part for part in reversed(parts) if part.startswith("@")), None)
        text = read_text(note)
        kind = get_entity_kind(relative)
        heading = first_heading(text)

        if kind == "quest":
            title = heading or note.stem
        elif kind == "scene":
            title = get_scene_title(parts, note.name, heading)
        else:
            if heading and heading.startswith("@"):
                title = heading
            elif entity_folder:
                title = entity_folder
            elif heading:
                title = heading
            else:
                title = note.stem

        display = title[1:] if title.startswith("@") else title
        owner = get_owner_npc(parts)
        owner_display = owner[1:] if owner and owner.startswith("@") else owner
        if kind not in {"scene", "quest"}:
            owner_display = None

        structural = get_structural_parent(kind, parts)
        parent_display: str | None = None
        relation: str | None = None
        if structural:
            parent, relation = structural
            parent_display = parent[1:] if parent.startswith("@") else parent

        entities.append(
            Entity(
                display=display,
                mention=f"@{display}",
                kind=kind,
                slug=get_slug(display),
                path=relative,
                abs_path=note,
                owner=owner_display,
                parent=parent_display,
                relation=relation,
                text=text,
                parts=parts,
            )
        )
    return entities


def mention_index(entities: Iterable[Entity]) -> dict[str, list[Entity]]:
    index: dict[str, list[Entity]] = {}
    for entity in entities:
        index.setdefault(entity.mention, []).append(entity)
    return index


def clean_mention(raw: str) -> str:
    mention = raw.strip().rstrip(".,;:)")
    # Price lists often read "@Red ledger - 2 @Gold coin"; the generic mention
    # scanner allows hyphens inside names, so trim a trailing numeric price.
    return re.sub(r"\s+-\s+\d+$", "", mention)


def heading_ranges(text: str, heading_names: set[str]) -> list[tuple[int, int]]:
    matches = list(SECTION_PATTERN.finditer(text))
    ranges: list[tuple[int, int]] = []
    for index, match in enumerate(matches):
        heading = match.group(1).strip().lower()
        if heading not in heading_names:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        ranges.append((match.end(), end))
    return ranges


def in_ranges(position: int, ranges: Iterable[tuple[int, int]]) -> bool:
    return any(start <= position < end for start, end in ranges)


def prose_edges(entities: Iterable[Entity]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    items = list(entities)
    mentions = mention_index(items)
    edges: list[dict[str, str]] = []
    unresolved: list[dict[str, str]] = []
    for entity in items:
        materializes_ranges = heading_ranges(entity.text, MATERIALIZES_HEADINGS)
        for match in MENTION_PATTERN.finditer(entity.text):
            if in_ranges(match.start(), materializes_ranges):
                continue
            mention = clean_mention(match.group(0))
            if mention == entity.mention:
                continue
            if mention in mentions:
                edges.append({"from": entity.mention, "to": mention, "source": entity.path})
            else:
                unresolved.append({"mention": mention, "source": entity.path})
    return edges, unresolved


def materialization_edges(entities: Iterable[Entity]) -> list[dict[str, str]]:
    items = list(entities)
    mentions = mention_index(items)
    edges: list[dict[str, str]] = []
    for entity in items:
        for start, end in heading_ranges(entity.text, MATERIALIZES_HEADINGS):
            block = entity.text[start:end]
            current: dict[str, str] | None = None
            for line in block.splitlines():
                field = MATERIALIZES_FIELD_PATTERN.match(line)
                if not field:
                    continue
                key = field.group(1).lower()
                value = field.group(2).strip()
                if key == "entity":
                    match = MENTION_PATTERN.search(value)
                    if not match:
                        current = None
                        continue
                    mention = clean_mention(match.group(0))
                    if mention == entity.mention:
                        current = None
                        continue
                    status = "existing" if mention in mentions else "new"
                    current = {
                        "from": entity.mention,
                        "to": mention,
                        "source": entity.path,
                        "kind": "unknown",
                        "target_status": status,
                    }
                    edges.append(current)
                elif key == "type" and current is not None:
                    current["kind"] = value or "unknown"
    return edges


def structure_edges(entities: Iterable[Entity]) -> list[dict[str, str]]:
    edges: list[dict[str, str]] = []
    for entity in entities:
        if not entity.parent or not entity.relation:
            continue
        edges.append(
            {
                "from": f"@{entity.parent}",
                "to": entity.mention,
                "relation": entity.relation,
                "source": entity.path,
            }
        )
    return edges


def duplicate_mentions(entities: Iterable[Entity]) -> dict[str, list[Entity]]:
    duplicates: dict[str, list[Entity]] = {}
    for mention, group in mention_index(entities).items():
        if len(group) > 1:
            duplicates[mention] = group
    return duplicates
