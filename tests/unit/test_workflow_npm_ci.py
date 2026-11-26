"""Every npm install in the workflows ignores install scripts (W8.6, F3).

Install scripts run arbitrary code on the CI runner, including the deploy job, so a plain
``npm ci`` lets a hijacked package execute there. Every workflow line that installs packages must
pass ``--ignore-scripts``. A line may opt out only when the line above it is the comment
``# install scripts needed: <reason>``, which makes the exception visible in review.

The check is a text scan of ``.github/workflows/*.yml`` (no YAML parser needed), so it runs on every
PR and needs no PySide6 or PyMuPDF.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
# Every npm subcommand that installs packages: the ci and install names with their documented
# aliases, plus install-test (npm's test-install alias). Global options such as ``--prefix X``,
# ``-w X``, ``--workspace=X`` or ``--ignore-scripts`` may sit between ``npm`` and the subcommand.
# A boolean option followed by the subcommand is handled by backtracking: the value is optional.
INSTALL_SUBCOMMANDS = (
    "ci|clean-install|install-clean|isntall-clean|ic|"
    "install-test|it|install|isntall|isntal|isnta|isnt|inst|insta|instal|ins|in|i"
)
INSTALL = re.compile(
    rf"\bnpm\s+(?:-{{1,2}}[\w-]+(?:=\S+|\s+(?!-)\S+)?\s+)*(?:{INSTALL_SUBCOMMANDS})(?![\w-])"
)
EXEMPT_COMMENT = re.compile(r"^\s*#\s*install scripts needed:\s*\S")


def _logical_line(lines: list[str], index: int) -> str:
    """Join a line with the lines it continues (a trailing backslash), so flags after it count."""
    parts = [lines[index]]
    last = index
    while lines[last].rstrip().endswith("\\") and last + 1 < len(lines):
        last += 1
        parts.append(lines[last])
    return " ".join(parts)


def find_violations(name: str, text: str) -> list[str]:
    """Return ``name:line: text`` for each install line that runs install scripts."""
    lines = text.splitlines()
    found: list[str] = []
    for index, line in enumerate(lines):
        if not INSTALL.search(line):
            continue
        if "--ignore-scripts" in _logical_line(lines, index):
            continue
        above = lines[index - 1] if index > 0 else ""
        if EXEMPT_COMMENT.match(above):
            continue
        found.append(f"{name}:{index + 1}: {line.strip()}")
    return found


def test_workflow_npm_installs_ignore_scripts() -> None:
    violations: list[str] = []
    for path in sorted(WORKFLOWS.glob("*.yml")):
        rel = path.relative_to(ROOT).as_posix()
        violations += find_violations(rel, path.read_text(encoding="utf-8"))
    assert not violations, (
        "npm install lines without --ignore-scripts (add it, or put "
        "'# install scripts needed: <reason>' on the line above):\n" + "\n".join(violations)
    )


def test_checker_reports_plain_npm_ci() -> None:
    fake = "      - name: Install\n        run: npm ci\n"
    assert find_violations("fake.yml", fake) == ["fake.yml:2: run: npm ci"]
    assert find_violations("fake.yml", "        run: npm install left-pad\n")
    assert find_violations("fake.yml", "        run: npm ci --ignore-scripts\n") == []
    exempt = "        # install scripts needed: native build\n        run: npm ci\n"
    assert find_violations("fake.yml", exempt) == []


@pytest.mark.parametrize(
    "command",
    [
        "npm ci",
        "npm clean-install",
        "npm install",
        "npm install left-pad",
        "npm i",
        "npm in",
        "npm ins",
        "npm inst",
        "npm insta",
        "npm instal",
        "npm install-test",
        "npm it",
        "npm --prefix web/app ci",
        "npm --prefix web/app install",
        "npm --prefix=web/app ci",
        "npm -w app ci",
        "npm --workspace app install",
        "npm --workspace=app ci",
        "npm --location=global i",
    ],
)
def test_checker_reports_every_install_form(command: str) -> None:
    text = f"        run: {command}\n"
    assert find_violations("fake.yml", text) == [f"fake.yml:1: run: {command}"]
    assert find_violations("fake.yml", f"        run: {command} --ignore-scripts\n") == []
    exempt = f"        # install scripts needed: native build\n        run: {command}\n"
    assert find_violations("fake.yml", exempt) == []


@pytest.mark.parametrize(
    "command",
    ["npm run build", "npm run ci", "npm test", "npm audit --omit=dev", "npm init -y"],
)
def test_checker_ignores_non_install_commands(command: str) -> None:
    assert find_violations("fake.yml", f"        run: {command}\n") == []


def test_checker_reads_flag_on_a_continuation_line() -> None:
    continued = "        run: npm ci \\\n          --ignore-scripts\n"
    assert find_violations("fake.yml", continued) == []
    missing = "        run: npm ci \\\n          --no-audit\n"
    assert find_violations("fake.yml", missing) == ["fake.yml:1: run: npm ci \\"]
