"""Comment actions (``annotations.*``): W2.1 slice (b).

``annotations.flatten`` lives in ``document.py`` (slice (d)). The module isn't named
``annotations.py``: that name clashes with ``from __future__ import annotations`` in every module
that imports it.

Empty until that slice lands; imported by the package so the slices don't all edit
``__init__.py``. See docs/web/design/W1.3.md.
"""
