"""Replay the host checks that the Pyodide run recorded (design W1.7 section 3).

    python scripts/web_host_verify.py <host-checks.json>

Runs on host CPython, where pikepdf and pypdfium2 exist. Every entry is validated before any
check runs: an unknown check name refuses the whole manifest, so nothing is guessed.

Exit status: 0 when every check passes, 1 when any fails, 2 when the manifest is bad or the
arguments are wrong.
"""

from __future__ import annotations

import base64
import binascii
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.hostcheck import HOST_CHECKS  # noqa: E402  (needs the repo root on sys.path)

MANIFEST_VERSION = 1
EXIT_PASS, EXIT_FAIL, EXIT_BAD = 0, 1, 2


@dataclass(frozen=True)
class Entry:
    name: str
    args: dict[str, Any]
    data: bytes
    test: str


class BadManifest(Exception):
    """The manifest cannot be replayed. Carries the message printed before exit 2."""


def _parse(path: Path) -> list[Entry]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BadManifest(f"cannot read {path}: {exc}") from exc
    if not isinstance(doc, dict) or doc.get("version") != MANIFEST_VERSION:
        raise BadManifest(f"{path} is not a version {MANIFEST_VERSION} host-check manifest")
    raw_checks = doc.get("checks")
    if not isinstance(raw_checks, list):
        raise BadManifest("the manifest's checks is not a list")
    entries: list[Entry] = []
    for index, item in enumerate(raw_checks):
        if not isinstance(item, dict):
            raise BadManifest(f"entry {index} is not an object")
        name, args_text, data_b64 = item.get("name"), item.get("args"), item.get("data_b64")
        if not (isinstance(name, str) and isinstance(args_text, str) and isinstance(data_b64, str)):
            raise BadManifest(f"entry {index} needs string fields name, args and data_b64")
        if name not in HOST_CHECKS:
            raise BadManifest(f"unknown host check {name}")
        try:
            args = json.loads(args_text)
            data = base64.b64decode(data_b64, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise BadManifest(f"entry {index} ({name}): bad args or data_b64: {exc}") from exc
        if not isinstance(args, dict):
            raise BadManifest(f"entry {index} ({name}): args must be a JSON object")
        test = item.get("test") if isinstance(item.get("test"), str) else ""
        entries.append(Entry(name, args, data, test))
    return entries


def main(argv: list[str]) -> int:
    if not argv:
        print(
            "usage: python scripts/web_host_verify.py <host-checks.json> [more.json ...]",
            file=sys.stderr,
        )
        return EXIT_BAD
    entries: list[Entry] = []
    try:
        for path in argv:
            entries.extend(_parse(Path(path)))
    except BadManifest as exc:
        print(f"FAIL {exc}")
        return EXIT_BAD
    passed = failed = 0
    for entry in entries:
        where = f" [{entry.test}]" if entry.test else ""
        try:
            HOST_CHECKS[entry.name](entry.data, **entry.args)
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {entry.name}{where}: {exc or 'assertion failed'}")
        except Exception as exc:  # a check that cannot even read the file is a failure too
            failed += 1
            print(f"FAIL {entry.name}{where}: {type(exc).__name__}: {exc}")
        else:
            passed += 1
            print(f"PASS {entry.name}{where}")
    print(f"host checks: {passed} passed, {failed} failed, {len(entries)} recorded")
    return EXIT_FAIL if failed else EXIT_PASS


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
