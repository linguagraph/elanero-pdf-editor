# W0.4 part 2: the web set under Pyodide. Executed by run_audit.mjs inside the W0.1 runner.
#
# The Node side has put the web zip at /audit/pdfeditor-web.zip, the module list and the blocked
# packages at /audit/input.json, and the repo (fixtures only) at /repo. This file:
#   1. extracts the zip and refuses the blocked packages with an import hook, so an excluded
#      module can't be imported by accident (it isn't in the zip) and a blocked package fails
#      the same way it would on the web;
#   2. imports every web module, one interpreter, removing pdfeditor.* from sys.modules between
#      modules so one failure doesn't hide the next;
#   3. runs the functional checks, each calling our code. A failing check is a result, not a
#      crash: it is recorded with its exception and the line in our code where it raised.
# The last expression is the JSON result. Stdlib, PyMuPDF, Pillow and fontTools only.

import importlib
import importlib.abc
import io
import json
import os
import sys
import threading
import traceback
import zipfile
from pathlib import Path

ROOT = "/audit"
PKG_DIR = f"{ROOT}/pkg"
FIXTURES = "/repo/tests/fixtures/generated"
FONT = f"{FIXTURES}/fonts/TestSans-Regular.ttf"
PDF = f"{FIXTURES}/text_multipage.pdf"
WORK = f"{ROOT}/work"

os.environ["PDFEDITOR_DATA_DIR"] = f"{ROOT}/data"  # keep the font cache off the home folder
with open(f"{ROOT}/input.json", encoding="utf-8") as fh:
    INPUT = json.load(fh)
BLOCKED = set(INPUT["blocked"])

os.makedirs(PKG_DIR, exist_ok=True)
with zipfile.ZipFile(f"{ROOT}/pdfeditor-web.zip") as zf:
    zf.extractall(PKG_DIR)

# Pass 1 runs the web set as it is. Pass 2 (PATCH_PASS, set by run_audit.mjs) first applies the
# known blocker to this audit's own copy, so the layers behind it get measured too. It never
# touches src/. Each replacement must match exactly once, or the harness fails.
PATCHES = [
    (
        "pdfeditor/engine/mupdf/ocr.py",
        "from pdfeditor.engine.mupdf import ocr_worker\n",
        "",
    ),
    (
        "pdfeditor/engine/mupdf/ocr.py",
        "        data = ocr_worker.recognize(",
        "        from pdfeditor.engine.mupdf import ocr_worker\n"
        "        data = ocr_worker.recognize(",
    ),
]


def apply_patches():
    applied = []
    for rel, old, new in PATCHES:
        path = Path(PKG_DIR) / rel
        text = path.read_text(encoding="utf-8")
        found = text.count(old)
        if found != 1:
            raise RuntimeError(f"patch for {rel} matches {found} times, expected 1")
        path.write_text(text.replace(old, new), encoding="utf-8")
        applied.append(f"{rel}: {old.strip()[:60]!r} -> {new.strip()[:60]!r}")
    return applied


PATCH_PASS = bool(globals().get("PATCH_PASS", False))
APPLIED = apply_patches() if PATCH_PASS else []
sys.path.insert(0, PKG_DIR)


class _BlockedOnWeb(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        top = fullname.split(".")[0]
        if top in BLOCKED:
            raise ImportError(f"blocked on web: {top}", name=top)
        return None


sys.meta_path.insert(0, _BlockedOnWeb())


def _where(exc):
    """The last frame in our package (the line that raised), or None."""
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename.startswith(PKG_DIR)]
    if not frames:
        return None
    last = frames[-1]
    return f"{last.filename[len(PKG_DIR) + 1 :]}:{last.lineno}"


def _describe(exc):
    lines = str(exc).strip().splitlines()
    message = lines[0][:300] if lines else ""
    return {"type": type(exc).__name__, "message": message, "where": _where(exc)}


