"""Property tests (hypothesis) for the content-stream writer and parser.

Kept apart from test_contentstream.py: hypothesis is not in the Pyodide package set, so this
module is desktop-only and the web run never imports it. Example-based tests stay in
test_contentstream.py.
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from pdfeditor.engine.contentstream.parser import HexString, Name, Operation, parse, write

pytestmark = pytest.mark.desktop_only


names = st.text(
    alphabet=st.characters(min_codepoint=33, max_codepoint=255), min_size=1, max_size=8
).map(Name)
numbers = st.one_of(
    st.integers(-(10**6), 10**6), st.floats(-1e5, 1e5, allow_nan=False).map(lambda f: round(f, 4))
)
scalars = st.one_of(
    numbers,
    st.booleans(),
    st.none(),
    names,
    st.binary(max_size=12),
    st.binary(max_size=8).map(HexString),
)
operands = st.recursive(
    scalars,
    lambda inner: st.one_of(
        st.lists(inner, max_size=4),
        st.dictionaries(names, inner, max_size=3),
    ),
    max_leaves=10,
)
operators = st.sampled_from(
    ["q", "Q", "cm", "Tj", "TJ", "re", "f", "Do", "BDC", "gs", "d", "Tf", "'", '"']
)
operations = st.builds(Operation, operators, st.lists(operands, max_size=5))


@settings(max_examples=300, deadline=None)
@given(st.lists(operations, max_size=20))
def test_write_parse_roundtrip(ops: list[Operation]) -> None:
    assert parse(write(ops)) == ops
