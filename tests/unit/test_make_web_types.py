"""The generator of the web RPC types (W3.8, W1.2 section 14): the committed file matches it,
a changed DTO changes it, and every call has a deadline class.

The Vitest suite in web/app runs the same --check from the front end's side.
"""

from __future__ import annotations

import sys
from dataclasses import make_dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import make_web_types  # noqa: E402

from pdfeditor.webapi import METHODS, Method, dto  # noqa: E402
from pdfeditor.webapi.errors import ALL_CODES  # noqa: E402


def _handler(result_type: type) -> object:
    def handler(params: dto.Empty) -> object:
        return None

    handler.__annotations__ = {"params": dto.Empty, "return": result_type}
    return handler


def test_the_committed_file_matches_the_generator() -> None:
    assert make_web_types.check() == 0, "run: uv run python scripts/make_web_types.py"


def test_render_is_deterministic() -> None:
    assert make_web_types.render() == make_web_types.render()


def test_check_fails_on_a_stale_or_missing_copy(tmp_path: Path) -> None:
    copy = tmp_path / "generated.ts"
    assert make_web_types.check(copy) == 1  # missing
    copy.write_text(make_web_types.render() + "// stale\n", encoding="utf-8")
    assert make_web_types.check(copy) == 1
    copy.write_text(make_web_types.render(), encoding="utf-8")
    assert make_web_types.check(copy) == 0


def test_a_field_added_to_a_dataclass_changes_the_output() -> None:
    hello = {"hello": Method(dto.Empty, _handler(dto.HelloResult))}
    deadlines = {"hello": "instant"}
    before = make_web_types.render(methods=hello, deadlines=deadlines)

    wider = make_dataclass(
        "HelloResult",
        [("protocol", int), ("engine", str), ("platform", str), ("extra", str)],
    )
    after = make_web_types.render(
        methods={"hello": Method(dto.Empty, _handler(wider))}, deadlines=deadlines
    )

    assert after != before
    assert "  extra: string;" in after


def test_every_call_needs_a_deadline_class() -> None:
    partial = {k: v for k, v in make_web_types.DEADLINE_CLASS.items() if k != "hello"}
    with pytest.raises(ValueError, match="no deadline class for hello"):
        make_web_types.render(methods=METHODS, deadlines=partial)


def test_deadline_classes_are_the_w12_section10_values() -> None:
    assert make_web_types.DEADLINE_MS == {
        "action": 30_000,
        "edit": 10_000,
        "instant": 3_000,
        "io": 15_000,
        "network": 20_000,
        "render": 5_000,
        "slice": 5_000,
    }
    assert set(make_web_types.DEADLINE_CLASS) == set(METHODS)


def test_error_code_union_is_every_code_sorted() -> None:
    text = make_web_types.render()
    expected = ", ".join(f"'{code}'" for code in sorted(ALL_CODES))
    assert f"export const ERROR_CODES = [{expected}] as const;" in text


def test_a_type_outside_the_w12_mapping_is_refused() -> None:
    bad = make_dataclass("Bad", [("items", list[int])])
    with pytest.raises(TypeError, match="no TypeScript form"):
        make_web_types.render(
            methods={"hello": Method(dto.Empty, _handler(bad))},
            deadlines={"hello": "instant"},
        )


def test_the_generated_methods_cover_every_call() -> None:
    text = make_web_types.render()
    for name in METHODS:
        assert f"'{name}': {{ params:" in text


def test_the_event_union_lists_every_event_kind() -> None:
    text = make_web_types.render()
    kinds = ", ".join(f"'{kind}'" for kind in sorted(dto.EVENT_TYPES))
    assert f"export const EVENT_KINDS = [{kinds}] as const;" in text
    for kind, event_class in dto.EVENT_TYPES.items():
        assert f"  '{kind}': {event_class.__name__};" in text  # EventPayloads
        assert f"  '{kind}': decode{event_class.__name__}," in text  # EVENT_DECODERS


def test_an_event_with_an_unsupported_field_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    bad = make_dataclass("BadEvent", [("handle", str), ("items", list[int])])
    monkeypatch.setitem(dto.EVENT_TYPES, "bad", bad)
    with pytest.raises(TypeError, match="no TypeScript form"):
        make_web_types.render()


def test_an_event_kind_must_name_a_dataclass(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(dto.EVENT_TYPES, "odd", str)
    with pytest.raises(TypeError, match="must be a dataclass"):
        make_web_types.render()
