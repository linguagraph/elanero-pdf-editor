"""The GitHub Pages deploy pins its actions by commit SHA (W8.6, F14).

``web-deploy.yml`` runs with ``pages: write`` and ``id-token: write``, so a retagged or hijacked
action there could publish to the site. A tag can be moved; a commit SHA cannot. Each third-party
``uses:`` line in that file must therefore name a full 40-character SHA, with the release version
kept as a trailing comment for review: ``uses: actions/<name>@<sha> # v<version>``.

Local ``./`` references are not third-party code and pass. The check is a text scan (no YAML parser
needed), so it runs under Pyodide with the other workflow checks. Only ``web-deploy.yml`` is in
scope; the other workflows are a follow-up.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEPLOY_WORKFLOW = ROOT / ".github" / "workflows" / "web-deploy.yml"
USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(?P<value>\S*)(?P<rest>.*)$")
PINNED = re.compile(r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
VERSION_COMMENT = re.compile(r"^\s*#\s*v\d+(?:\.\d+)*\S*\s*$")


def find_violations(name: str, text: str) -> list[str]:
    """Return ``name:line: text`` for each ``uses:`` line that is not SHA-pinned with a version."""
    found: list[str] = []
    for index, line in enumerate(text.splitlines()):
        match = USES.match(line)
        if match is None:
            continue
        value = match["value"]
        if value.startswith("./"):
            continue
        if PINNED.match(value) and VERSION_COMMENT.match(match["rest"]):
            continue
        found.append(f"{name}:{index + 1}: {line.strip()}")
    return found


def test_deploy_workflow_actions_pinned_by_sha() -> None:
    text = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    assert any(USES.match(line) for line in text.splitlines()), "no uses: lines found"
    violations = find_violations("web-deploy.yml", text)
    assert not violations, (
        "uses: lines not pinned by commit SHA (use 'uses: owner/name@<40 hex> # vX.Y.Z'):\n"
        + "\n".join(violations)
    )


def test_checker_flags_tag_ref() -> None:
    text = "      - uses: actions/deploy-pages@v5\n"
    assert find_violations("fake.yml", text) == ["fake.yml:1: - uses: actions/deploy-pages@v5"]


def test_checker_flags_sha_without_version_comment() -> None:
    sha = "368f82528645a54fb793d4d04e342629a3f51346"
    text = f"        uses: actions/deploy-pages@{sha}\n"
    assert find_violations("fake.yml", text) == [f"fake.yml:1: uses: actions/deploy-pages@{sha}"]


def test_checker_passes_sha_with_version_comment() -> None:
    sha = "368f82528645a54fb793d4d04e342629a3f51346"
    text = f"        uses: actions/deploy-pages@{sha} # v5.0.1\n"
    assert find_violations("fake.yml", text) == []


def test_checker_passes_local_reference() -> None:
    assert find_violations("fake.yml", "        uses: ./.github/actions/setup\n") == []
