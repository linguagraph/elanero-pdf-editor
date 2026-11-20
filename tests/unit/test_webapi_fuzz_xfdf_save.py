"""Fuzz tests of the XFDF import and the save path (W8.6 S5, W1.7 section 9), host CPython.

Two inputs, both through :func:`pdfeditor.webapi.dispatch`, with the W8.4 harness
(``robustness_helpers``) and its mutations (``test_webapi_fuzz.mutate``):

- (a) XFDF text through ``comments.xfdf_preview`` and ``annotations.import_xfdf``: hostile
  declarations (DOCTYPE, ENTITY, billion laughs), encodings and BOMs, deep nesting, huge
  attributes and the 8 MiB bound. Each is refused with a W1.2 code or accepted, never INTERNAL;
- (b) random-but-valid edit sequences, and mutated fixtures, followed by ``save.save_bytes``.
  The save must reopen or fail with a W1.2 code, and any file it returns must open again.

Every case is seeded from its name, so a failure reproduces by running the same test. The
default counts are small; the ``slow`` tests run the nightly counts. Pyodide runs have no
pikepdf, and none of these tests needs it.
"""

from __future__ import annotations

import json
import random
import re
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.services.xfdf import MAX_XFDF_BYTES
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.errors import FILE_TOO_LARGE, REFUSED
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.unit.robustness_helpers import check_reply, run_bounded
from tests.unit.test_webapi_fuzz import FIXTURES, mutate

SHORT_XFDF = 120  # per run, default
LONG_XFDF = 1500  # slow run
SHORT_SEQUENCES = 10
LONG_SEQUENCES = 150
SHORT_SAVE_MUTATIONS = 2  # per fixture, default run
LONG_SAVE_MUTATIONS = 24  # per fixture, slow run

BASE_XFDF = (
    "\n".join(
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">',
            "<annots>",
            '<square page="0" name="s1" rect="72,600,200,700" color="#FF0000" width="2"'
            " date=\"D:20260101120000+01'00'\"><contents>square</contents></square>",
            '<highlight page="0" name="h1" rect="72,500,300,520"'
            ' coords="72,520,300,520,72,500,300,500" color="#FFFF00">'
            "<contents>hl</contents></highlight>",
            '<text page="0" name="t1" rect="100,400,120,420" icon="Note" state="Accepted"'
            ' stateModel="Review"><contents>note</contents></text>',
            '<ink page="0" name="i1" rect="50,50,150,150" color="#0000FF">'
            "<inklist><gesture>50,50,60,60</gesture></inklist></ink>",
            '<text page="0" name="r1" inreplyto="t1" rect="100,380,120,400">'
            "<contents>reply</contents></text>",
            "</annots>",
            "</xfdf>",
        ]
    )
    + "\n"
)

# Fragments spliced into XFDF text: markup, entities, a lone surrogate (JSON can carry one), a
# NUL, a byte-order mark and numbers that overflow or are not numbers.
_XFDF_JUNK = (
    "<", ">", '"', "'", "&", "&amp;", "&#0;", "&#xD800;", "<!DOCTYPE", "<!ENTITY", "]]>",
    "<![CDATA[", "\x00", "﻿", "\ud800", "\U0001f4a9", "9" * 40, "-", "1e999", "nan", "",
)  # fmt: skip
_ATTRIBUTE_VALUES = (
    "0", "-1", "99999", "1e999", "nan", "-inf", "1" * 400, "9223372036854775808", "", "x,y",
    "D:99999999999999", "#GGGGGG", "Locked,ReadOnly", "Accepted",
)  # fmt: skip
_ATTRIBUTE = re.compile(r'="([^"]*)"')


