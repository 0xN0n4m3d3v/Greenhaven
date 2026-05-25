from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

from vault_scan import Entity, default_vault_root, scan_vault, write_text


DEFAULT_MODEL = "gemini-3.1-flash-image-preview"
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GOOGLE_API_KEY_PATTERN = re.compile(r"AIza[0-9A-Za-z_-]{20,}")


def local_env_path(vault: Path) -> Path:
    return vault / ".greenhaven-agent-manual" / "local" / "gemini-image.env"


def generated_dir(vault: Path) -> Path:
    return vault / ".greenhaven-agent-manual" / "generated"


def read_local_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        clean = line.strip()
        if not clean or clean.startswith("#") or "=" not in clean:
            continue
        key, value = clean.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def redact_secrets(text: str) -> str:
    return GOOGLE_API_KEY_PATTERN.sub("[REDACTED_GOOGLE_API_KEY]", text)


def resolve_api_key(vault: Path, allow_prompt: bool) -> str:
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = os.environ.get(name)
        if value:
            return value
    local = read_local_env(local_env_path(vault))
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = local.get(name)
        if value:
            return value
    if not allow_prompt:
        raise RuntimeError(
            "Missing GEMINI_API_KEY/GOOGLE_API_KEY. Run `init` or set an environment variable."
        )
    value = getpass.getpass("Gemini API key for Nano Banana 2 image generation: ").strip()
    if not value:
        raise RuntimeError("No API key provided.")
    return value


def init_config(vault: Path, model: str) -> None:
    path = local_env_path(vault)
    path.parent.mkdir(parents=True, exist_ok=True)
    key = getpass.getpass("Gemini API key for Nano Banana 2 image generation: ").strip()
    if not key:
        raise RuntimeError("No API key provided.")
    text = (
        "# Local secret file. Do not commit.\n"
        f"GEMINI_API_KEY={key}\n"
        f"GEMINI_IMAGE_MODEL={model}\n"
    )
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote local image config: {path}")


def strip_at(name: str) -> str:
    return name[1:] if name.startswith("@") else name


def entity_root(entity: Entity, vault: Path) -> Path:
    path = entity.abs_path
    if entity.kind == "person":
        return path.parent
    if entity.kind == "item":
        return path.parent
    if entity.kind == "location":
        return path.parent
    if entity.kind == "scene":
        if "/npc/" in entity.path.replace("\\", "/"):
            return path.parent.parent
        return path.parent.parent
    return path.parent


def target_for(entity: Entity, vault: Path) -> Path | None:
    root = entity_root(entity, vault)
    if entity.kind == "person":
        return root / "portraits" / "default.png"
    if entity.kind == "item":
        return root / "images" / "icon.png"
    if entity.kind == "location":
        return root / "images" / "establishing.png"
    if entity.kind == "scene":
        return root / "images" / f"{entity.slug}.png"
    return None


def prompt_target_for(image_target: Path) -> Path:
    # Keep prompt sidecars out of the Obsidian Markdown scanner. The visible
    # vault treats every *.md under GreenHavenWorld as possible world source,
    # so generated prompt archives beside images must be plain text.
    return image_target.with_suffix(".prompt.txt")


def prompt_file_text(row: dict[str, object], model: str | None = None) -> str:
    lines = [
        f"# Image Prompt: {row['mention']}",
        "",
        f"- kind: `{row['kind']}`",
        f"- role: `{row['asset_role']}`",
        f"- source: `{row['source_path']}`",
        f"- output: `{row['output_path']}`",
        f"- aspect_ratio: `{row['aspect_ratio']}`",
    ]
    if model:
        lines.append(f"- model: `{model}`")
    lines.extend(
        [
            "",
            "## Prompt",
            "",
            str(row["prompt"]).strip(),
            "",
        ]
    )
    return "\n".join(lines)