def _category(exc):
    text = str(exc)
    if isinstance(exc, ImportError) and text.startswith("blocked on web"):
        return "blocked package"
    if isinstance(exc, ModuleNotFoundError):
        if (getattr(exc, "name", "") or "").startswith("pdfeditor"):
            return "excluded module (not in the web zip)"
        return "missing package"
    if isinstance(exc, ImportError):
        return "import error"
    return "exception at import"


def _purge():
    for name in list(sys.modules):
        if name == "pdfeditor" or name.startswith("pdfeditor."):
            del sys.modules[name]


def import_all():
    rows = []
    for name in INPUT["modules"]:
        _purge()
        try:
            importlib.import_module(name)
            rows.append({"module": name, "status": "ok"})
        except Exception as exc:  # every failure is a finding
            rows.append(
                {
                    "module": name,
                    "status": "fail",
                    "category": _category(exc),
                    "error": _describe(exc),
                }
            )
    _purge()
    return rows


# -- functional checks -----------------------------------------------------------------------
CHECKS = []


def check(check_id, group, title):
    def register(fn):
        CHECKS.append((check_id, group, title, fn))
        return fn

    return register


def _pdf_bytes():
    return Path(PDF).read_bytes()


def _open_doc():
    from pdfeditor.engine.registry import get_engine

    return get_engine().open(_pdf_bytes(), None)


def _png_jpeg():
    from PIL import Image

    out = {}
    for fmt in ("PNG", "JPEG"):
        buf = io.BytesIO()
        Image.new("RGB", (240, 140), (200, 40, 40)).save(buf, format=fmt)
        out[fmt] = buf.getvalue()
    return out


def _work(name):
    folder = Path(WORK) / name
    folder.mkdir(parents=True, exist_ok=True)
    return folder


# fonts ------------------------------------------------------------------------------------
@check("fonts.scan_folder", "fonts", "FontCatalog scans a folder with one TTF")
def _():
    from pdfeditor.core.jobs import CancelToken
    from pdfeditor.services.fonts import FontCatalog

    folder = _work("fonts")
    (folder / "TestSans-Regular.ttf").write_bytes(Path(FONT).read_bytes())
    ticks = []
    catalog = FontCatalog()
    catalog.scan([folder], CancelToken(), lambda done, total: ticks.append(done))
    return {"faces": len(catalog.faces()), "families": catalog.families(), "progress": len(ticks)}


@check("fonts.validate", "fonts", "read_faces validates the TTF (fontTools)")
def _():
    from pdfeditor.services.fonts import read_faces

    faces = read_faces(Path(FONT))
    return {"faces": [[f.family, f.weight, f.italic] for f in faces]}


@check("fonts.embed_and_subset", "fonts", "Embed an installed font, then subset (editing path)")
def _():
    from pdfeditor.engine.base import OptimizeOptions, SaveOptions
    from pdfeditor.model.fonts import FontRef
    from pdfeditor.model.geometry import Point
    from pdfeditor.model.pages import TextStamp
    from pdfeditor.services.fonts import read_faces

    family = read_faces(Path(FONT))[0].family
    doc = _open_doc()
    before = len(doc.to_bytes(SaveOptions(garbage=3)))
    doc.page(0).stamp_text(
        TextStamp(
            "Subset check",
            Point(72, 120),
            font_size=18,
            font_ref=FontRef.file(FONT, 0, family),
        )
    )
    embedded = len(doc.to_bytes(SaveOptions(garbage=3)))
    doc.optimize(OptimizeOptions(subset_fonts=True))
    subset = len(doc.to_bytes(SaveOptions(garbage=3)))
    return {"bytesBefore": before, "bytesEmbedded": embedded, "bytesSubset": subset}


@check("fonts.system_dirs", "fonts", "system_font_dirs() on the web")
def _():
    from pdfeditor.services.fonts import system_font_dirs

    return {"dirs": [str(p) for p in system_font_dirs()]}


@check("fonts.cached_catalog", "fonts", "cached_catalog() loads the on-disk cache")
def _():
    from pdfeditor.services.fonts import cached_catalog

    return {"faces": len(cached_catalog().faces())}


