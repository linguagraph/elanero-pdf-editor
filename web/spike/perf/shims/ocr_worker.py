"""W0.2 spike shim, never shipped. web_package.py leaves engine/mupdf/ocr_worker.py out (OCR is not
in the web build), but engine/mupdf/ocr.py imports it at module level, so the engine cannot be
imported without it. This stub keeps the import working; any use of it raises. It is added to the
measured zip by perf/shim_zip.py, so the size numbers include it (a few hundred bytes)."""


def __getattr__(name: str):
    raise RuntimeError("OCR is not available in the web build")
