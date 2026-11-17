"""The user guide agrees with the app and with itself: the site address, the nav, the files in
docs/guide, and the docs tooling that CI runs (issue #119). The shortcut page is checked
against the real main window in tests/ui/test_user_guide.py."""

from __future__ import annotations

import re
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

import pytest

from pdfeditor import DOCS_URL

# PyYAML is not in the Pyodide package set: the web run skips these checks.
yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[2]
GUIDE = ROOT / "docs" / "guide"


def _config() -> dict[str, Any]:
    return yaml.safe_load((ROOT / "mkdocs.yml").read_text(encoding="utf-8"))


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


def test_the_app_opens_the_site_mkdocs_publishes() -> None:
    assert _config()["site_url"] == DOCS_URL


def test_every_guide_page_is_in_the_nav() -> None:
    pages = {p.relative_to(GUIDE).as_posix() for p in GUIDE.rglob("*.md")}
    nav = _nav_files(_config()["nav"])
    assert sorted(pages - set(nav)) == []


def test_every_nav_entry_is_a_guide_page() -> None:
    nav = _nav_files(_config()["nav"])
    assert len(nav) == len(set(nav)), "a page is listed twice in the nav"
    assert [name for name in nav if not (GUIDE / name).is_file()] == []


def test_the_guide_docs_extra_is_pinned_and_docs_only() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    extra = re.search(r"^docs = \[(.*)\]$", pyproject, re.MULTILINE)
    assert extra is not None
    pins = re.findall(r'"([^"]+)"', extra.group(1))
    assert pins and all("==" in pin for pin in pins), pins
    # The docs tools are an optional extra only: never a runtime dependency of the app.
    dependencies = pyproject.split("dependencies = [", 1)[1].split("]", 1)[0]
    assert "mkdocs" not in dependencies


def test_the_docs_workflow_builds_strictly_and_deploys_from_main() -> None:
    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "docs.yml").read_text("utf-8"))
    # PyYAML reads the bare key ``on`` as True.
    triggers = workflow[True]
    for event in ("pull_request", "push"):
        paths = set(triggers[event]["paths"])
        assert {"docs/guide/**", "docs/landing/**", "mkdocs.yml"} <= paths
        # The web version's docs (docs/web) are not part of the site build, so a change there
        # must not run it. Glob semantics: "docs/**" would match docs/web/plan.md.
        assert not any(fnmatch("docs/web/plan.md", pattern) for pattern in paths)
        assert "docs/**" not in paths
        # The site assembler and the brand icons it copies (issue #129).
        assert {"scripts/build_site.py", "src/pdfeditor/data/branding/**"} <= paths
    # Read-only by default; the Pages rights belong to the deploy job alone.
    assert workflow["permissions"] == {"contents": "read"}
    jobs = workflow["jobs"]
    assert jobs["deploy"]["permissions"] == {"pages": "write", "id-token": "write"}
    assert "permissions" not in jobs["site"]
    build_steps = jobs["site"]["steps"]
    # The site (guide strictly, landing page, redirect stubs) is assembled by the script.
    assert any("scripts/build_site.py" in str(s.get("run", "")) for s in build_steps)
    build_uses = [str(s.get("uses", "")) for s in build_steps]
    assert any(u.startswith("actions/configure-pages@v5") for u in build_uses)
    assert any(u.startswith("actions/upload-pages-artifact@v3") for u in build_uses)
    deploy_uses = [str(s.get("uses", "")) for s in jobs["deploy"]["steps"]]
    assert any(u.startswith("actions/deploy-pages@v4") for u in deploy_uses)
    assert "refs/heads/main" in str(jobs["deploy"]["if"])


def test_no_view_source_button() -> None:
    """Material's "View source" link replaces every "edit" in the edit URL with "raw", so with
    this repo's name it pointed to linguagraph/elanero-pdf-rawor."""
    config = (ROOT / "mkdocs.yml").read_text(encoding="utf-8")
    assert "- content.action.view" not in config
