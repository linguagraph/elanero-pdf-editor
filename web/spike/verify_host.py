"""Host-side check of the browser smoke output (W0.1). Normal CPython with pikepdf and pypdfium2.

The round-trip rule across the boundary: the file the browser saved must open in pikepdf (an
independent parser), render in pypdfium2 (an independent renderer), and carry the edited text and
the highlight. Writes a JSON report and exits 1 if any check fails.

    python verify_host.py out/smoke.pdf out/host-verify.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium

EDITED = "Elanero web smoke"


def verify(pdf_path: Path) -> dict[str, object]:
    checks: dict[str, bool] = {}
    with pikepdf.open(pdf_path) as pdf:
        checks["pikepdf_opens"] = len(pdf.pages) >= 1
        page = pdf.pages[0]
        annots = page.obj.get(pikepdf.Name.Annots, [])
        subtypes = [str(annot.get(pikepdf.Name.Subtype)) for annot in annots]
        checks["pikepdf_highlight_annotation"] = "/Highlight" in subtypes

    document = pdfium.PdfDocument(str(pdf_path))
    page = document[0]
    text = page.get_textpage().get_text_range()
    checks["pdfium_edited_text"] = EDITED in text
    gray = page.render(scale=1).to_pil().convert("L")
    low, _high = gray.getextrema()
    checks["pdfium_render_nonblank"] = low < 250
    document.close()

    return {
        "file": pdf_path.name,
        "checks": checks,
        "pdfiumTextSample": text[:120],
        "ok": all(checks.values()),
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: verify_host.py <smoke.pdf> <report.json>", file=sys.stderr)
        return 2
    report = verify(Path(argv[1]))
    Path(argv[2]).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report["checks"], indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