def asset_role(entity: Entity) -> str:
    return {
        "person": "portrait",
        "item": "item_icon",
        "location": "location_view",
        "scene": "scene_plate",
    }.get(entity.kind, "generic_sticker")


def default_aspect_ratio(entity: Entity) -> str:
    # Cartridge UI currently treats all world art as card-like assets. Keep
    # locations and scene plates square like NPC portraits/items so thumbnails
    # are interchangeable and the validation target matches the operator's
    # current cartridge-art direction.
    return "1:1"


def kind_matches(entity: Entity, requested: str) -> bool:
    if requested == "all":
        return entity.kind in {"person", "item", "location", "scene"}
    return entity.kind == requested


SENSITIVE_SECTION_MARKERS = (
    "обнажен",
    "голая",
    "голый",
    "21+",
    "интим",
    "intim",
    "nude",
    "naked",
    "sexual appearance",
    "эрот",
)

LEGACY_MIXED_SECTION_MARKERS = (
    "анатомия и 21+",
    "anatomy and 21+",
)


def is_sensitive_heading(title: str) -> bool:
    normalized = title.strip().lower()
    return any(fragment in normalized for fragment in SENSITIVE_SECTION_MARKERS) or any(
        fragment in normalized for fragment in LEGACY_MIXED_SECTION_MARKERS
    )


def remove_sections(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    skip = False
    for line in lines:
        if line.startswith("## "):
            title = line[3:].strip().lower()
            skip = is_sensitive_heading(title)
        if not skip:
            out.append(line)
    return "\n".join(out)


def remove_sensitive_lines(text: str) -> str:
    out: list[str] = []
    for line in text.splitlines():
        normalized = line.strip().lower()
        if not normalized:
            out.append(line)
            continue
        if "общая анатомия" in normalized or "general anatomy" in normalized:
            out.append(line)
            continue
        if any(fragment in normalized for fragment in SENSITIVE_SECTION_MARKERS):
            continue
        out.append(line)
    return "\n".join(out)


def split_sections(text: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, list[str]]] = []
    current_title = ""
    current_lines: list[str] = []
    for line in text.splitlines():
        if line.startswith("## "):
            if current_lines:
                sections.append((current_title, current_lines))
            current_title = line[3:].strip()
            current_lines = [line]
        else:
            current_lines.append(line)
    if current_lines:
        sections.append((current_title, current_lines))
    return [(title, "\n".join(lines).strip()) for title, lines in sections]


def title_has(title: str, markers: tuple[str, ...]) -> bool:
    normalized = title.strip().lower()
    return any(marker in normalized for marker in markers)


def pack_sections(sections: list[str], max_chars: int) -> str:
    out: list[str] = []
    used = 0
    for section in sections:
        clean = section.strip()
        if not clean:
            continue
        separator = "\n\n" if out else ""
        remaining = max_chars - used - len(separator)
        if remaining <= 0:
            break
        if len(clean) > remaining:
            out.append(separator + clean[:remaining].rstrip())
            break
        out.append(separator + clean)
        used += len(separator) + len(clean)
    return "".join(out)


def person_excerpt(text: str, max_chars: int) -> str:
    sections = split_sections(text)
    priority: list[str] = []
    fallback: list[str] = []
    for title, body in sections:
        if title_has(
            title,
            (
                "внешность",
                "appearance",
                "общая анатомия",
                "general anatomy",
                "силуэт",
                "silhouette",
            ),
        ):
            priority.append(body)
        elif title_has(
            title,
            ("канон персонажа", "character canon", "инвентарь", "inventory"),
        ):
            fallback.append(body)
    if priority:
        return pack_sections(priority + fallback, max_chars)
    return text[:max_chars]


