"""
Build the Greenhaven Gamemasters guide as a static section of the site.

What it does:
  1. Resizes every image from ../../GreenhavenWorld/Gamemasters-v2/img via ImageMagick
     (max 1200px on the long side, quality 82, stripped metadata) and
     drops them into ./img/ as .jpg with slugified names.
  2. Walks every .md file in ../../GreenhavenWorld/Gamemasters-v2, renders it to HTML
     using python-markdown, rewrites Obsidian wikilinks and internal
     .md links to the slugified paths inside this folder.
  3. Wraps the rendered HTML in a unified site-styled chapter template
     with a left sidebar and prev/next footer navigation.

Run from anywhere:
    python "C:/Greenhaven/landing/greenhaven/gamemasters/build.py"
"""

from __future__ import annotations

import html
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

import markdown as md_lib

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
VAULT = REPO_ROOT / "GreenhavenWorld" / "Gamemasters-v2"
IMG_SRC = VAULT / "img"
IMG_DST = HERE / "img"
SITE_ROOT_REL_FROM_CHAPTER = "../../"  # for back-to-site link from a chapter

import datetime as _dt
BUILD_VER = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")

# ---------------------------------------------------------------------------
# Chapter ordering and metadata.
# ---------------------------------------------------------------------------


@dataclass
class Chapter:
    src: Path  # source .md path under VAULT
    out: Path  # output .html path under HERE
    section_id: str  # "00-welcome" / "01-getting-started" / ...
    section_label: str
    title: str  # human title for the chapter
    nav_title: str  # short title for the sidebar


def slug(text: str) -> str:
    s = text.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s


SECTIONS = [
    ("00-welcome", "Welcome", [("Welcome.md", "Welcome", "Welcome")]),
    (
        "01-getting-started",
        "Getting started",
        [
            ("01-getting-started/What is a cartridge.md",
             "What is a cartridge", "What is a cartridge"),
            ("01-getting-started/Creating the vault.md",
             "Creating the vault", "Creating the vault"),
            ("01-getting-started/Your first location.md",
             "Your first location", "Your first location"),
            ("01-getting-started/Your first NPC.md",
             "Your first NPC", "Your first NPC"),
            ("01-getting-started/Your first quest.md",
             "Your first quest", "Your first quest"),
        ],
    ),
    (
        "02-reference",
        "Reference",
        [
            ("02-reference/NPC reference.md", "NPC reference", "NPC"),
            ("02-reference/Quest reference.md", "Quest reference", "Quest"),
            ("02-reference/Scene reference.md", "Scene reference", "Scene"),
            ("02-reference/Location reference.md", "Location reference", "Location"),
            ("02-reference/Item reference.md", "Item reference", "Item"),
        ],
    ),
    (
        "03-mechanics",
        "Mechanics",
        [
            ("03-mechanics/Materializes.md",
             "Materializes: how the world responds", "Materializes"),
            ("03-mechanics/Quest branching.md",
             "Quest branching: real choices", "Quest branching"),
            ("03-mechanics/Scenes in depth.md",
             "Scenes in depth: rhythm and impact", "Scenes in depth"),
            ("03-mechanics/Companions.md",
             "Companions: those who walk beside you", "Companions"),
            ("03-mechanics/Economy.md",
             "Economy: money as character", "Economy"),
            ("03-mechanics/Images.md",
             "Images: how the world shows itself", "Images"),
            ("03-mechanics/Media.md",
             "Media: music, boot screens, and chat cards", "Media"),
        ],
    ),
]


def build_chapter_list() -> list[Chapter]:
    chapters: list[Chapter] = []
    for section_id, section_label, files in SECTIONS:
        for rel_md, title, nav_title in files:
            src = VAULT / rel_md
            if section_id == "00-welcome":
                out = HERE / "index.html"
            else:
                out = HERE / section_id / f"{slug(nav_title)}.html"
            chapters.append(Chapter(
                src=src, out=out,
                section_id=section_id, section_label=section_label,
                title=title, nav_title=nav_title,
            ))
    return chapters


