"""Every ``npm ci`` and ``npm install`` in the workflows ignores install scripts (W8.6, F3).

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

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
INSTALL = re.compile(r"\bnpm\s+(ci|install)\b")
EXEMPT_COMMENT = re.compile(r"^\s*#\s*install scripts needed:\s*\S")


def find_violations(name: str, text: str) -> list[str]:
    """Return ``name:line: text`` for each install line that runs install scripts."""
    lines = text.splitlines()
    found: list[str] = []
    for index, line in enumerate(lines):
        if not INSTALL.search(line) or "--ignore-scripts" in line:
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