def note_excerpt(entity: Entity, max_chars: int = 1800) -> str:
    text = remove_sections(entity.text)
    text = remove_sensitive_lines(text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if entity.kind == "person":
        return person_excerpt(text, max_chars)
    return text[:max_chars]


def build_prompt(entity: Entity) -> str:
    name = entity.mention
    excerpt = note_excerpt(entity)
    shared_style = (
        "Greenhaven visual style: semi-realistic cinematic adventure fantasy, "
        "more realistic anatomy and materials than a cartoon but still "
        "illustrated, bright saturated color, juicy painterly lighting, warm "
        "heroic atmosphere, readable game asset, clear silhouettes, tactile "
        "materials, charming details, optimistic and mysterious rather than "
        "grim. Use the sample-style balance: realistic surfaces, fantasy "
        "color, dramatic camera, lively city energy. Avoid dark-fantasy gloom, "
        "horror palettes, muddy desaturation, gore, UI text, labels, "
        "watermarks, and modern stock-photo stiffness. Keep it non-explicit "
        "and suitable for normal game UI display."
    )
    if entity.kind == "person":
        brief = (
            f"Create a game-ready portrait/reference image for {name}. "
            "Show one adult fantasy character as a collectible hero/NPC card. "
            "Use tasteful mature adventure-fantasy costuming: bare arms, "
            "shoulders, midriff, or legs are allowed when they fit the character, "
            "but no nudity, no explicit anatomy focus, and no erotic posing. "
            "Readable silhouette, expressive face, hands visible where possible, "
            "confident adventure pose, colorful costume accents, no text, no UI, "
            "no watermark text. "
            "Use the non-explicit Appearance section when present, but ignore "
            "Sexual Appearance and do not depict nudity or erotic focus."
        )
    elif entity.kind == "item":
        brief = (
            f"Create a colorful game item card/icon for {name}. Center one "
            "object, readable silhouette, rich material highlights, subtle "
            "adventure-fantasy vignette background, no text, no UI."
        )
    elif entity.kind == "location":
        brief = (
            f"Create a semi-realistic cinematic establishing view for {name}. "
            "Readable fantasy RPG location, clear entrances, usable details, "
            "crowds or props that show how the place plays, colorful landmarks, "
            "strong depth, warm believable sunlight or lantern light, no text "
            "labels, no UI."
        )
    elif entity.kind == "scene":
        owner = f" owned by @{entity.owner}" if entity.owner else ""
        brief = (
            f"Create a cinematic adventure-fantasy scene plate for {name}{owner}. "
            "Show mood, staging, action hook, and pressure clearly; rich color, "
            "clear focal point, no text labels, no UI."
        )
    else:
        brief = f"Create a game-ready visual asset for {name}. No text, no UI."
    return (
        f"{brief}\n\n"
        f"{shared_style}\n\n"
        f"Source note:\n{excerpt}"
    )


def candidates(vault: Path, kind: str, include_existing: bool) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    for entity in scan_vault(vault):
        if not kind_matches(entity, kind):
            continue
        target = target_for(entity, vault)
        if target is None:
            continue
        exists = target.exists()
        if exists and not include_existing:
            continue
        out.append(
            {
                "mention": entity.mention,
                "kind": entity.kind,
                "asset_role": asset_role(entity),
                "source_path": entity.path,
                "output_path": target.relative_to(vault).as_posix(),
                "exists": exists,
                "aspect_ratio": default_aspect_ratio(entity),
                "prompt": build_prompt(entity),
                "entity": entity,
            }
        )
    return out


def write_plan(vault: Path, rows: list[dict[str, object]]) -> None:
    generated = generated_dir(vault)
    md: list[str] = [
        "# Greenhaven Image Generation Plan",
        "",
        "This is a dry review artifact. It contains no API key.",
        "",
    ]
    jsonl: list[str] = []
    for row in rows:
        md.extend(
            [
                f"## {row['mention']}",
                "",
                f"- kind: {row['kind']}",
                f"- role: {row['asset_role']}",
                f"- source: `{row['source_path']}`",
                f"- output: `{row['output_path']}`",
                f"- aspect_ratio: `{row['aspect_ratio']}`",
                f"- exists: `{str(row['exists']).lower()}`",
                "",
            ]
        )
        json_row = {key: value for key, value in row.items() if key != "entity"}
        jsonl.append(json.dumps(json_row, ensure_ascii=False))
    write_text(generated / "image-generation-plan.md", "\n".join(md))
    write_text(generated / "image-generation-plan.jsonl", "\n".join(jsonl))
    prompts_dir = generated / "image-prompts"
    for row in rows:
        source = str(row["source_path"]).replace("\\", "/")
        safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "-", source).strip("-")
        if not safe_name:
            safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(row["mention"])).strip("-")
        write_text(prompts_dir / f"{safe_name}.prompt.md", prompt_file_text(row))