# ---------------------------------------------------------------------------
# Image conversion.
# ---------------------------------------------------------------------------


def image_slug(name: str) -> str:
    stem = Path(name).stem
    return slug(stem) + ".jpg"


def build_image_map() -> dict[str, str]:
    """Map: original filename (as it appears in markdown ![[...]]) -> sanitized .jpg name."""
    mapping = {}
    for p in IMG_SRC.iterdir():
        if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
            mapping[p.name] = image_slug(p.name)
    return mapping


def convert_images(image_map: dict[str, str]) -> None:
    IMG_DST.mkdir(parents=True, exist_ok=True)
    for original, dest_name in image_map.items():
        src = IMG_SRC / original
        dst = IMG_DST / dest_name
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        print(f"  image: {original}  ->  {dest_name}")
        # IM7 magick: input -resize 1200x1200> -quality 82 -strip -interlace JPEG output
        subprocess.run(
            [
                "magick",
                str(src),
                "-auto-orient",
                "-resize", "1200x1200>",
                "-quality", "82",
                "-strip",
                "-interlace", "JPEG",
                "-colorspace", "sRGB",
                str(dst),
            ],
            check=True,
        )


# ---------------------------------------------------------------------------
# Markdown rendering with Obsidian-style link/image rewrites.
# ---------------------------------------------------------------------------


WIKILINK_IMAGE_RE = re.compile(r"!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]")
# A non-image wikilink is unused in the vault, but handle defensively.
WIKILINK_TEXT_RE = re.compile(r"(?<!\!)\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]")


def preprocess_obsidian(
    md_text: str, image_map: dict[str, str], img_prefix: str = "img/"
) -> str:
    def img_sub(m: re.Match[str]) -> str:
        target = m.group(1).strip()
        sanitized = image_map.get(target)
        if not sanitized:
            # try by basename
            for k, v in image_map.items():
                if k == target or Path(k).name == target:
                    sanitized = v
                    break
        if not sanitized:
            return m.group(0)  # leave untouched
        return f"![]({img_prefix}{sanitized})"

    def text_sub(m: re.Match[str]) -> str:
        target = m.group(1).strip()
        label = (m.group(2) or target).strip()
        return f"[{label}]({target})"

    md_text = WIKILINK_IMAGE_RE.sub(img_sub, md_text)
    md_text = WIKILINK_TEXT_RE.sub(text_sub, md_text)
    return md_text


def make_chapter_url_map(chapters: list[Chapter]) -> dict[str, Path]:
    """Map vault-relative .md path -> output .html path."""
    m: dict[str, Path] = {}
    for ch in chapters:
        rel = ch.src.relative_to(VAULT).as_posix()
        m[rel] = ch.out
    return m


HREF_MD_RE = re.compile(r'href="([^"]+?\.md(?:#[^"]*)?)"')


def rewrite_internal_links(
    html_body: str,
    current_out: Path,
    chapter_url_map: dict[str, Path],
) -> str:
    """Operate on the rendered HTML: rewrite every href="X.md" to the
    correct relative href that points to the produced .html."""
    # invert the source map once per call
    out_to_src = {v: k for k, v in chapter_url_map.items()}
    current_md_rel = out_to_src.get(current_out)
    if current_md_rel is None:
        return html_body
    current_dir = Path(current_md_rel).parent.as_posix()

    def repl(m: re.Match[str]) -> str:
        raw = unquote(m.group(1))
        if raw.startswith(("http://", "https://", "mailto:", "/")):
            return m.group(0)
        if "#" in raw:
            base, anchor = raw.split("#", 1)
            anchor = "#" + anchor
        else:
            base, anchor = raw, ""
        if not base.endswith(".md"):
            return m.group(0)
        resolved = base if current_dir == "" else f"{current_dir}/{base}"
        parts: list[str] = []
        for seg in resolved.split("/"):
            if seg == "..":
                if parts:
                    parts.pop()
            elif seg in ("", "."):
                continue
            else:
                parts.append(seg)
        resolved = "/".join(parts)
        target_out = chapter_url_map.get(resolved)
        if target_out is None:
            return m.group(0)
        return f'href="{relpath(current_out, target_out)}{anchor}"'

    return HREF_MD_RE.sub(repl, html_body)