# pillow -----------------------------------------------------------------------------------
@check("pillow.insert_images", "pillow", "Insert a PNG and a JPEG into a page (MuPDF path)")
def _():
    doc = _open_doc()
    images = _png_jpeg()
    for data in images.values():
        doc.insert_image_page(0, data)
    return {"formats": sorted(images), "pages": doc.page_count}


@check("pillow.stamp_opacity", "pillow", "Stamp a PNG and a JPEG with opacity (Pillow path)")
def _():
    from pdfeditor.model.geometry import Rect
    from pdfeditor.model.pages import ImageStamp

    doc = _open_doc()
    images = _png_jpeg()
    for data in images.values():
        doc.page(0).stamp_image(ImageStamp(data, Rect(72, 72, 300, 200), opacity=0.5))
    return {"stamped": len(images)}


@check("pillow.render_page", "pillow", "Render a page to PNG/JPEG/TIFF bytes (Pillow)")
def _():
    from pdfeditor.services.export.images import ImageFormat, PageImageOptions, export_pages

    doc = _open_doc()
    folder = _work("render")
    written = {}
    for fmt in ImageFormat:
        paths = export_pages(doc, [0], folder / "page", PageImageOptions(format=fmt))
        written[fmt.value] = [p.stat().st_size for p in paths]
    return written


@check("pillow.codecs", "pillow", "Which Pillow codecs this build has (TIFF, zlib, JPEG)")
def _():
    from PIL import features

    return {name: features.check(name) for name in ("libtiff", "zlib", "jpg", "freetype2")}


@check("pillow.scan_info", "pillow", "Scan detection on a page (Pillow ImageStat)")
def _():
    info = _open_doc().page(0).scan_info()
    return {"type": type(info).__name__}


# export (every exporter except services/export/office.py) ----------------------------------
def _export_text_check(fmt_name):
    def run():
        from pdfeditor.services.export import TextFormat, export_document

        fmt = TextFormat[fmt_name]
        doc = _open_doc()
        target = export_document(doc, [0, 1], _work("export") / f"doc-{fmt.value}", fmt)
        return {"file": target.name, "bytes": target.stat().st_size}

    return run


def _export_image_check(fmt_name):
    def run():
        from pdfeditor.services.export.images import ImageFormat, PageImageOptions, export_pages

        fmt = ImageFormat[fmt_name]
        paths = export_pages(
            _open_doc(), [0, 1], _work("export") / f"img-{fmt.value}", PageImageOptions(format=fmt)
        )
        return {"files": len(paths)}

    return run


def _register_exporters():
    from pdfeditor.services.export import TextFormat
    from pdfeditor.services.export.images import ImageFormat

    for fmt in TextFormat:
        CHECKS.append(
            (
                f"export.text.{fmt.value}",
                "export",
                f"export_document as {fmt.label}",
                _export_text_check(fmt.name),
            )
        )
    for fmt in ImageFormat:
        CHECKS.append(
            (
                f"export.images.{fmt.value}",
                "export",
                f"export_pages as {fmt.value.upper()}",
                _export_image_check(fmt.name),
            )
        )


@check("export.tables_xlsx", "export", "find_tables + tables_to_xlsx (ooxml writer)")
def _():
    from pdfeditor.engine.registry import get_engine
    from pdfeditor.services.export import find_tables, tables_to_xlsx

    doc = get_engine().open(Path(f"{FIXTURES}/report.pdf").read_bytes(), None)  # has a table
    tables = find_tables(doc, [0, 1])
    target = tables_to_xlsx(tables, _work("export") / "tables")
    return {"tables": len(tables), "bytes": target.stat().st_size}


@check("export.extract_images", "export", "extract_images from a page with an image")
def _():
    from pdfeditor.services.export.images import extract_images

    doc = _open_doc()
    doc.insert_image_page(0, _png_jpeg()["PNG"])
    written = extract_images(doc, _work("extract-images"))
    return {"files": len(written)}


@check("export.extract_fonts", "export", "extract_fonts (embedded font programs)")
def _():
    from pdfeditor.services.export.images import extract_fonts

    result = extract_fonts(_open_doc(), _work("extract-fonts"))
    return {
        "files": len(result.written),
        "skipped": result.not_embedded,
        "refused": result.refused,
    }