def mutate_xfdf(text: str, rng: random.Random) -> str:
    """One seeded mutation of XFDF text: a junk character, a truncation, junk inserted, a slice
    duplicated, or an attribute value replaced by a number-like or hostile string."""
    kind = rng.randrange(5)
    if kind == 0:
        pos = rng.randrange(len(text))
        return text[:pos] + rng.choice(_XFDF_JUNK) + text[pos + 1 :]
    if kind == 1:
        return text[: rng.randrange(len(text))]
    if kind == 2:
        pos = rng.randrange(len(text))
        return text[:pos] + rng.choice(_XFDF_JUNK) + text[pos:]
    if kind == 3:
        a = rng.randrange(len(text))
        b = min(len(text), a + rng.randint(1, 300))
        return text[:b] + text[a:b] + text[b:]
    found = list(_ATTRIBUTE.finditer(text))
    if not found:
        return text
    m = rng.choice(found)
    return text[: m.start() + 2] + rng.choice(_ATTRIBUTE_VALUES) + text[m.end() - 1 :]


def _body(text: str) -> str:
    """BASE_XFDF without its XML declaration, for splicing into a DOCTYPE document."""
    return text.split("?>", 1)[1]


def _nested_unknown(depth: int) -> str:
    """BASE_XFDF with ``depth`` nested unknown elements in annots: the import ignores them, but
    the parser still builds them."""
    body = "<x>" * depth + "<x/>" + "</x>" * depth
    return BASE_XFDF.replace("<annots>", "<annots>" + body, 1)


def _billion_laughs() -> str:
    """The classic entity-expansion document: ten levels, each ten references to the last."""
    lines = ["<!DOCTYPE lolz [", '<!ENTITY lol0 "lol">']
    for level in range(1, 10):
        lines.append(f'<!ENTITY lol{level} "{f"&lol{level - 1};" * 10}">')
    lines += [
        "]>",
        '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>',
        '<text page="0"><contents>&lol9;</contents></text></annots></xfdf>',
    ]
    return "\n".join(lines)


# Hostile inputs that must be refused (REFUSED) before anything is parsed or changed.
REFUSED_XFDF: dict[str, str] = {
    "billion laughs": _billion_laughs(),
    "external entity": (
        '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + _body(BASE_XFDF)
    ),
    "lowercase doctype": "<!doctype xfdf>" + _body(BASE_XFDF),
    "doctype inside the root": BASE_XFDF.replace("<annots>", "<!DOCTYPE xfdf><annots>", 1),
    "undeclared entity": BASE_XFDF.replace("note", "&xxe;", 1),
    "not xml": "this is not xml",
    "wrong root": BASE_XFDF.replace("<xfdf", "<html", 1).replace("</xfdf>", "</html>"),
    "empty": "",
}

# Odd inputs: a reply may be a success or a clean code, never INTERNAL.
ODD_XFDF: dict[str, str] = {
    "utf-16 declaration": BASE_XFDF.replace('"UTF-8"', '"UTF-16"', 1),
    "bom prefix": "﻿" + BASE_XFDF,
    "unknown elements": _nested_unknown(3000),
    "huge rect": BASE_XFDF.replace('rect="72,600,200,700"', 'rect="0,' + "1" * 500_000 + '"', 1),
    "lone surrogate": BASE_XFDF.replace("square", "sq\ud800uare", 1),
    "no annots": '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"/>',
}


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def _call(method: str, params: dict[str, Any], label: str) -> tuple[dict[str, Any], list[bytes]]:
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, out = run_bounded(lambda: dispatch(request, []))
    return check_reply(reply_json, label), out


def _open(data: bytes, label: str) -> str | None:
    """session.open through dispatch: the handle of a success, else None."""
    request = json.dumps(
        {
            "v": 1,
            "id": 1,
            "method": "session.open",
            "params": {"name": "case.pdf", "data": {"$bin": 0}, "password": None},
        }
    )
    reply_json, _ = run_bounded(lambda: dispatch(request, [data]))
    reply = check_reply(reply_json, label)
    return str(reply["result"]["handle"]) if reply["ok"] else None


def _open_fixture(fixture_pdf: Any, name: str) -> str:
    handle = _open(fixture_pdf(name).read_bytes(), f"open {name}")
    assert handle is not None, f"fixture {name} did not open"
    return handle


def _import(handle: str, text: str, label: str) -> dict[str, Any]:
    params = {"handle": handle, "name": "annotations.import_xfdf", "args": {"text": text}}
    reply, _ = _call("actions.run", params, label)
    return reply


