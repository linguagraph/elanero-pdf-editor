"""Startup speed: pywinrt (the Microsoft Store API) loads only when the Store build asks for it."""

from __future__ import annotations

import os
import subprocess
import sys


def test_main_window_import_does_not_load_winrt() -> None:
    code = (
        "import sys\n"
        "import pdfeditor.ui.main_window\n"
        "loaded = sorted(m for m in sys.modules if m == 'winrt' or m.startswith('winrt.'))\n"
        "print(loaded)\n"
        "sys.exit(1 if loaded else 0)\n"
    )
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen")
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env)
    assert done.returncode == 0, done.stdout + done.stderr


def test_store_service_import_does_not_load_winrt() -> None:
    code = (
        "import sys\n"
        "import pdfeditor.services.store_updates\n"
        "import pdfeditor.ui.store_updates\n"
        "loaded = sorted(m for m in sys.modules if m == 'winrt' or m.startswith('winrt.'))\n"
        "print(loaded)\n"
        "sys.exit(1 if loaded else 0)\n"
    )
    env = dict(os.environ, QT_QPA_PLATFORM="offscreen")
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env)
    assert done.returncode == 0, done.stdout + done.stderr