def generate_image(
    api_key: str,
    model: str,
    prompt: str,
    aspect_ratio: str,
    image_size: str,
    timeout_seconds: int = 180,
    retries: int = 0,
) -> bytes:
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {
                "aspectRatio": aspect_ratio,
                "imageSize": image_size,
            },
        },
    }
    data = json.dumps(payload).encode("utf-8")
    attempts = max(1, retries + 1)
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(
            API_URL.format(model=model),
            data=data,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": api_key,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            # 5xx and 429 are retryable; 4xx (other) are not.
            if exc.code in {429, 500, 502, 503, 504} and attempt < attempts:
                last_error = RuntimeError(
                    f"HTTP {exc.code} (attempt {attempt}/{attempts}): "
                    f"{redact_secrets(error_body)[:300]}"
                )
                continue
            raise RuntimeError(
                f"Gemini image API failed: HTTP {exc.code}: "
                f"{redact_secrets(error_body)}"
            ) from exc
        except (TimeoutError, urllib.error.URLError) as exc:
            if attempt < attempts:
                last_error = RuntimeError(
                    f"transient transport error (attempt {attempt}/{attempts}): "
                    f"{redact_secrets(str(exc))[:300]}"
                )
                continue
            raise RuntimeError(
                f"Gemini image API failed after {attempts} attempt(s) at "
                f"timeout={timeout_seconds}s: {redact_secrets(str(exc))}"
            ) from exc
        parsed = json.loads(body)
        for candidate in parsed.get("candidates", []):
            content = candidate.get("content") or {}
            for part in content.get("parts", []):
                inline = part.get("inlineData") or part.get("inline_data")
                if inline and inline.get("data"):
                    return base64.b64decode(inline["data"])
        # Empty body is sometimes a transient quirk; retry while we have
        # budget, otherwise surface it as a permanent failure.
        if attempt < attempts:
            last_error = RuntimeError(
                f"empty inline image (attempt {attempt}/{attempts}): "
                f"{redact_secrets(body[:200])}"
            )
            continue
        raise RuntimeError(
            f"Gemini image API returned no inline image data: "
            f"{redact_secrets(body[:1000])}"
        )
    # Unreachable: the loop above either returns bytes or raises. The
    # final raise keeps the type checker happy if the loop exits.
    raise RuntimeError(
        f"Gemini image API exhausted attempts: "
        f"{last_error if last_error else 'unknown error'}"
    )


def run_plan(args: argparse.Namespace) -> int:
    vault = Path(args.vault_root).resolve()
    rows = candidates(vault, args.kind, args.include_existing)
    if args.limit is not None:
        rows = rows[: args.limit]
    write_plan(vault, rows)
    print(f"planned : {len(rows)}")
    print(f"output  : {generated_dir(vault) / 'image-generation-plan.md'}")
    return 0


def run_generate(args: argparse.Namespace) -> int:
    vault = Path(args.vault_root).resolve()
    rows = candidates(vault, args.kind, args.include_existing or args.overwrite)
    if args.limit is not None:
        rows = rows[: args.limit]
    write_plan(vault, rows)
    print(f"planned : {len(rows)}")
    if args.dry_run:
        print("dry_run : true")
        return 0
    api_key = resolve_api_key(vault, allow_prompt=not args.no_prompt)
    local = read_local_env(local_env_path(vault))
    model = args.model or os.environ.get("GEMINI_IMAGE_MODEL") or local.get("GEMINI_IMAGE_MODEL") or DEFAULT_MODEL
    written = 0
    failures: list[dict[str, str]] = []
    for row in rows:
        target = vault / str(row["output_path"])
        prompt_target = prompt_target_for(target)
        prompt_target.parent.mkdir(parents=True, exist_ok=True)
        prompt_target.write_text(
            prompt_file_text(row, model=model),
            encoding="utf-8",
            newline="\n",
        )
        if target.exists() and not args.overwrite:
            print(f"skip existing: {target}")
            continue
        entity_aspect = str(row["aspect_ratio"])
        try:
            image_bytes = generate_image(
                api_key=api_key,
                model=model,
                prompt=str(row["prompt"]),
                aspect_ratio=args.aspect_ratio or entity_aspect,
                image_size=args.image_size,
                timeout_seconds=args.timeout_seconds,
                retries=args.retries,
            )
        except RuntimeError as exc:
            redacted = redact_secrets(str(exc))
            failure = {
                "source_path": str(row["source_path"]),
                "output_path": str(row["output_path"]),
                "model": model,
                "timeout_seconds": str(args.timeout_seconds),
                "retries": str(args.retries),
                "error": redacted,
            }
            failures.append(failure)
            print(
                f"FAIL  : {row['mention']} kind={row['kind']} "
                f"target={target} model={model} timeout={args.timeout_seconds}s "
                f"retries={args.retries} error={redacted[:300]}"
            )
            if args.stop_on_failure:
                break
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(image_bytes)
        written += 1
        print(f"wrote: {target}")
    print(f"written : {written}")
    print(f"failed  : {len(failures)}")
    return 0 if not failures else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Plan or generate GreenhavenWorld images.")
    parser.add_argument(
        "--vault-root",
        default=str(default_vault_root(__file__)),
        help="Path to GreenhavenWorld vault root.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    init_parser = sub.add_parser("init", help="Prompt for a Gemini API key and save it locally.")
    init_parser.add_argument("--model", default=DEFAULT_MODEL)

    plan_parser = sub.add_parser("plan", help="Write image generation plan artifacts without API calls.")
    plan_parser.add_argument("--kind", choices=["all", "person", "item", "location", "scene"], default="all")
    plan_parser.add_argument("--limit", type=int)
    plan_parser.add_argument("--include-existing", action="store_true")

    generate_parser = sub.add_parser("generate", help="Generate images with Gemini Nano Banana 2.")
    generate_parser.add_argument("--kind", choices=["all", "person", "item", "location", "scene"], default="all")
    generate_parser.add_argument("--limit", type=int)
    generate_parser.add_argument("--include-existing", action="store_true")
    generate_parser.add_argument("--overwrite", action="store_true")
    generate_parser.add_argument("--dry-run", action="store_true")
    generate_parser.add_argument("--no-prompt", action="store_true")
    generate_parser.add_argument("--model")
    generate_parser.add_argument("--aspect-ratio")
    generate_parser.add_argument("--image-size", default="1K")
    generate_parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=180,
        help="Per-request HTTP timeout in seconds (default 180).",
    )
    generate_parser.add_argument(
        "--retries",
        type=int,
        default=0,
        help=(
            "Number of retries per asset on transient transport / "
            "5xx / empty-body responses (default 0)."
        ),
    )
    generate_parser.add_argument(
        "--stop-on-failure",
        action="store_true",
        help="Stop the run on the first asset failure instead of continuing.",
    )

    args = parser.parse_args(argv)
    vault = Path(args.vault_root).resolve()
    if args.command == "init":
        init_config(vault, args.model)
        return 0
    if args.command == "plan":
        return run_plan(args)
    if args.command == "generate":
        return run_generate(args)
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
