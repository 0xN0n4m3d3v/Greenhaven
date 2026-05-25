from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime
from pathlib import Path
import sys

from generate_vault_images import asset_role, entity_root, target_for
from vault_scan import (
    active_world_dir,
    default_vault_root,
    duplicate_mentions,
    materialization_edges,
    prose_edges,
    scan_vault,
    structure_edges,
    write_text,
)
from vault_sections import parse_manifest
from vault_sections import note_sections as _note_sections
from vault_validation import validate_vault


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
VIDEO_EXTENSIONS = {".mp4", ".webm"}
AUDIO_EXTENSIONS = {".mp3", ".ogg", ".m4a", ".wav"}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS
MEDIA_DIR_NAMES = {"images", "portraits", "media", "music", "audio"}


def _canonical_target_for(entity, vault: Path) -> Path | None:
    """Return the existing authored card target, accepting video cards.

    The image planner still writes PNG by default, but cartridge authors
    may replace a card with a `.webm`/`.mp4` file of the same basename.
    Preview should treat that as the canonical card instead of warning
    that `default.png`/`establishing.png` is missing and the webm is
    unmapped.
    """

    target = target_for(entity, vault)
    if target is None:
        return None
    candidates = [target]
    candidates.extend(
        target.with_suffix(ext)
        for ext in sorted(MEDIA_EXTENSIONS)
        if ext != target.suffix.lower()
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return target


def _entity_media_files(vault: Path, entities: list) -> set[Path]:
    files: set[Path] = set()
    for entity in entities:
        root = entity_root(entity, vault)
        if not root.is_dir():
            continue
        canonical = _canonical_target_for(entity, vault)
        if canonical and canonical.is_file():
            files.add(canonical.resolve())
        direct_dirs = [
            root / name
            for name in ("images", "portraits", "media", "music", "audio")
            if (root / name).is_dir()
        ]
        scene_slug = entity.slug.replace("-", "_")
        for folder in direct_dirs:
            for child in folder.rglob("*"):
                if child.suffix.lower() not in MEDIA_EXTENSIONS or not child.is_file():
                    continue
                if canonical and child.resolve() == canonical.resolve():
                    continue
                if entity.kind == "scene":
                    stem = child.stem.lower().replace("-", "_")
                    if stem != scene_slug and not stem.startswith(f"{scene_slug}_"):
                        continue
                files.add(child.resolve())
    return files


def is_cartridge_boot_media(vault: Path, path: Path, world_dir: str) -> bool:
    try:
        rel = path.relative_to(vault).as_posix()
    except ValueError:
        return False
    return rel.startswith(f"{world_dir}/media/boot/") or rel.startswith("media/boot/")


def visual_asset_rows(
    vault: Path, entities: list, world_dir: str
) -> tuple[list[dict[str, object]], list[Path]]:
    rows: list[dict[str, object]] = []
    expected: set[Path] = set()
    for entity in entities:
        target = _canonical_target_for(entity, vault)
        if target is None:
            continue
        expected.add(target.resolve())
        rows.append(
            {
                "mention": entity.mention,
                "kind": entity.kind,
                "role": asset_role(entity),
                "source": entity.path,
                "target": target.relative_to(vault).as_posix(),
                "exists": target.is_file(),
            }
        )

    world_root = vault / world_dir
    image_files = [
        path
        for path in world_root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in MEDIA_EXTENSIONS
        and any(part in MEDIA_DIR_NAMES for part in path.parts)
        and not is_cartridge_boot_media(vault, path, world_dir)
    ]
    expected |= _entity_media_files(vault, entities)
    unmapped = [path for path in image_files if path.resolve() not in expected]
    return rows, unmapped


def render_import_diff(
    vault: Path,
    world_dir: str | None = None,
) -> tuple[int, int, int, int, int, str, dict[str, int]]:
    active_dir = active_world_dir(vault, world_dir)
    entities = scan_vault(vault, active_dir)
    edges, unresolved = prose_edges(entities)
    structural_edges = structure_edges(entities)
    materialized_edges = materialization_edges(entities)
    duplicates = duplicate_mentions(entities)
    visual_rows, unmapped_visuals = visual_asset_rows(vault, entities, active_dir)
    manifest = parse_manifest(vault, entities)
    notes = [_note_sections(entity) for entity in entities]
    validation = validate_vault(
        vault=vault,
        entities=entities,
        notes=notes,
        manifest=manifest,
        unresolved=unresolved,
        duplicate_mention_groups=duplicates,
        visual_rows=visual_rows,
        unmapped_visuals=unmapped_visuals,
    )

    generated = vault / ".greenhaven-agent-manual" / "generated"
    lines: list[str] = [
        "# Greenhaven Vault Import Diff Preview",
        "",
        f"Generated: {datetime.now().isoformat(timespec='seconds')}",
        f"Vault: {vault}",
        "",
        "## Entity Candidates",
    ]

    by_kind: dict[str, list] = defaultdict(list)
    for entity in entities:
        by_kind[entity.kind].append(entity)

    for kind in sorted(by_kind):
        lines.extend(["", f"### {kind}"])
        for entity in sorted(by_kind[kind], key=lambda item: item.path):
            owner = f", owner=@{entity.owner}" if entity.owner else ""
            lines.append(
                f"- {entity.mention} -> kind={entity.kind}, slug={entity.slug}"
                f"{owner}, path=`{entity.path}`"
            )

    lines.extend(["", "## Duplicate Mentions"])
    if not duplicates:
        lines.append("- none")
    else:
        for mention in sorted(duplicates):
            paths = "; ".join(entity.path for entity in duplicates[mention])
            lines.append(f"- {mention}: {paths}")

    lines.extend(["", "## Structure-Derived Links"])
    if not structural_edges:
        lines.append("- none")
    else:
        for edge in sorted(
            structural_edges,
            key=lambda item: (item["from"], item["relation"], item["to"], item["source"]),
        ):
            lines.append(
                f"- {edge['from']} --{edge['relation']}--> {edge['to']} (`{edge['source']}`)"
            )

    lines.extend(["", "## Link Edges"])
    if not edges:
        lines.append("- none")
    else:
        for edge in sorted(edges, key=lambda item: (item["source"], item["from"], item["to"])):
            lines.append(f"- {edge['from']} -> {edge['to']} (`{edge['source']}`)")

    lines.extend(["", "## Materialization Candidates"])
    if not materialized_edges:
        lines.append("- none")
    else:
        for edge in sorted(
            materialized_edges,
            key=lambda item: (item["source"], item["from"], item["to"]),
        ):
            lines.append(
                f"- {edge['from']} materializes {edge['to']} "
                f"(kind={edge['kind']}, target={edge['target_status']}, source=`{edge['source']}`)"
            )

    lines.extend(["", "## Visual Asset Candidates"])
    if not visual_rows:
        lines.append("- none")
    else:
        for row in sorted(
            visual_rows,
            key=lambda item: (str(item["kind"]), str(item["source"]), str(item["target"])),
        ):
            status = "present" if row["exists"] else "missing"
            lines.append(
                f"- {row['mention']} -> role={row['role']}, status={status}, "
                f"target=`{row['target']}`, source=`{row['source']}`"
            )

    lines.extend(["", "## Unmapped Local Images"])
    if not unmapped_visuals:
        lines.append("- none")
    else:
        for path in sorted(unmapped_visuals, key=lambda item: item.as_posix()):
            lines.append(f"- `{path.relative_to(vault).as_posix()}`")

    unresolved_lines = ["# Unresolved Runtime Mentions", ""]
    if not unresolved:
        unresolved_lines.append("- none")
    else:
        seen = {
            (item["mention"], item["source"])
            for item in unresolved
        }
        for mention, source in sorted(seen):
            unresolved_lines.append(f"- {mention} in `{source}`")

    graph_lines = ["# World Graph Draft", "", "## Structure-Derived Links"]
    if not structural_edges:
        graph_lines.append("- no structure-derived edges yet")
    else:
        for edge in sorted(
            structural_edges,
            key=lambda item: (item["from"], item["relation"], item["to"], item["source"]),
        ):
            graph_lines.append(f"- {edge['from']} --{edge['relation']}--> {edge['to']}")

    graph_lines.extend(["", "## Prose Mention Links"])
    if not edges:
        graph_lines.append("- no resolved prose links yet")
    else:
        for edge in sorted(edges, key=lambda item: (item["from"], item["to"], item["source"])):
            graph_lines.append(f"- {edge['from']} -> {edge['to']}")

    graph_lines.extend(["", "## Materialization Links"])
    if not materialized_edges:
        graph_lines.append("- no materialization candidates yet")
    else:
        for edge in sorted(materialized_edges, key=lambda item: (item["from"], item["to"])):
            graph_lines.append(
                f"- {edge['from']} --materializes:{edge['kind']}:{edge['target_status']}--> "
                f"{edge['to']}"
            )

    write_text(generated / "import-diff.md", "\n".join(lines))
    write_text(generated / "unresolved-links.md", "\n".join(unresolved_lines))
    write_text(generated / "world-graph.draft.md", "\n".join(graph_lines))
    # OWV-4: surface the shared validation report so writers can see
    # findings (silent-fallback warnings, materializer create-candidates,
    # unresolved start location, etc.) before any Forge / SQL writes.
    write_text(generated / "validation.md", validation.render_markdown())
    write_text(generated / "validation.jsonl", validation.render_jsonl())
    missing_visuals = sum(1 for row in visual_rows if not row["exists"])
    return (
        len(entities),
        len(edges),
        len(structural_edges),
        missing_visuals,
        len(unmapped_visuals),
        str(generated),
        validation.counts(),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compile GreenhavenWorld vault preview artifacts.")
    parser.add_argument(
        "--vault-root",
        default=str(default_vault_root(__file__)),
        help="Path to GreenhavenWorld vault root.",
    )
    parser.add_argument(
        "--world-dir",
        default=None,
        help="Active world content directory under the vault root.",
    )
    args = parser.parse_args(argv)
    vault = Path(args.vault_root).resolve()
    (
        entities,
        edges,
        structural_edges,
        missing_visuals,
        unmapped_visuals,
        generated,
        validation_counts,
    ) = render_import_diff(vault, args.world_dir)
    unresolved_path = vault / ".greenhaven-agent-manual" / "generated" / "unresolved-links.md"
    unresolved_count = 0
    for line in unresolved_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("- ") and line != "- none":
            unresolved_count += 1
    print(f"ok               : True")
    print(f"entities         : {entities}")
    print(f"edges            : {edges}")
    print(f"structural_edges : {structural_edges}")
    print(f"unresolved       : {unresolved_count}")
    print(f"visual_missing   : {missing_visuals}")
    print(f"visual_unmapped  : {unmapped_visuals}")
    print(
        f"validation       : "
        f"{validation_counts['error']} error / "
        f"{validation_counts['warning']} warning / "
        f"{validation_counts['question']} question"
    )
    print(f"generated        : {generated}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
