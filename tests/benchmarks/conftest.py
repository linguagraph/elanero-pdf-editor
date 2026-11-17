"""Benchmarks run serially: the wall-clock budgets need an idle machine.

Under ``pytest -n`` the other workers load the CPU, so the budget tests in ``test_ui_budgets``
would be flaky. They are skipped there and still run in the default serial run. The functional
benchmark smoke tests in ``test_benchmarks`` run either way (``--benchmark-disable``).
"""

from __future__ import annotations

import pytest


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    # Workers (``workerinput``) run with the option cleared, so check both.
    under_xdist = hasattr(config, "workerinput") or config.getoption("numprocesses", None)
    if not under_xdist:
        return
    skip = pytest.mark.skip(reason="timing budgets need an idle machine: run serially")
    for item in items:
        if item.path.name == "test_ui_budgets.py":
            item.add_marker(skip)
