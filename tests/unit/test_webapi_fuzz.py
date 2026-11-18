"""Deterministic fuzz and robustness tests of the web RPC (W8.4, W1.7 section 9), host CPython.

Three inputs, each through :func:`pdfeditor.webapi.dispatch`:

- (a) bytes: mutated fixtures through ``session.open``;
- (b) JSON: malformed and random envelopes;
- (c) handles, page indexes and scales through ``render.page``, ``render.tile`` and ``text.layer``.

Every case is seeded from its name, so a failure reproduces by running the same test. The
default-run counts are small enough for CI; the ``slow`` tests run the nightly counts. A pass is
defined once in ``robustness_helpers.check_reply``: a well-formed envelope with a W1.2 code (or a
success), never ``INTERNAL``, and a reply within ``CASE_SECONDS``.

Pyodide runs have no pikepdf or pypdfium2, and none of these tests needs them.
"""

from __future__ import annotations

import functools
import json
import random
import re
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import METHODS, dispatch
from pdfeditor.webapi.errors import INVALID_ARGS, INVALID_REQUEST, OPEN_FAILED
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.unit.robustness_helpers import check_reply, run_bounded

# Fixtures the mutations start from: small, and between them they cover xref streams, hybrid
# and broken xref tables, encryption, annotations, signatures, rotation and embedded fonts.
FIXTURES = (
    "text_multipage",
    "images",
    "annotations",
    "outline",
    "encrypted",
    "hybrid_xref",
    "broken_xref",
    "rotated_pages",
    "subset_fonts",
    "shared_objects_annotation",
    "incremental_sigflags_empty_embedded",
    "cjk_text",
    "vector_art",
    "tagged",
)

SHORT_MUTATIONS = 12  # per fixture, default run
SHORT_TRUNCATIONS = 24  # per fixture, default run
LONG_MUTATIONS = 72  # per fixture: 14 fixtures x 72 = 1008, the nightly count (W1.7 section 9)
LONG_TRUNCATION_STEP = 3  # slow run: every third byte offset
SHORT_ENVELOPES = 300
LONG_ENVELOPES = 3000
SHORT_GRID_RANDOM = 200
LONG_GRID_RANDOM = 2000

JUNK_ANCHORS = (b"xref", b"trailer", b"startxref", b"stream", b"endobj", b"/Length", b"obj")
XREF_ENTRY = re.compile(rb"\d{10} \d{5} [nf]")
STARTXREF = re.compile(rb"startxref\s+\d+")


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def mutate(data: bytes, rng: random.Random) -> bytes:
    """One seeded mutation of ``data``: bit flips, a random run overwritten, junk inserted at a
    structural anchor, a duplicated slice, a broken startxref or xref offset."""
    kind = rng.randrange(7)
    if kind == 0:
        out = bytearray(data)
        for _ in range(rng.randint(1, 8)):
            out[rng.randrange(len(out))] ^= 1 << rng.randrange(8)
        return bytes(out)
    if kind == 1:
        return data[: rng.randrange(len(data))]
    if kind == 2:
        pos = rng.randrange(len(data))
        n = rng.randint(1, 48)
        return data[:pos] + rng.randbytes(n) + data[pos + n :]
    if kind == 3:
        anchor = rng.choice(JUNK_ANCHORS)
        starts = [m.start() for m in re.finditer(re.escape(anchor), data)]
        pos = rng.choice(starts) if starts else rng.randrange(len(data))
        return data[:pos] + rng.randbytes(rng.randint(1, 32)) + data[pos:]
    if kind == 4:
        a = rng.randrange(len(data))
        b = min(len(data), a + rng.randint(1, 400))
        c = rng.randrange(len(data))
        return data[:c] + data[a:b] + data[c:]
    if kind == 5:
        found = list(STARTXREF.finditer(data))
        if not found:
            return mutate(data, rng)
        m = rng.choice(found)
        digits = str(rng.randrange(10 ** rng.randint(1, 12))).encode()
        return data[: m.start()] + b"startxref\n" + digits + data[m.end() :]
    found = list(XREF_ENTRY.finditer(data))
    if not found:
        return mutate(data, rng)
    m = rng.choice(found)
    offset = b"%010d" % rng.randrange(10**10)
    return data[: m.start()] + offset + data[m.start() + 10 :]


