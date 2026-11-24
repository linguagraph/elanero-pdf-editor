"""Performance budgets for the modern UI (Phase U11), headless like CI.

Each figure is the median of several runs, compared with a cap well above the value measured
on a developer machine (Windows 11, offscreen), so a slow CI runner passes while a real
regression (a pixmap per page again, a style sheet applied per widget, ...) does not.
Run them with:  QT_QPA_PLATFORM=offscreen pytest tests/benchmarks/test_ui_budgets.py -s
"""

from __future__ import annotations

import os
import shutil
import statistics
import time
from collections.abc import Callable, Iterator

import pytest
from PySide6.QtCore import QEvent, QObject
from PySide6.QtWidgets import QApplication, QWidget

from pdfeditor.core.commands.document_cmds import SetMetadataCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.metadata import Metadata
from pdfeditor.ui.main_window import MainWindow
from pdfeditor.ui.theme import Theme, apply_theme
from tests.perf.table import enforced, limit_ms, metric
from tests.ui.conftest import isolated_settings, no_animations  # noqa: F401 - autouse here too

pytestmark = [pytest.mark.slow, pytest.mark.gui, pytest.mark.desktop_only]

# The limits (ms, about 2.5x the baseline) live in tests/perf/budgets.json, the one table that
# the web budgets share. PDFEDITOR_PERF_FACTOR scales them all for a known-slow machine.
FACTOR = float(os.environ.get("PDFEDITOR_PERF_FACTOR", "1"))
RUNS = 5
SAVE_RUNS = 3  # D5: median of 3 timed saves, after one warm-up


def _budget_ms(metric_id: str) -> float:
    return limit_ms(metric_id) * FACTOR


class _PaintWatch(QObject):
    """Notes when ``widget`` receives its first paint event."""

    def __init__(self, widget: QWidget) -> None:
        super().__init__()
        self.painted = False
        widget.installEventFilter(self)

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if event.type() == QEvent.Type.Paint:
            self.painted = True
        return False


def _pump_until(done: Callable[[], bool], timeout_s: float = 10.0) -> None:
    deadline = time.perf_counter() + timeout_s
    while not done():
        QApplication.processEvents()
        assert time.perf_counter() < deadline, "timed out"
    QApplication.processEvents()  # the rest of this paint pass


def _check(
    perf: Callable[[str, list[float]], float], metric_id: str, name: str, samples: list[float]
) -> float:
    """Record the samples under ``metric_id`` (seconds) and return the median in ms."""
    budget = _budget_ms(metric_id)
    median = perf(metric_id, samples)
    row = metric(metric_id)
    if not row["enforce"]:
        note = " (trend only, not asserted)"
    elif row["baseline_ms"] is None:
        # Someone flipped enforce on before a baseline was recorded: say so in the run log.
        note = " PROVISIONAL limit, no baseline"
    else:
        note = ""
    print(
        f"\n{name}: median {median:.1f} ms (min {min(samples) * 1000:.1f}), budget {budget}{note}"
    )
    return median


def _flush_deletes() -> None:
    """Delete closed widgets now: every live widget is repolished on a theme switch."""
    QApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
    QApplication.processEvents()


@pytest.fixture
def windows() -> Iterator[list[MainWindow]]:
    _flush_deletes()
    made: list[MainWindow] = []
    yield made
    for w in made:
        for view in w.views():
            view.session.undo_stack.set_clean()
        w.close()
        w.deleteLater()
    _flush_deletes()


def _new_window(windows: list[MainWindow]) -> MainWindow:
    w = MainWindow()
    windows.append(w)
    w.resize(1280, 800)
    return w


def test_window_first_paint(qtbot, windows: list[MainWindow], perf) -> None:
    _new_window(windows).close()  # first window pays one-off imports, icon and font caches
    samples = []
    for _ in range(RUNS):
        start = time.perf_counter()
        w = _new_window(windows)
        watch = _PaintWatch(w)
        w.show()
        _pump_until(lambda watch=watch: watch.painted)
        samples.append(time.perf_counter() - start)
        w.close()
    median = _check(perf, "D1", "window first paint", samples)
    assert median < _budget_ms("D1")


