"""What a pull request's changes require from CI (issue #109).

Stdlib only: it runs before anything is installed. A path it doesn't recognize counts as code,
and so does an empty list, so a mistake here costs time, never a skipped test.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Iterable
from fnmatch import fnmatch

# Nothing in the app, its tests or its packages reads these.
# mkdocs.yml configures the user guide site only (its build is docs.yml).
DOCS = (
    "*.md",
    "docs/*",
    "mkdocs.yml",
    "LICENSE",
    ".gitignore",
    ".gitattributes",
    ".github/CODEOWNERS",
)
# Not documentation, whatever it looks like: a release sends it to the Store, and a test checks it.
STORE_LISTING = "packaging/store/*"
# The web version (Phase W, docs/web/plan.md) has its own workflows (web-*.yml). Nothing in the
# desktop app, its tests or its packages reads these, so a web-only pull request skips the
# desktop CI, and a web workflow file doesn't count as packaging. So never give a desktop
# workflow a name starting with "web-".
WEB = (
    "web/*",
    ".github/workflows/web-*.yml",
)
# Files under web/ that the desktop code generates and a desktop test checks (for example the
# shortcut table of make_shortcut_docs.py). A hand edit to one of them must run the desktop CI,
# which is what would catch the drift.
DESKTOP_GENERATED = ("web/src/generated/*",)
# These can break the installer or the MSIX package without any test noticing, so changing them
# also runs the install tests of both.
PACKAGING = (
    "packaging/*",
    "pyproject.toml",
    ".github/workflows/*",
    "scripts/build_bootloader.py",
    "scripts/build_exe.py",
    "scripts/msix_package.py",
    "src/pdfeditor/bundle.py",
    "src/pdfeditor/selftest.py",
    "src/pdfeditor/services/file_association.py",
)


def _matches(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch(path, pattern) for pattern in patterns)


def classify(paths: Iterable[str]) -> dict[str, bool]:
    """``app``: run the checks, tests and build. ``packaging``: also the install tests.
    ``web``: run the web gate (the web app checks and web-pytest)."""
    changed = [path.replace("\\", "/") for path in paths if path.strip()]
    if not changed:
        return {"app": True, "packaging": True, "web": True}
    listing = [path for path in changed if fnmatch(path, STORE_LISTING)]
    code = [
        path
        for path in changed
        if not _matches(path, DOCS)
        and (not _matches(path, WEB) or _matches(path, DESKTOP_GENERATED))
        and path not in listing
    ]
    return {
        "app": bool(code or listing),
        "packaging": any(_matches(path, PACKAGING) for path in code),
        "web": any(_matches(path, WEB) for path in changed),
    }


def changed_paths() -> list[str]:
    """What a pull request changes: its merge commit against the branch it merges into."""
    done = subprocess.run(
        ["git", "diff", "--name-only", "HEAD^1", "HEAD"], capture_output=True, text=True, check=True
    )
    return done.stdout.splitlines()


def main() -> int:
    # Anything but a pull request (the nightly run, a release) runs everything.
    pull_request = os.environ.get("GITHUB_EVENT_NAME") == "pull_request"
    result = classify(changed_paths()) if pull_request else classify([])
    lines = [f"{name}={str(value).lower()}" for name, value in result.items()]
    print("\n".join(lines))
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