def render_markdown(md_text: str) -> str:
    return md_lib.markdown(
        md_text,
        extensions=["extra", "tables", "fenced_code", "sane_lists", "toc"],
        output_format="html5",
    )


# ---------------------------------------------------------------------------
# HTML template.
# ---------------------------------------------------------------------------


def sidebar_html(chapters: list[Chapter], current: Chapter) -> str:
    # Group by section, preserve order.
    seen_sections: list[tuple[str, str]] = []
    groups: dict[str, list[Chapter]] = {}
    for ch in chapters:
        if (ch.section_id, ch.section_label) not in seen_sections:
            seen_sections.append((ch.section_id, ch.section_label))
            groups[ch.section_id] = []
        groups[ch.section_id].append(ch)

    out_parts: list[str] = []
    for sid, label in seen_sections:
        out_parts.append(f'<div class="toc-group">')
        out_parts.append(
            f'<p class="toc-label">{html.escape(label)}</p>'
        )
        out_parts.append('<ul>')
        for ch in groups[sid]:
            href = relpath(current.out, ch.out)
            active = ' class="active"' if ch.out == current.out else ""
            out_parts.append(
                f'<li><a{active} href="{href}">{html.escape(ch.nav_title)}</a></li>'
            )
        out_parts.append("</ul>")
        out_parts.append("</div>")
    return "\n".join(out_parts)


def relpath(from_file: Path, to_file: Path) -> str:
    """Web-style relative path from one file to another, both under HERE."""
    from_dir = from_file.parent.relative_to(HERE)
    to_rel = to_file.relative_to(HERE)
    rel = Path("/".join([".."] * len(from_dir.parts) or ["."])) / to_rel
    return rel.as_posix()


def prev_next_html(chapters: list[Chapter], current: Chapter) -> str:
    idx = next(i for i, c in enumerate(chapters) if c.out == current.out)
    prev_ch = chapters[idx - 1] if idx > 0 else None
    next_ch = chapters[idx + 1] if idx + 1 < len(chapters) else None
    parts: list[str] = ['<nav class="chapter-pager" aria-label="Chapter navigation">']
    if prev_ch:
        parts.append(
            f'<a class="pager-prev" href="{relpath(current.out, prev_ch.out)}">'
            f'<span class="pager-eyebrow">Previous</span>'
            f'<span class="pager-title">{html.escape(prev_ch.nav_title)}</span>'
            f'</a>'
        )
    else:
        parts.append('<span></span>')
    if next_ch:
        parts.append(
            f'<a class="pager-next" href="{relpath(current.out, next_ch.out)}">'
            f'<span class="pager-eyebrow">Next</span>'
            f'<span class="pager-title">{html.escape(next_ch.nav_title)}</span>'
            f'</a>'
        )
    else:
        parts.append('<span></span>')
    parts.append("</nav>")
    return "\n".join(parts)