def open_request(data: bytes, label: str) -> None:
    """``session.open`` on ``data`` through dispatch; a success is closed again at once."""
    request = json.dumps(
        {
            "v": 1,
            "id": 1,
            "method": "session.open",
            "params": {"name": "case.pdf", "data": {"$bin": 0}, "password": None},
        }
    )
    reply_json, out = run_bounded(lambda: dispatch(request, [data]))
    assert out == [], label
    reply = check_reply(reply_json, label)
    if reply["ok"]:
        REGISTRY.close(reply["result"]["handle"])


def _fixture_bytes(fixture_pdf: Any, name: str) -> bytes:
    data: bytes = fixture_pdf(name).read_bytes()
    return data


def _open_cases(data: bytes, name: str, mutations: int) -> None:
    for index in range(mutations):
        label = f"open {name} mutation random.Random('w84:{name}:{index}')"
        open_request(mutate(data, random.Random(f"w84:{name}:{index}")), label)


def _truncation_cases(data: bytes, name: str, step: int) -> None:
    for offset in range(0, len(data), step):
        open_request(data[:offset], f"open {name} truncated to {offset} bytes")


@pytest.mark.parametrize("name", FIXTURES)
def test_fuzz_open_mutated_fixtures_short(web: None, fixture_pdf: Any, name: str) -> None:
    """Reproduce one case: mutate(fixture bytes, random.Random('w84:NAME:INDEX')), then open it.

    A failure names the fixture and index in its message.

    Regression: the damaged outline case below used to return INTERNAL; it is OPEN_FAILED
    now (see test_robust_damaged_open_reproducers). Other mutations are checked the same way.
    """
    _open_cases(_fixture_bytes(fixture_pdf, name), name, SHORT_MUTATIONS)


