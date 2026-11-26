"""Every workflow pins its third-party actions by commit SHA (W8.6 F14, #752).

Workflows run with write permissions (``pages: write``, ``id-token: write``, ``contents: write``,
and the Microsoft Store publish), so a retagged or hijacked action could publish or alter a
release. A tag can be moved; a commit SHA cannot. Each third-party ``uses:`` line in every file
under ``.github/workflows`` must therefore name a full 40-character SHA, with the release version
kept as a trailing comment for review: ``uses: owner/name@<sha> # v<version>``.

Local ``./`` references are not third-party code and pass. The check is a text scan (no YAML parser
needed), so it runs under Pyodide with the other workflow checks. No line is exempt.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS_DIR = ROOT / ".github" / "workflows"
WORKFLOWS = sorted(WORKFLOWS_DIR.glob("*.yml"))
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


def test_workflows_found() -> None:
    assert WORKFLOWS, f"no workflow files in {WORKFLOWS_DIR}"


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda path: path.name)
def test_workflow_actions_pinned_by_sha(workflow: Path) -> None:
    text = workflow.read_text(encoding="utf-8")
    violations = find_violations(workflow.name, text)
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