CHAPTER_TEMPLATE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title} — Greenhaven Gamemasters Guide</title>
    <meta name="description" content="{meta_desc}" />
    <link rel="icon" href="{site_root}assets/favicon.ico" sizes="any" />
    <link rel="icon" href="{site_root}assets/favicon-32.png" type="image/png" />
    <link rel="stylesheet" href="{site_root}styles.css?v={ver}" />
    <link rel="stylesheet" href="{guide_css}?v={ver}" />
  </head>
  <body class="gm-doc-body">
    <header class="gm-doc-header">
      <a class="brand" href="{site_root}index.html" aria-label="Greenhaven home">
        <img src="{site_root}assets/crest.png" alt="" />
        <span>Greenhaven</span>
      </a>
      <nav class="gm-doc-topnav">
        <a href="{site_root}index.html#gms">Back to site</a>
        <a href="{guide_index}">Guide home</a>
        <a class="nav-cta" href="https://www.patreon.com/cw/greenhavenquest" target="_blank" rel="noopener noreferrer">Patreon build</a>
      </nav>
      <button class="gm-toc-toggle" type="button" aria-expanded="false" aria-controls="gm-sidebar">Contents</button>
    </header>

    <div class="gm-doc-shell">
      <aside id="gm-sidebar" class="gm-sidebar" aria-label="Guide contents">
        <a class="gm-sidebar-title" href="{guide_index}">Gamemasters Guide</a>
        {sidebar}
      </aside>

      <main class="gm-doc-main" id="main">
        <article class="gm-doc-article">
          {eyebrow_html}
          {body}
          {pager}
        </article>
      </main>
    </div>

    <script>
      (function () {{
        var toggle = document.querySelector('.gm-toc-toggle');
        var sidebar = document.getElementById('gm-sidebar');
        if (!toggle || !sidebar) return;
        toggle.addEventListener('click', function () {{
          var open = sidebar.classList.toggle('open');
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        }});
      }})();
    </script>
  </body>
</html>
"""


def build() -> None:
    print("== Greenhaven Gamemasters Guide build ==")
    image_map = build_image_map()
    print(f"Found {len(image_map)} images. Converting via ImageMagick...")
    convert_images(image_map)

    chapters = build_chapter_list()
    chapter_url_map = make_chapter_url_map(chapters)
    print(f"Rendering {len(chapters)} chapters...")

    for ch in chapters:
        ch.out.parent.mkdir(parents=True, exist_ok=True)
        # depth = number of dir hops from HERE to the chapter file.
        depth = len(ch.out.relative_to(HERE).parts) - 1  # 0 for index.html, 1+ for nested
        # Path from this chapter back up to the guide root (HERE).
        guide_root = "../" * depth if depth else "./"
        # Path from this chapter back up to the SITE root (one above HERE).
        site_root = "../" * (depth + 1)
        guide_css = guide_root + "gamemasters.css"
        guide_index = (guide_root + "index.html") if depth else "index.html"
        # Images live in HERE/img/, so prefix must reach there from this chapter.
        img_prefix = guide_root + "img/"

        md_text = ch.src.read_text(encoding="utf-8")
        pre = preprocess_obsidian(md_text, image_map, img_prefix=img_prefix)
        html_body = render_markdown(pre)
        # rewrite .md links AFTER the markdown library converted them to <a href="...">
        html_body = rewrite_internal_links(html_body, ch.out, chapter_url_map)
        # Derive a short meta description from the first paragraph of the rendered HTML.
        m = re.search(r"<p>(.*?)</p>", html_body, flags=re.S)
        meta_desc = ""
        if m:
            meta_desc = re.sub(r"<[^>]+>", "", m.group(1))
            meta_desc = re.sub(r"\s+", " ", meta_desc).strip()
            if len(meta_desc) > 200:
                meta_desc = meta_desc[:197].rstrip() + "..."
        meta_desc = html.escape(meta_desc, quote=True)

        eyebrow_html = (
            f'<p class="eyebrow">{html.escape(ch.section_label)}</p>'
            if ch.section_id != "00-welcome"
            else ""
        )
        page = CHAPTER_TEMPLATE.format(
            title=html.escape(ch.title),
            meta_desc=meta_desc,
            site_root=site_root,
            guide_root=guide_root,
            guide_css=guide_css,
            guide_index=guide_index,
            ver=BUILD_VER,
            sidebar=sidebar_html(chapters, ch),
            eyebrow_html=eyebrow_html,
            body=html_body,
            pager=prev_next_html(chapters, ch),
        )
        ch.out.write_text(page, encoding="utf-8")
        print(f"  wrote: {ch.out.relative_to(HERE)}")

    print("Done.")


if __name__ == "__main__":
    try:
        build()
    except subprocess.CalledProcessError as e:
        print(f"ImageMagick failed: {e}", file=sys.stderr)
        sys.exit(2)