@check("export.office", "export", "services/export/office.py (excluded from the web)")
def _():
    return {"status": "not run: excluded set (decision 9)"}


# threads and jobs --------------------------------------------------------------------------
@check("threads.lock", "threads", "threading.Lock and RLock")
def _():
    lock = threading.Lock()
    with lock:
        pass
    rlock = threading.RLock()
    with rlock, rlock:
        pass
    return {"lock": "ok", "rlock": "ok"}


@check("threads.thread_start", "threads", "threading.Thread(...).start()")
def _():
    done = []
    thread = threading.Thread(target=lambda: done.append(1))
    thread.start()
    thread.join()
    return {"ran": bool(done)}


@check("threads.jobs", "threads", "core/jobs: cancel token and progress, run synchronously")
def _():
    from pdfeditor.core.jobs import Cancelled, CancelToken

    token = CancelToken()
    token.cancel()
    try:
        token.check()
    except Cancelled:
        return {"cancelled": True}
    raise AssertionError("cancel token did not raise")


@check("threads.render_cache", "threads", "core/render_cache: put, get, drop")
def _():
    from pdfeditor.core.render_cache import RenderCache, TileKey

    cache = RenderCache(max_bytes=1_000_000)
    key = TileKey(
        doc_id=1, page_index=0, revision=0, scale_milli=1000, rotation=0, tile_x=0, tile_y=0
    )
    cache.put(key, b"x" * 100, 100)
    hit = cache.get(key)
    cache.drop_document(1)
    return {"hit": hit == b"x" * 100, "after_drop": cache.get(key) is None}


@check("threads.engine_lock", "threads", "core/engine_lock: the process-wide lock and collect()")
def _():
    from pdfeditor.core.engine_lock import ENGINE_LOCK, collect

    with ENGINE_LOCK:
        freed = collect()
    return {"collected": freed}


# storage, secrets, autosave ----------------------------------------------------------------
@check("storage.snapshot", "storage", "SnapshotCommand do/undo/redo on a session")
def _():
    from pdfeditor.core.commands.snapshot import SnapshotCommand, SnapshotStore
    from pdfeditor.core.session import DocumentSession

    session = DocumentSession.open(Path(PDF))
    store = SnapshotStore(_work("undo"))
    command = SnapshotCommand("Rotate", lambda doc: doc.page(0).set_rotation(90), store)
    session.execute(command)
    after_do = session.document.page(0).rotation
    session.undo()
    after_undo = session.document.page(0).rotation
    session.redo()
    after_redo = session.document.page(0).rotation
    session.close()
    return {"do": after_do, "undo": after_undo, "redo": after_redo}


@check("storage.autosave", "storage", "RecoveryStore save, list and discard")
def _():
    from pdfeditor.core.autosave import RecoveryStore
    from pdfeditor.core.session import DocumentSession

    session = DocumentSession.open(Path(PDF))
    store = RecoveryStore(_work("recovery"))
    saved = store.save(session)
    entries = store.entries(include_running=True)
    store.discard(session.uid)
    session.close()
    return {"saved": saved.name, "entries": len(entries)}


@check("storage.data_dir_default", "storage", "core/paths.data_dir() with no overrides")
def _():
    from pdfeditor.core.paths import data_dir

    saved = os.environ.pop("PDFEDITOR_DATA_DIR", None)
    try:
        return {"dir": str(data_dir()), "home": str(Path.home())}
    finally:
        if saved is not None:
            os.environ["PDFEDITOR_DATA_DIR"] = saved


@check("storage.data_path", "storage", "bundle.data_path() reads a bundled file")
def _():
    from pdfeditor.bundle import data_path

    text = data_path("branding", "elanero", "README.txt").read_text(encoding="utf-8")
    return {"chars": len(text)}


@check("storage.secrets", "storage", "core/secrets: encrypt a value (DPAPI on Windows)")
def _():
    from pdfeditor.core import secrets

    can = secrets.can_encrypt()
    blob = secrets.encrypt(b"not a real key")
    return {"can_encrypt": can, "bytes": len(blob)}


