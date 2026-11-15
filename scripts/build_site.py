"""Assembles the public website: the landing page at the Pages root, the user guide under /guide/,
and redirect stubs at the guide's old addresses (issue #129).

The landing page (docs/landing) is served at the root, and MkDocs builds the guide into
``guide/`` so that both can share one Pages site. Released apps open the guide at
``/<page>/`` (``DOCS_URL`` used to be the site root), so every nav page also gets a small
stub there that sends the browser on to ``/guide/<page>/``, with the #anchor kept. Without
the stubs, a deep link in an old release would land on the landing page.

Stdlib plus PyYAML (a MkDocs dependency, so it is present wherever MkDocs is).
"""

from __future__ import annotations

import argparse
import html
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
LANDING = ROOT / "docs" / "landing"
CONFIG = ROOT / "mkdocs.yml"
# Copied to assets/ on the site: the landing page's logo and favicon (source, name in the site).
BRANDING = ROOT / "src" / "pdfeditor" / "data" / "branding" / "elanero" / "icons"
ASSETS: tuple[tuple[Path, str], ...] = (
    (BRANDING / "png" / "elanero-256.png", "elanero-256.png"),
    (BRANDING / "platform" / "favicon.ico", "favicon.ico"),
)
# Folders the site builds itself: a landing file or folder with one of these names would be
# overwritten or merged into, so it is refused (see check_landing).
GUIDE_FOLDER = "guide"
ASSETS_FOLDER = "assets"


def _nav_files(nav: list[Any]) -> list[str]:
    """Every page in the nav, from ``Title: page.md`` entries and nested sections."""
    files: list[str] = []
    for entry in nav:
        if isinstance(entry, str):
            files.append(entry)
            continue
        for value in entry.values():
            if isinstance(value, str):
                files.append(value)
            else:
                files.extend(_nav_files(value))
    return files


def _nav(config_path: Path) -> list[str]:
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    return _nav_files(config["nav"])


def nav_pages(config_path: Path) -> list[str]:
    """The page stems that need a redirect stub: every nav page except the home page.

    ``signing.md`` gives ``signing``; a nested ``section/page.md`` gives ``section/page``.
    """
    return [
        page[: -len(".md")]
        for page in _nav(config_path)
        if page != "index.md" and page.endswith(".md")
    ]


def redirect_html(target: str) -> str:
    """A complete page that sends the browser to ``target`` (a relative URL).

    The script runs before the meta refresh would, and it keeps the query and the #anchor, so
    a deep link to a section of an old guide page still lands on that section.
    """
    attr = html.escape(target, quote=True)
    script = json.dumps(target)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Elanero User Guide</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="{attr}">
<meta http-equiv="refresh" content="0; url={attr}">
<script>location.replace({script} + location.search + location.hash);</script>
</head>
<body>
<p>The Elanero user guide has moved to <a href="{attr}">{attr}</a>.</p>
</body>
</html>
"""


def _stub_target(stem: str) -> str:
    """Relative from ``<stem>/index.html`` up to the site root, then into ``guide/``."""
    depth = stem.count("/") + 1
    return "../" * depth + f"{GUIDE_FOLDER}/{stem}/"


def check_landing(config_path: Path = CONFIG) -> None:
    """Refuse a landing folder whose names would clash with the site's own folders.

    Without this check, a file ``docs/landing/signing/`` would be silently replaced by the
    redirect stub, and the landing page would lose its folder.
    """
    stems = nav_pages(config_path)
    reserved = {stem.split("/")[0] for stem in stems} | {GUIDE_FOLDER, ASSETS_FOLDER}
    clashes = sorted(entry.name for entry in LANDING.iterdir() if entry.name in reserved)
    if clashes:
        raise ValueError(
            f"docs/landing has {', '.join(clashes)}, which the site builds itself "
            "(guide, assets and the redirect stubs); rename it"
        )
    if not (LANDING / "index.html").is_file():
        raise FileNotFoundError(f"{LANDING / 'index.html'} is missing")


def assemble(site_dir: Path) -> None:
    """Copy the landing page and the branding assets into ``site_dir``, then write the stubs.

    The guide itself is not touched here: MkDocs writes it into ``site_dir/guide``.
    """
    check_landing()
    site_dir.mkdir(parents=True, exist_ok=True)
    for entry in LANDING.iterdir():
        target = site_dir / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target, dirs_exist_ok=True)
        else:
            shutil.copy2(entry, target)
    (site_dir / ASSETS_FOLDER).mkdir(exist_ok=True)
    for source, name in ASSETS:
        shutil.copy2(source, site_dir / ASSETS_FOLDER / name)
    for stem in nav_pages(CONFIG):
        stub = site_dir / stem / "index.html"
        stub.parent.mkdir(parents=True, exist_ok=True)
        stub.write_text(redirect_html(_stub_target(stem)), encoding="utf-8")


def _replaceable(site_dir: Path) -> bool:
    """Whether the build may delete ``site_dir``: a mistyped ``--site-dir docs`` must not.

    Only a missing or empty folder, an earlier build of this site (it has the landing page's
    stylesheet next to an index page), or the repository's own git-ignored ``site`` folder.
    """
    if not site_dir.exists():
        return True
    if not site_dir.is_dir():
        return False
    if site_dir == ROOT / "site" or not any(site_dir.iterdir()):
        return True
    return (site_dir / "landing.css").is_file() and (site_dir / "index.html").is_file()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the Elanero website into one folder.")
    parser.add_argument("--site-dir", type=Path, default=ROOT / "site")
    parser.add_argument("--skip-guide", action="store_true", help="assemble the landing page only")
    args = parser.parse_args(argv)
    # Absolute: MkDocs runs from the repository root, whatever folder this was started in.
    site_dir: Path = args.site_dir.resolve()
    if not _replaceable(site_dir):
        parser.error(
            f"--site-dir {site_dir} has other files in it and would be deleted; "
            "choose a new or empty folder, or one that holds an earlier build of the site"
        )

    # Refuse a bad landing folder before the output is deleted or MkDocs runs.
    check_landing()
    if site_dir.exists():
        shutil.rmtree(site_dir)
    if not args.skip_guide:
        command = [
            sys.executable,
            "-m",
            "mkdocs",
            "build",
            "--strict",
            "--site-dir",
            str(site_dir / GUIDE_FOLDER),
        ]
        print("Building the user guide (strict):", " ".join(command))
        done = subprocess.run(command, cwd=ROOT, check=False)
        if done.returncode:
            print(f"The user guide failed to build (exit {done.returncode}).", file=sys.stderr)
            return done.returncode
    assemble(site_dir)
    print(f"Website assembled in {site_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
