"""Run an action from a Qt slot without letting its errors escape into the event loop.

A ``Busy`` action is silent: the document's BLOCKED event already told the user. Any other
``ActionError`` (a locked comment, a comment deleted since a menu was built) is logged and, when
the call site has a window to show it in, passed to ``notify``. Either way the caller gets
``None`` and does nothing else.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TypeVar

from pdfeditor.actions.base import ActionError, ActionResult, Busy

T = TypeVar("T")

log = logging.getLogger(__name__)


def run_action(
    fn: Callable[[], ActionResult[T]], notify: Callable[[str], object] | None = None
) -> ActionResult[T] | None:
    try:
        return fn()
    except Busy:
        return None
    except ActionError as exc:
        log.warning("action refused: %s", exc)
        if notify is not None:
            notify(str(exc))
        return None
