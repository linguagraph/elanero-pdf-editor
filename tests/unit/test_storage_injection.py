"""Injected storage for the web (W2.3): the data root, the undo snapshot budget and the font
folders. Each default must behave exactly as before when nothing is injected."""

from __future__ import annotations

import shutil
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from pdfeditor.core import paths
from pdfeditor.core.commands.snapshot import SnapshotCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.metadata import Metadata
from pdfeditor.services.fonts import FontCatalog

FONT = (
    Path(__file__).parent.parent / "fixtures" / "generated" / "fonts" / "TestCyrillic-Regular.ttf"
)


@pytest.fixture(autouse=True)
def _restore_data_root() -> Iterator[None]:
    yield
    paths.set_data_root(None)


# -- section 2: the data root ---------------------------------------------------------------


def test_injected_root_is_used_and_recovery_follows(tmp_path: Path) -> None:
    root = tmp_path / "web-root"
    paths.set_data_root(root)
    assert paths.data_dir() == root
    assert root.is_dir()
    assert paths.recovery_dir() == root / "recovery"


def test_injected_root_beats_the_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PDFEDITOR_DATA_DIR", str(tmp_path / "env"))
    paths.set_data_root(tmp_path / "injected")
    assert paths.data_dir() == tmp_path / "injected"


def test_clearing_the_root_restores_the_environment_rules(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PDFEDITOR_DATA_DIR", str(tmp_path / "env"))
    paths.set_data_root(tmp_path / "injected")
    paths.set_data_root(None)
    assert paths.data_dir() == tmp_path / "env"


def test_environment_rules_apply_when_nothing_is_injected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PDFEDITOR_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    assert paths.data_dir() == tmp_path / "local" / "pdfeditor"


# -- section 3: the snapshot budget ----------------------------------------------------------


def _edit(session: DocumentSession, index: int) -> SnapshotCommand:
    title = f"v{index}"
    command = SnapshotCommand(
        f"Edit {index}",
        lambda doc: doc.set_metadata(Metadata(title=title)),
        session.snapshots,
    )
    assert session.execute(command)
    return command


def _title(session: DocumentSession) -> str:
    return session.document.metadata().title


def test_budget_drops_the_oldest_commands_in_order(
    fixture_pdf: Callable[[str], Path],
) -> None:
    probe = DocumentSession.open(fixture_pdf("text_multipage"))
    size = _edit(probe, 0).disk_bytes
    probe.close()

    session = DocumentSession.open(fixture_pdf("text_multipage"), snapshot_budget=int(size * 3.5))
    for index in range(6):
        _edit(session, index)
    stack = session.undo_stack
    assert len(stack) == 3
    assert stack.dropped == 3
    assert stack.undo_label == "Edit 5"
    assert _title(session) == "v5"

    # Undo the three kept edits: the state goes back to before "Edit 3", and nothing older
    # can be undone any more.
    for _ in range(3):
        assert session.undo()
    assert _title(session) == "v2"
    assert not stack.can_undo
    for _ in range(3):
        assert session.redo()
    assert _title(session) == "v5"
    session.close()


def test_history_shortened_turns_on_at_the_first_drop_and_clear_resets_it(
    fixture_pdf: Callable[[str], Path],
) -> None:
    session = DocumentSession.open(fixture_pdf("text_multipage"), snapshot_budget=1)
    _edit(session, 0)
    assert session.undo_stack.history_shortened is False
    assert session.undo_stack.dropped == 0
    _edit(session, 1)
    assert session.undo_stack.history_shortened is True
    assert session.undo_stack.dropped == 1
    session.undo_stack.clear()
    assert session.undo_stack.history_shortened is False
    assert session.undo_stack.dropped == 0
    session.close()


def test_one_command_larger_than_the_budget_is_kept(
    fixture_pdf: Callable[[str], Path],
) -> None:
    session = DocumentSession.open(fixture_pdf("text_multipage"), snapshot_budget=1)
    original = _title(session)
    _edit(session, 0)
    assert len(session.undo_stack) == 1
    assert session.undo_stack.history_shortened is False
    assert session.undo()
    assert _title(session) == original
    session.close()


def test_default_budget_is_the_desktop_budget(fixture_pdf: Callable[[str], Path]) -> None:
    session = DocumentSession.open(fixture_pdf("text_multipage"))
    assert session.undo_stack.max_disk_bytes == 2 * 1024**3
    session.close()


def test_web_budget_constant() -> None:
    from pdfeditor.core.commands.snapshot import WEB_SNAPSHOT_BUDGET

    assert WEB_SNAPSHOT_BUDGET == 512 * 1024**2


# -- section 5: injected font folders --------------------------------------------------------


def test_folders_are_scanned_and_nothing_else(tmp_path: Path) -> None:
    folder = tmp_path / "uploads"
    folder.mkdir()
    shutil.copyfile(FONT, folder / FONT.name)
    catalog = FontCatalog(folders=[folder], cache_path=tmp_path / "fonts.json")
    catalog.scan()
    faces = catalog.faces()
    assert faces
    assert {Path(face.path).parent for face in faces} == {folder}


def test_empty_folder_list_scans_nothing(tmp_path: Path) -> None:
    catalog = FontCatalog(folders=[], cache_path=tmp_path / "fonts.json")
    catalog.scan()
    assert catalog.faces() == []


def test_explicit_dirs_override_the_constructor_folders(tmp_path: Path) -> None:
    upload = tmp_path / "uploads"
    upload.mkdir()
    shutil.copyfile(FONT, upload / FONT.name)
    empty = tmp_path / "empty"
    empty.mkdir()
    catalog = FontCatalog(folders=[empty], cache_path=tmp_path / "fonts.json")
    catalog.scan(dirs=[upload])
    assert catalog.faces()


def test_cache_path_is_used_when_given(tmp_path: Path) -> None:
    folder = tmp_path / "uploads"
    folder.mkdir()
    shutil.copyfile(FONT, folder / FONT.name)
    cache = tmp_path / "cache" / "fonts.json"
    cache.parent.mkdir()
    FontCatalog(folders=[folder], cache_path=cache).scan()
    assert cache.is_file()