# session and saving ------------------------------------------------------------------------
@check("session.open_save", "session", "DocumentSession open, edit, save to a path, reopen")
def _():
    from pdfeditor.core.commands.snapshot import SnapshotCommand, SnapshotStore
    from pdfeditor.core.session import DocumentSession

    source = _work("session") / "input.pdf"
    source.write_bytes(_pdf_bytes())
    session = DocumentSession.open(source)
    session.execute(
        SnapshotCommand(
            "Rotate", lambda doc: doc.page(0).set_rotation(90), SnapshotStore(_work("session-undo"))
        )
    )
    target = _work("session") / "saved.pdf"
    saved = session.save(target)
    session.close()
    head = saved.read_bytes()[:5]
    reopened = DocumentSession.open(saved)
    pages = reopened.page_count
    reopened.close()
    return {"head": head.decode("ascii", "replace"), "bytes": saved.stat().st_size, "pages": pages}


@check("session.open_bytes", "session", "DocumentSession.open from bytes (no path)")
def _():
    from pdfeditor.core.session import DocumentSession

    session = DocumentSession.open(_pdf_bytes())
    pages = session.page_count
    session.close()
    return {"pages": pages}


# translation -------------------------------------------------------------------------------
TRANSLATION_BODIES = {
    "mymemory": {"responseData": {"translatedText": "Hallo"}, "responseStatus": 200},
    "deepl": {"translations": [{"text": "Hallo", "detected_source_language": "EN"}]},
    "libretranslate": {"translatedText": "Hallo"},
    "azure": [{"translations": [{"text": "Hallo", "to": "de"}]}],
}


def _translator(service_id):
    from pdfeditor.services.translation import TranslationConfig, make_translator

    config = TranslationConfig(
        mymemory_email="",
        deepl_key="key",
        libretranslate_url="http://127.0.0.1:9/",
        azure_key="key",
        azure_region="westus",
    )
    return make_translator(service_id, config)


def _translate_check(service_id):
    def run():
        import json as _json

        from pdfeditor.services.translation.http import Reply

        translator = _translator(service_id)
        default_transport = translator.opener is None  # built with the default transport
        body = _json.dumps(TRANSLATION_BODIES[service_id]).encode("utf-8")
        translator.opener = lambda request, timeout: Reply(200, body)  # then a mocked one
        result = translator.translate("Hello", "en", "de")
        return {"defaultTransport": default_transport, "text": result.text}

    return run


def _register_translators():
    for service_id in TRANSLATION_BODIES:
        CHECKS.append(
            (
                f"translation.{service_id}",
                "translation",
                f"{service_id}: default transport built, mocked opener called",
                _translate_check(service_id),
            )
        )


@check("translation.default_transport", "translation", "MyMemory over the real transport")
def _():
    from pdfeditor.services.translation import mymemory

    original = mymemory.ENDPOINT
    mymemory.ENDPOINT = "http://127.0.0.1:9/get"  # a dead local port: no network from the audit
    try:
        translator = mymemory.MyMemoryTranslator("")
        translator.translate("Hello", "en", "de")
    finally:
        mymemory.ENDPOINT = original
    raise AssertionError("the call to a dead port returned")


# optimize ----------------------------------------------------------------------------------
@check("optimize.reduce_size", "optimize", "services/optimize.reduce_size (pikepdf)")
def _():
    from pdfeditor.services.optimize import ReduceOptions, reduce_size

    result = reduce_size(_open_doc(), ReduceOptions())
    return {"bytes": len(result.data) if hasattr(result, "data") else "returned"}


@check("optimize.engine", "optimize", "Document.optimize (MuPDF, no pikepdf)")
def _():
    from pdfeditor.engine.base import OptimizeOptions, SaveOptions

    doc = _open_doc()
    doc.optimize(OptimizeOptions())
    return {"bytes": len(doc.to_bytes(SaveOptions(garbage=3)))}