def test_large_document_first_paint(qtbot, windows: list[MainWindow], fixture_pdf, perf) -> None:
    w = _new_window(windows)
    w.show()
    qtbot.waitExposed(w)
    path = fixture_pdf("large_1000")
    samples = []
    for _ in range(RUNS):
        start = time.perf_counter()
        view = w.open_path(path)
        assert view is not None
        watch = _PaintWatch(view.viewport())
        _pump_until(lambda watch=watch: watch.painted)
        samples.append(time.perf_counter() - start)
        w.renderer.wait_idle(5000)
        view.session.undo_stack.set_clean()
        w.close_current()
        QApplication.processEvents()
    median = _check(perf, "D2", "1000-page document first paint", samples)
    assert median < _budget_ms("D2")


def test_scrolling_1000_pages_stays_above_60_fps(
    qtbot, windows: list[MainWindow], fixture_pdf, perf
) -> None:
    w = _new_window(windows)
    w.show()
    qtbot.waitExposed(w)
    view = w.open_path(fixture_pdf("large_1000"))
    assert view is not None
    w.renderer.wait_idle(5000)
    QApplication.processEvents()
    bar = view.verticalScrollBar()
    step = max(1, bar.maximum() // 300)  # 300 frames from the first page to the last
    medians = []
    for _ in range(3):
        frames = []
        for value in range(0, bar.maximum() + 1, step):
            start = time.perf_counter()
            bar.setValue(value)
            QApplication.processEvents()  # layout, tile requests and the repaint
            frames.append(time.perf_counter() - start)
        medians.append(statistics.median(frames))
        assert view.current_page >= 990
        bar.setValue(0)
        w.renderer.wait_idle(5000)
        QApplication.processEvents()
    w.renderer.wait_idle(5000)
    median = _check(perf, "D3", "scroll frame", medians)
    assert median < _budget_ms("D3")


def test_theme_switch(qtbot, windows: list[MainWindow], fixture_pdf, perf) -> None:
    w = _new_window(windows)
    w.show()
    qtbot.waitExposed(w)
    assert w.open_path(fixture_pdf("text_multipage")) is not None
    w.renderer.wait_idle(5000)
    app = QApplication.instance()
    assert isinstance(app, QApplication)
    samples = []
    try:
        for i in range(RUNS * 2):
            theme = Theme.DARK if i % 2 == 0 else Theme.LIGHT
            start = time.perf_counter()
            apply_theme(app, theme, "#0067c0")
            QApplication.processEvents()  # repolish and repaint
            samples.append(time.perf_counter() - start)
    finally:
        apply_theme(app, Theme.SYSTEM)
    median = _check(perf, "D4", "theme switch", samples)
    assert median < _budget_ms("D4")


def test_save_1000_pages_after_one_edit(tmp_path, fixture_pdf, perf) -> None:
    """D5: a full save (the non-signed path) of the 1000-page fixture after one undoable edit.

    The first save is a warm-up and is not timed. Each timed run works on its own copy, so every
    save writes the same document. Meant to show a save regression, not a slow runner.
    """
    source = fixture_pdf("perf_mixed_1000")
    samples: list[float] = []
    for i in range(SAVE_RUNS + 1):
        target = tmp_path / f"save_{i}.pdf"
        shutil.copyfile(source, target)
        session = DocumentSession.open(target)
        try:
            assert session.execute(SetMetadataCommand(Metadata(title=f"Save run {i}")))
            start = time.perf_counter()
            session.save()
            elapsed = time.perf_counter() - start
        finally:
            session.close()
        if i > 0:  # run 0 is the warm-up
            samples.append(elapsed)
    median = _check(perf, "D5", "save 1000 pages after one edit", samples)
    # Trend only until a Windows baseline is recorded (budgets.json, enforce): the samples above
    # still reach the nightly perf-results.json.
    if enforced("D5"):
        assert median < _budget_ms("D5")