def _preview(handle: str, text: str, label: str) -> dict[str, Any]:
    reply, _ = _call("comments.xfdf_preview", {"handle": handle, "text": text}, label)
    return reply


@pytest.mark.parametrize("name", sorted(REFUSED_XFDF))
def test_fuzz_xfdf_hostile_declarations_are_refused(web: None, fixture_pdf: Any, name: str) -> None:
    """DOCTYPE, ENTITY and malformed inputs are REFUSED by the preview and by the import.

    Reproduce with REFUSED_XFDF[name]. A refused import changes nothing.
    """
    handle = _open_fixture(fixture_pdf, "annotations")
    try:
        text = REFUSED_XFDF[name]
        preview = _preview(handle, text, f"preview {name}")
        assert preview["ok"] is False and preview["error"]["code"] == REFUSED, (name, preview)
        imported = _import(handle, text, f"import {name}")
        assert imported["ok"] is False and imported["error"]["code"] == REFUSED, (name, imported)
    finally:
        REGISTRY.close(handle)


@pytest.mark.parametrize("name", sorted(ODD_XFDF))
def test_fuzz_xfdf_odd_inputs_reply_cleanly(web: None, fixture_pdf: Any, name: str) -> None:
    """Encodings, BOMs, nesting and huge values: a success or a W1.2 code, never INTERNAL."""
    handle = _open_fixture(fixture_pdf, "annotations")
    try:
        _preview(handle, ODD_XFDF[name], f"preview {name}")
        _import(handle, ODD_XFDF[name], f"import {name}")
    finally:
        REGISTRY.close(handle)


def test_fuzz_xfdf_size_bound(web: None, fixture_pdf: Any) -> None:
    """The 8 MiB bound, in UTF-8 bytes: exactly at the limit parses, one byte over is refused
    as FILE_TOO_LARGE, and so is a text short in characters but over in bytes."""
    handle = _open_fixture(fixture_pdf, "annotations")
    try:
        room = MAX_XFDF_BYTES - len(BASE_XFDF.encode("utf-8"))
        at_limit = BASE_XFDF.replace("<annots>", "<annots>" + " " * room, 1)
        assert len(at_limit.encode("utf-8")) == MAX_XFDF_BYTES
        assert _preview(handle, at_limit, "preview at the limit")["ok"] is True
        over = BASE_XFDF.replace("<annots>", "<annots>" + " " * (room + 1), 1)
        reply = _preview(handle, over, "preview one byte over")
        assert reply["ok"] is False and reply["error"]["code"] == FILE_TOO_LARGE, reply
        # 2-byte characters: about half as many characters as bytes, so only the byte count
        # is over the limit.
        wide_room = room // 2 + 1
        wide = BASE_XFDF.replace("<annots>", "<annots>" + "é" * wide_room, 1)
        assert len(wide) < MAX_XFDF_BYTES < len(wide.encode("utf-8"))
        reply = _preview(handle, wide, "preview 2-byte characters over")
        assert reply["ok"] is False and reply["error"]["code"] == FILE_TOO_LARGE, reply
        imported = _import(handle, over, "import one byte over")
        assert imported["ok"] is False and imported["error"]["code"] == REFUSED, imported
    finally:
        REGISTRY.close(handle)


def _xfdf_cases(fixture_pdf: Any, count: int, seed: str) -> None:
    handle = _open_fixture(fixture_pdf, "annotations")
    rng = random.Random(seed)
    try:
        for index in range(count):
            text = mutate_xfdf(BASE_XFDF, rng)
            label = f"xfdf case {index} of random.Random({seed!r})"
            _preview(handle, text, f"preview {label}")
            _import(handle, text, f"import {label}")
    finally:
        REGISTRY.close(handle)


def test_fuzz_xfdf_mutations_short(web: None, fixture_pdf: Any) -> None:
    """Seeded mutations of a valid XFDF file through preview and import."""
    _xfdf_cases(fixture_pdf, SHORT_XFDF, "w86s5:xfdf")