@pytest.mark.parametrize("name", FIXTURES)
def test_fuzz_open_truncated_fixtures_short(web: None, fixture_pdf: Any, name: str) -> None:
    """Reproduce one case: the first N bytes of the fixture, opened with session.open.

    Regression: text_multipage cut to 51 bytes used to return INTERNAL; it is OPEN_FAILED now
    (see test_robust_damaged_open_reproducers). Other truncations are checked the same way.
    """
    data = _fixture_bytes(fixture_pdf, name)
    _truncation_cases(data, name, max(1, len(data) // SHORT_TRUNCATIONS))


@pytest.mark.slow
@pytest.mark.parametrize("name", FIXTURES)
def test_fuzz_open_mutated_fixtures_long(web: None, fixture_pdf: Any, name: str) -> None:
    """The nightly run: LONG_MUTATIONS seeded mutations per fixture (about 1000 in all)."""
    _open_cases(_fixture_bytes(fixture_pdf, name), name, LONG_MUTATIONS)


@pytest.mark.slow
@pytest.mark.parametrize("name", FIXTURES)
def test_fuzz_open_truncated_fixtures_long(web: None, fixture_pdf: Any, name: str) -> None:
    """Truncation at every third byte offset of each fixture."""
    _truncation_cases(_fixture_bytes(fixture_pdf, name), name, LONG_TRUNCATION_STEP)


# (b) Envelopes. Each entry is one request text; the labels are the entries themselves.
MALFORMED_ENVELOPES: tuple[str, ...] = (
    "",
    "{",
    "[",
    "null",
    "true",
    "42",
    '"text"',
    "[]",
    "{}",
    '{"v":1,"id":1,"method":"hello"}',
    '{"v":1,"id":1,"method":"hello","params":{},"extra":1}',
    '{"v":"1","id":1,"method":"hello","params":{}}',
    '{"v":1.0,"id":1,"method":"hello","params":{}}',
    '{"v":1,"id":1.5,"method":"hello","params":{}}',
    '{"v":1,"id":true,"method":"hello","params":{}}',
    '{"v":1,"id":9007199254740993,"method":"hello","params":{}}',
    '{"v":1,"id":-9223372036854775808,"method":"hello","params":{}}',
    '{"v":1,"id":1,"method":7,"params":{}}',
    '{"v":1,"id":1,"method":"no.such","params":{}}',
    '{"v":1,"id":1,"method":"hello","params":[]}',
    '{"v":1,"id":1,"method":"hello","params":null}',
    '{"v":1,"id":1,"method":"hello","params":"x"}',
    '{"v":1,"id":1,"method":"session.open","params":{"name":"a","data":{"$bin":0},"password":null}}',
    '{"v":1,"id":1,"method":"session.open","params":{"name":"a","data":{"$bin":-1},"password":null}}',
    '{"v":1,"id":1,"method":"session.open","params":{"name":"a","data":"AAAA","password":null}}',
    '{"v":1,"id":1,"method":"render.page","params":{"handle":"x","page":9223372036854775807,'
    '"revision":0,"scale_milli":1,"rotation":0,"annotations":false}}',
    '{"v":1,"id":1,"method":"render.page","params":{"handle":"x","page":1e308,"revision":0,'
    '"scale_milli":1,"rotation":0,"annotations":false}}',
    '{"v":1,"id":1,"method":"hello","params":{"x":NaN}}',
    '{"v":1,"id":1,"method":"hello","params":{"x":Infinity}}',
    '{"v":1,"id":1,"method":"hello","params":{"x":-Infinity}}',
    '{"v":1,"id":1,"method":"hello","params":{"x":1e999}}',
    '{"v":1,"id":1,"method":"hello","params":{"a":"\\ud800"}}',
    '{"v":1,"id":1,"method":"hello","params":{}} trailing',
    '{"v":1,"id":1,"method":"hello","params":' + '{"a":' * 50000 + "1" + "}" * 50000 + "}",
    '{"v":1,"id":1,"method":"hello","params":{"x":' + "[" * 100000 + "]" * 100000 + "}}",
    "[" * 100000,
    '{"v":1,"id":1,"method":"hello","params":{}}' + " " * 1_000_000,
    '{"v":1,"id":1,"method":"' + "a" * 1_000_000 + '","params":{}}',
)

_KEYS = (
    "handle", "page", "revision", "scale_milli", "rotation", "annotations", "name", "data",
    "password", "mode", "params", "x", "$bin", "v", "id", "method", "tile_x", "tile_y",
    "tile_px", "budget_ms", "start", "query", "pages", "targets", "kind", "label", "offset",
    "limit", "job", "undo",
)  # fmt: skip
_SCALARS: tuple[Any, ...] = (
    None, True, False, 0, -1, 1, 255, 256000, 256001, 2**53, 2**53 - 1, 2**53 + 1, 2**63,
    -(2**63), 10**30, 0.5, -0.0, 1e308, float("nan"), "", "x" * 100, "\u0000", "\ud800",
    "0" * 32, "$bin", "render.page", "hello", {"$bin": 0}, {"$bin": 99}, {"$bin": "0"},
)  # fmt: skip


def _random_value(rng: random.Random, depth: int) -> Any:
    if depth <= 0 or rng.random() < 0.6:
        return rng.choice(_SCALARS)
    if rng.random() < 0.5:
        return [_random_value(rng, depth - 1) for _ in range(rng.randint(0, 4))]
    return {rng.choice(_KEYS): _random_value(rng, depth - 1) for _ in range(rng.randint(0, 5))}


def _random_envelope(rng: random.Random) -> str:
    """A request text with random fields, and sometimes the right shape for a method."""
    method = rng.choice([*METHODS, "no.such", 3, None])
    params: Any = _random_value(rng, 3)
    if isinstance(method, str) and method in METHODS and rng.random() < 0.7:
        params = {
            key: _random_value(rng, 1) for key in rng.sample(_KEYS, rng.randint(0, 6))
        }  # fmt: skip
    envelope = {
        "v": rng.choice([1, 1, 1, 1, 2, "1", None]),
        "id": rng.choice([1, 0, -1, 2**53 - 1, 2**60, "1", None, True]),
        "method": method,
        "params": params,
    }
    if rng.random() < 0.05:
        envelope["extra"] = _random_value(rng, 2)
    return json.dumps(envelope)  # NaN and Infinity are emitted here and rejected on load


def _dispatch_text(text: str, buffers: list[bytes], label: str) -> dict[str, Any]:
    reply_json, out = run_bounded(lambda: dispatch(text, buffers))
    assert all(isinstance(b, bytes) for b in out), label
    return check_reply(reply_json, label)


@pytest.mark.parametrize("text", MALFORMED_ENVELOPES, ids=range(len(MALFORMED_ENVELOPES)))
def test_fuzz_dispatch_malformed_envelopes(web: None, text: str) -> None:
    """Reproduce one case: the envelope text at the given index of MALFORMED_ENVELOPES.

    Each must reply with ok false and a W1.2 code (or ok true); deep nesting and long inputs
    are included because a parser recursion error would show up as INTERNAL here."""
    _dispatch_text(text, [], f"malformed envelope #{text[:60]!r}")


def test_fuzz_dispatch_random_envelopes_short(web: None) -> None:
    """Random envelopes from a fixed seed, with random params for every method."""
    rng = random.Random("w84:envelopes")
    for index in range(SHORT_ENVELOPES):
        text = _random_envelope(rng)
        buffers = [rng.randbytes(rng.randint(0, 64)) for _ in range(rng.randint(0, 2))]
        _dispatch_text(text, buffers, f"random envelope {index} of random.Random('w84:envelopes')")


@pytest.mark.slow
def test_fuzz_dispatch_random_envelopes_long(web: None) -> None:
    rng = random.Random("w84:envelopes")
    for index in range(LONG_ENVELOPES):
        text = _random_envelope(rng)
        buffers = [rng.randbytes(rng.randint(0, 64)) for _ in range(rng.randint(0, 2))]
        _dispatch_text(text, buffers, f"random envelope {index} of random.Random('w84:envelopes')")


# (c) Handles, page indexes and scales through the render and text calls.
PAGE_CHOICES: tuple[Any, ...] = (
    -1, -(2**53), 0, 1, 2**31, 2**53 - 1, 2**63, 1.5, 0.0, True, "0", None, [0],
)  # fmt: skip
SCALE_CHOICES: tuple[Any, ...] = (
    -5, 0, 1, 96, 1000, 6000, 96000, 255999, 256000, 256001, 2**31, 1.0, "1000", None,
)  # fmt: skip
ROTATION_CHOICES: tuple[Any, ...] = (0, 90, 180, 270, 45, -90, 360, None, True)
REVISION_CHOICES: tuple[Any, ...] = (0, 1, -1, 2**40, None)


def _open_valid(name: str, fixture_pdf: Any) -> tuple[str, int]:
    request = json.dumps(
        {
            "v": 1,
            "id": 1,
            "method": "session.open",
            "params": {"name": "a.pdf", "data": {"$bin": 0}, "password": None},
        }
    )
    reply_json, _ = dispatch(request, [_fixture_bytes(fixture_pdf, name)])
    reply = check_reply(reply_json, f"open {name} for the render cases")
    assert reply["ok"] is True, reply
    return str(reply["result"]["handle"]), int(reply["result"]["pages"])


def _page_call(method: str, params: dict[str, Any], label: str) -> None:
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, _ = run_bounded(lambda: dispatch(request, []))
    check_reply(reply_json, label)


def _render_params(rng: random.Random, handles: list[str], pages: int, **fixed: Any) -> dict:
    page_choices = (*PAGE_CHOICES, pages - 1, pages, pages + 1)
    params: dict[str, Any] = {
        "handle": rng.choice(handles),
        "page": rng.choice(page_choices),
        "revision": rng.choice(REVISION_CHOICES),
        "scale_milli": rng.choice(SCALE_CHOICES),
        "rotation": rng.choice(ROTATION_CHOICES),
        "annotations": rng.choice([True, False, 1, None]),
    }
    params.update(fixed)
    return params


def _grid_handles(valid: str) -> list[str]:
    return [valid, "", "00" * 16, "x" * 4096, valid + "0", "../" + valid, valid.upper()]


def test_robust_render_page_arguments_grid(web: None, fixture_pdf: Any) -> None:
    """Every page index x scale on a valid handle, then the handle choices with fixed args.

    Replies are either a success or a clean code: a huge scale is RENDER_TOO_LARGE before
    MuPDF draws, a bad page is INVALID_ARGS, and a bad handle is NO_DOCUMENT."""
    handle, pages = _open_valid("rotated_pages", fixture_pdf)
    try:
        for page in (*PAGE_CHOICES, pages - 1, pages):
            for scale in SCALE_CHOICES:
                params = {
                    "handle": handle, "page": page, "revision": 0, "scale_milli": scale,
                    "rotation": 0, "annotations": False,
                }  # fmt: skip
                _page_call("render.page", params, f"render.page page={page!r} scale={scale!r}")
        for bad in _grid_handles(handle):
            params = {
                "handle": bad, "page": 0, "revision": 0, "scale_milli": 1000,
                "rotation": 0, "annotations": False,
            }  # fmt: skip
            _page_call("render.page", params, f"render.page handle={bad[:40]!r}")
    finally:
        REGISTRY.close(handle)


def test_robust_render_tile_and_text_layer_arguments_grid(web: None, fixture_pdf: Any) -> None:
    """Page indexes and handles through text.layer, and tile indexes through render.tile."""
    handle, pages = _open_valid("text_multipage", fixture_pdf)
    try:
        for page in (*PAGE_CHOICES, pages - 1, pages):
            _page_call("text.layer", {"handle": handle, "page": page}, f"text.layer page={page!r}")
        for bad in _grid_handles(handle):
            _page_call("text.layer", {"handle": bad, "page": 0}, "text.layer bad handle")
        for tile_x in (-1, 0, 1, 2**31, 2**53 - 1, 1.5):
            for tile_y in (-1, 0, 2**31):
                params = {
                    "handle": handle, "page": 0, "revision": 0, "scale_milli": 1000,
                    "rotation": 0, "annotations": False, "tile_x": tile_x, "tile_y": tile_y,
                    "tile_px": 256,
                }  # fmt: skip
                _page_call("render.tile", params, f"render.tile x={tile_x!r} y={tile_y!r}")
    finally:
        REGISTRY.close(handle)


def test_robust_render_and_text_random_arguments_short(web: None, fixture_pdf: Any) -> None:
    _robust_random_render_and_text(fixture_pdf, SHORT_GRID_RANDOM, "w84:grid")


@pytest.mark.slow
def test_robust_render_and_text_random_arguments_long(web: None, fixture_pdf: Any) -> None:
    _robust_random_render_and_text(fixture_pdf, LONG_GRID_RANDOM, "w84:grid")


def _robust_random_render_and_text(fixture_pdf: Any, count: int, seed: str) -> None:
    handle, pages = _open_valid("text_multipage", fixture_pdf)
    rng = random.Random(seed)
    try:
        for index in range(count):
            label = f"random render/text case {index} of random.Random({seed!r})"
            handles = _grid_handles(handle)
            if rng.random() < 0.5:
                _page_call("render.page", _render_params(rng, handles, pages), label)
            else:
                params = {"handle": rng.choice(handles), "page": rng.choice(PAGE_CHOICES)}
                _page_call("text.layer", params, label)
    finally:
        REGISTRY.close(handle)


def test_robust_damaged_open_reproducers(web: None, fixture_pdf: Any) -> None:
    """Regression for two damaged files that used to open as INTERNAL instead of OPEN_FAILED.

    1. text_multipage.pdf cut to its first 51 bytes: the engine accepted it, then the catalog
       read failed with pymupdf's ValueError "bad xref".
    2. outline with mutate(bytes, random.Random('w84:outline:1')) (245 bytes): the page count
       failed with RuntimeError "code=7: Invalid number of pages" while the document opened.
    Both must give OPEN_FAILED through session.open. The desktop open does not read the catalog,
    so it still opens these files; only the web open, which reads the document info, fails.
    """

    truncated = _fixture_bytes(fixture_pdf, "text_multipage")[:51]
    damaged = mutate(_fixture_bytes(fixture_pdf, "outline"), random.Random("w84:outline:1"))
    for data in (truncated, damaged):
        request = json.dumps(
            {
                "v": 1,
                "id": 1,
                "method": "session.open",
                "params": {"name": "case.pdf", "data": {"$bin": 0}, "password": None},
            }
        )
        reply_json, _ = run_bounded(functools.partial(dispatch, request, [data]))
        reply = check_reply(reply_json, "damaged open reproducer")
        assert reply["ok"] is False, reply
        assert reply["error"]["code"] == OPEN_FAILED, reply


def test_robust_fifty_thousand_levels_refused_before_parsing(web: None) -> None:
    """Regression: 50,000 nested levels overflowed the wasm stack in json.loads under Pyodide,
    which is fatal. The depth scan refuses them first, with INVALID_REQUEST, and nothing raises.

    Reproducer: '{"v":1,"id":1,"method":"hello","params":{"x":' + '[' * 50000 + ']' * 50000 + '}}'
    """
    text = '{"v":1,"id":1,"method":"hello","params":{"x":' + "[" * 50000 + "]" * 50000 + "}}"
    reply_json, _ = run_bounded(functools.partial(dispatch, text, []))
    reply = check_reply(reply_json, "50,000 levels")
    assert reply["ok"] is False, reply
    assert reply["error"]["code"] == INVALID_REQUEST, reply


def test_robust_200_levels_still_parse(web: None) -> None:
    """A 200-level request (under MAX_JSON_DEPTH) is parsed: it reaches the params check and
    fails there as an unknown field, not as a JSON or depth error."""
    text = '{"v":1,"id":1,"method":"hello","params":{"x":' + "[" * 200 + "]" * 200 + "}}"
    reply_json, _ = run_bounded(functools.partial(dispatch, text, []))
    reply = check_reply(reply_json, "200 levels")
    assert reply["ok"] is False, reply
    assert reply["error"]["code"] == INVALID_ARGS, reply
    assert reply["error"]["message"] == "params.x: unknown field", reply
