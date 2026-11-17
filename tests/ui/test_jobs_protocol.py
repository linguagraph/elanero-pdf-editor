"""The desktop's Job and the web's InlineJob both satisfy the Qt-free JobContext protocol."""

from __future__ import annotations

import pytest

from pdfeditor.core.inline_jobs import InlineJob
from pdfeditor.core.jobs import JobContext
from pdfeditor.ui.jobs import Job

pytestmark = pytest.mark.gui


def test_desktop_job_satisfies_job_context() -> None:
    assert isinstance(Job(lambda job: None), JobContext)


def test_inline_job_satisfies_job_context() -> None:
    assert isinstance(InlineJob(), JobContext)