@pytest.mark.slow
def test_fuzz_xfdf_mutations_long(web: None, fixture_pdf: Any) -> None:
    _xfdf_cases(fixture_pdf, LONG_XFDF, "w86s5:xfdf")


def _random_step(handle: str, rng: random.Random, label: str) -> None:
    """One random action on the open document: a rotation, an XFDF import (sometimes of a
    mutated file), an undo or redo, or a page deletion."""
    info, _ = _call("session.info", {"handle": handle}, f"{label} info")
    pages = int(info["result"]["page_count"])
    choice = rng.randrange(4)
    if choice == 0:
        chosen = sorted(rng.sample(range(pages), rng.randint(1, min(3, pages))))
        args: dict[str, Any] = {"pages": chosen, "delta": rng.choice([90, 180, 270, -90])}
        _call("actions.run", {"handle": handle, "name": "pages.rotate", "args": args}, label)
    elif choice == 1:
        text = mutate_xfdf(BASE_XFDF, rng) if rng.random() < 0.5 else BASE_XFDF
        _import(handle, text, f"{label} import")
    elif choice == 2:
        method = rng.choice(["actions.undo", "actions.redo"])
        _call(method, {"handle": handle}, f"{label} {method}")
    elif pages > 1:
        args = {"pages": [rng.randrange(pages)]}
        _call("actions.run", {"handle": handle, "name": "pages.delete", "args": args}, label)


def _save_and_reopen(handle: str, rng: random.Random, label: str) -> None:
    """save.save_bytes in a random mode. A failure must carry a W1.2 code (checked by
    check_reply); a file that comes back must open again."""
    mode = rng.choice(["copy", "in_place"])
    reply, out = _call("save.save_bytes", {"handle": handle, "mode": mode}, f"{label} save")
    if reply["ok"]:
        assert len(out) == 1, label
        assert _open(out[0], f"{label} reopen after {mode} save") is not None, label


def _sequence_cases(fixture_pdf: Any, count: int, seed: str) -> None:
    rng = random.Random(seed)
    for index in range(count):
        label = f"sequence {index} of random.Random({seed!r})"
        handle = _open_fixture(fixture_pdf, rng.choice(["text_multipage", "annotations"]))
        try:
            for step in range(rng.randint(1, 6)):
                _random_step(handle, rng, f"{label} step {step}")
            _save_and_reopen(handle, rng, label)
        finally:
            REGISTRY.close(handle)


def test_fuzz_save_edit_sequences_short(web: None, fixture_pdf: Any) -> None:
    """Random but valid edits, then a save and a reopen, from a fixed seed."""
    _sequence_cases(fixture_pdf, SHORT_SEQUENCES, "w86s5:sequences")


@pytest.mark.slow
def test_fuzz_save_edit_sequences_long(web: None, fixture_pdf: Any) -> None:
    _sequence_cases(fixture_pdf, LONG_SEQUENCES, "w86s5:sequences")


def _mutated_save_cases(fixture_pdf: Any, name: str, mutations: int) -> None:
    data = fixture_pdf(name).read_bytes()
    for index in range(mutations):
        seed = f"w86s5:save:{name}:{index}"
        rng = random.Random(seed)
        handle = _open(mutate(data, rng), f"open random.Random({seed!r})")
        if handle is None:  # a damaged file that does not open is the open fuzz's case
            continue
        try:
            _save_and_reopen(handle, rng, f"random.Random({seed!r})")
        finally:
            REGISTRY.close(handle)


@pytest.mark.parametrize("name", FIXTURES)
def test_fuzz_save_mutated_fixtures_short(web: None, fixture_pdf: Any, name: str) -> None:
    """A mutated fixture that opens is saved and reopened."""
    _mutated_save_cases(fixture_pdf, name, SHORT_SAVE_MUTATIONS)


@pytest.mark.slow
@pytest.mark.parametrize("name", FIXTURES)
def test_fuzz_save_mutated_fixtures_long(web: None, fixture_pdf: Any, name: str) -> None:
    _mutated_save_cases(fixture_pdf, name, LONG_SAVE_MUTATIONS)