# engine ------------------------------------------------------------------------------------
@check("engine.open_render", "engine", "Engine open and page render (MuPDF)")
def _():
    from pdfeditor.engine.base import ColorMode, RenderRequest
    from pdfeditor.model.geometry import Matrix

    doc = _open_doc()
    shot = doc.page(0).render(RenderRequest(matrix=Matrix.scale(1), color=ColorMode.RGB))
    return {"width": shot.width, "height": shot.height, "pages": doc.page_count}


def run_checks():
    rows = []
    for check_id, group, title, fn in CHECKS:
        row = {"id": check_id, "group": group, "title": title}
        try:
            row.update(status="pass", detail=fn() or {})
        except Exception as exc:  # a failure is what the audit measures
            row.update(status="fail", error=_describe(exc))
        rows.append(row)
    return rows


def run_all():
    import pymupdf

    _register_exporters()
    _register_translators()
    modules = import_all()
    checks = run_checks()
    failed = {}
    for row in modules:
        if row["status"] == "fail":
            failed[row["category"]] = failed.get(row["category"], 0) + 1
    return {
        "patchPass": PATCH_PASS,
        "patchesApplied": APPLIED,
        "mupdf": pymupdf.TOOLS.mupdf_version(),
        "pymupdf": str(pymupdf.VersionBind),
        "python": sys.version.split()[0],
        "modules": modules,
        "moduleFailuresByCategory": failed,
        "checks": checks,
        "checksPassed": sum(1 for c in checks if c["status"] == "pass"),
    }


# One TIFF compression per interpreter (run_audit.mjs sets TIFF_PROBE): a libtiff codec can
# abort the whole WebAssembly runtime, and that must not hide the rest of the audit.
def run_tiff_probe(sequence):
    """Write TIFFs with each compression in ``sequence`` ("a+b" in order) in this runtime. A
    failed write doesn't stop the loop, so a later write shows whether the failure left libtiff
    broken (in that case the runtime aborts instead of returning)."""
    from PIL import Image

    steps = []
    for compression in sequence.split("+"):
        buf = io.BytesIO()
        try:
            Image.new("RGB", (32, 32), (10, 90, 200)).save(
                buf, format="TIFF", compression=compression
            )
            steps.append({"compression": compression, "result": "ok", "bytes": len(buf.getvalue())})
        except Exception as exc:  # the result is what the probe measures
            steps.append({"compression": compression, "result": f"{type(exc).__name__}: {exc}"})
    return {"sequence": sequence, "steps": steps}


def run_tiff_multipage(compression):
    """Three pages rendered by the engine at 150 dpi (1240 x 1754 for A4), written as one
    multi-page TIFF with ``save_all``. The export path (services/export/images.py) hardcodes
    tiff_deflate, so this writes with the same Pillow call but the compression it would use
    on the web."""
    from PIL import Image

    from pdfeditor.engine.base import ColorMode, RenderRequest
    from pdfeditor.model.geometry import Matrix

    doc = _open_doc()
    frames = []
    for index in range(3):
        shot = doc.page(index).render(
            RenderRequest(matrix=Matrix.scale(150 / 72), color=ColorMode.RGB)
        )
        frames.append(
            Image.frombytes(
                "RGB", (shot.width, shot.height), shot.samples, "raw", "RGB", shot.stride
            )
        )
    buf = io.BytesIO()
    frames[0].save(
        buf,
        format="TIFF",
        save_all=True,
        append_images=frames[1:],
        compression=compression,
        dpi=(150, 150),
    )
    return {
        "sequence": f"multipage:{compression}",
        "steps": [
            {
                "compression": compression,
                "result": "ok",
                "bytes": len(buf.getvalue()),
                "pages": len(frames),
                "size": [frames[0].width, frames[0].height],
            }
        ],
    }


TIFF_PROBE = globals().get("TIFF_PROBE")
# The last expression is what runPythonAsync returns, so the choice is made in one expression.
json.dumps(
    run_tiff_multipage(TIFF_PROBE.split(":", 1)[1])
    if TIFF_PROBE and TIFF_PROBE.startswith("multipage:")
    else run_tiff_probe(TIFF_PROBE)
    if TIFF_PROBE
    else run_all()
)
