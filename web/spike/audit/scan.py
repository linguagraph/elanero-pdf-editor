"""W0.4 part 1: a static (ast) scan of the web set and the excluded set.

Stdlib only, so it runs on the host Python in CI and locally. It writes ``out/audit-static.json``
and, from the same lists, the web zip and module list that the runtime audit (``run_audit.mjs``)
reads from ``dist/audit/``. Both parts therefore look at one package.

Each finding says where it is and whether it breaks the import or only the call:

- ``level``: ``module`` runs at import time, ``function`` only when the function is called.
- ``guarded``: inside a ``try`` whose handler catches ImportError (an optional import).
- ``typeOnly``: inside ``if TYPE_CHECKING:``, so it never runs.

Only an unguarded module-level blocked import or excluded edge breaks ``import``; the rest
break a call, which the runtime part measures.
"""

from __future__ import annotations

import ast
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

SPIKE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SPIKE))
import web_package as wp  # noqa: E402  (the shared lists; stdlib only)

OUT = SPIKE / "out"
DIST = SPIKE / "dist" / "audit"
PKG = "pdfeditor"

# Qualified stdlib names (after import aliasing) and what they do under Pyodide.
# A name matches an entry when it equals it or starts with "entry.".
FAILS: dict[str, str] = {
    "threading.Thread": "thread",
    "threading.Timer": "thread",
    "concurrent.futures": "thread",  # ThreadPoolExecutor, ProcessPoolExecutor
    "multiprocessing": "process",
    "subprocess": "process",
    "os.startfile": "platform",
    "os.getlogin": "platform",
    "webbrowser": "platform",
    "ctypes": "platform",
    "winreg": "platform",
    "signal": "platform",
    "socket": "network",
    "ssl": "network",
    "urllib.request": "network",
    "http.client": "network",
}
WORKS: dict[str, str] = {
    "threading.Lock": "lock",
    "threading.RLock": "lock",
    "threading.Event": "lock",
    "threading.local": "lock",
}
NOTES: dict[str, str] = {
    "tempfile": "storage",  # works on MEMFS; the path is the only thing to check
    "pathlib.Path.home": "platform",
    "os.path.expanduser": "platform",
    "sys.platform": "platform",
    "os.name": "platform",
    "os.environ": "env",
}
THREAD_MAKERS = ("threading.Thread", "threading.Timer", "multiprocessing")
GUARD_EXCEPTIONS = {"ImportError", "ModuleNotFoundError", "Exception"}


def dotted_name(rel: str) -> str:
    """``core/session.py`` -> ``pdfeditor.core.session``; ``core/__init__.py`` -> the package."""
    parts = PurePosixPath(rel).with_suffix("").parts
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join((PKG, *parts))


def excluded_module(dotted: str) -> bool:
    """True when ``dotted`` (a pdfeditor module or package) lies in the excluded set."""
    rel = dotted.split(".")[1:]
    if not rel:
        return False
    stem = "/".join(rel)
    return (
        wp.is_excluded(stem + ".py")
        or wp.is_excluded(stem + "/__init__.py")
        or wp.is_excluded(stem + "/")
    )


class Scanner(ast.NodeVisitor):
    def __init__(self, module: str, is_init: bool) -> None:
        self.module = module
        self.package = module if is_init else module.rpartition(".")[0]
        self.bindings: dict[str, str] = {}  # local name -> qualified name
        self.thread_vars: set[str] = set()  # names bound to a Thread/Timer/process object
        self.handled: set[int] = set()  # os.environ nodes already reported with their name
        self.findings: list[dict[str, Any]] = []
        self._lazy = 0
        self._guarded = 0
        self._type_only = 0

    # -- helpers ----------------------------------------------------------------------------
    def _add(self, kind: str, label: str, node: ast.AST, detail: str = "") -> None:
        self.findings.append(
            {
                "kind": kind,
                "label": label,
                "line": getattr(node, "lineno", 0),
                "level": "function" if self._lazy else "module",
                "guarded": self._guarded > 0,
                "typeOnly": self._type_only > 0,
                "detail": detail,
            }
        )

    def qual(self, node: ast.AST) -> str | None:
        if isinstance(node, ast.Name):
            return self.bindings.get(node.id)
        if isinstance(node, ast.Attribute):
            base = self.qual(node.value)
            return f"{base}.{node.attr}" if base else None
        return None

    def _classify(self, qualified: str, node: ast.AST) -> None:
        for table, kind in ((FAILS, "fails"), (WORKS, "works"), (NOTES, "note")):
            for key, category in table.items():
                if qualified == key or qualified.startswith(key + "."):
                    self._add("feature", f"{kind}:{category}", node, qualified)
                    return

    def _blocked(self, name: str, node: ast.AST) -> None:
        top = name.split(".")[0]
        if top in wp.BLOCKED:
            self._add("blocked", top, node, name)

    def _edge(self, target: str, node: ast.AST) -> None:
        if (target == PKG or target.startswith(PKG + ".")) and excluded_module(target):
            self._add("edge", "excluded", node, target)

    def _resolve_from(self, node: ast.ImportFrom) -> str:
        if not node.level:
            return node.module or ""
        parts = self.package.split(".")
        if node.level > 1:
            parts = parts[: -(node.level - 1)]
        return ".".join([*parts, node.module] if node.module else parts)

    # -- scope and guards -------------------------------------------------------------------
    def _lazy_scope(self, node: ast.AST) -> None:
        self._lazy += 1
        self.generic_visit(node)
        self._lazy -= 1

    visit_FunctionDef = _lazy_scope
    visit_AsyncFunctionDef = _lazy_scope
    visit_Lambda = _lazy_scope

    def visit_If(self, node: ast.If) -> None:
        test = node.test
        is_type_checking = (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or (
            isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING"
        )
        self.visit(test)
        if is_type_checking:
            self._type_only += 1
            for child in node.body:
                self.visit(child)
            self._type_only -= 1
        else:
            for child in node.body:
                self.visit(child)
        for child in node.orelse:
            self.visit(child)

    def visit_Try(self, node: ast.Try) -> None:
        catches = any(
            handler.type is None
            or (isinstance(handler.type, ast.Name) and handler.type.id in GUARD_EXCEPTIONS)
            for handler in node.handlers
        )
        self._guarded += int(catches)
        for child in node.body:
            self.visit(child)
        self._guarded -= int(catches)
        for part in (node.handlers, node.orelse, node.finalbody):
            for child in part:
                self.visit(child)

    # -- imports ----------------------------------------------------------------------------
    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.bindings[alias.asname or alias.name.split(".")[0]] = (
                alias.name if alias.asname else alias.name.split(".")[0]
            )
            self._blocked(alias.name, node)
            self._classify(alias.name, node)
            self._edge(alias.name, node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        base = self._resolve_from(node)
        for alias in node.names:
            self.bindings[alias.asname or alias.name] = f"{base}.{alias.name}" if base else ""
        if not node.level and node.module:
            self._blocked(node.module, node)
            self._classify(node.module, node)
        if base.startswith(PKG):
            self._edge(base, node)
            for alias in node.names:
                self._edge(f"{base}.{alias.name}", node)

    # -- uses -------------------------------------------------------------------------------
    def visit_Assign(self, node: ast.Assign) -> None:
        self.generic_visit(node)
        if isinstance(node.value, ast.Call):
            made = self.qual(node.value.func) or ""
            if made.startswith(THREAD_MAKERS):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        self.thread_vars.add(target.id)

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        name = self.qual(func)
        if name == "importlib.import_module" and node.args:
            arg = node.args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                self._edge(arg.value, node)
                self._classify(arg.value, node)
        if name == "os.getenv" and node.args and isinstance(node.args[0], ast.Constant):
            self.handled.add(id(func))
            self._add("feature", "env", node, f"env {node.args[0].value}")
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "get"
            and self.qual(func.value) == "os.environ"
        ):
            self.handled.update((id(func), id(func.value)))
            if node.args and isinstance(node.args[0], ast.Constant):
                self._add("feature", "env", node, f"env {node.args[0].value}")
        if isinstance(func, ast.Attribute) and func.attr == "start":
            receiver = func.value
            made = self.qual(receiver.func) if isinstance(receiver, ast.Call) else None
            if (isinstance(receiver, ast.Name) and receiver.id in self.thread_vars) or (
                made or ""
            ).startswith(THREAD_MAKERS):
                self._add("feature", "fails:thread", node, "start() of a thread or process")
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if self.qual(node.value) == "os.environ":
            self.handled.add(id(node.value))
            if isinstance(node.slice, ast.Constant):
                self._add("feature", "env", node, f"env {node.slice.value}")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if id(node) not in self.handled:
            name = self.qual(node)
            if name:
                self._classify(name, node)
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        name = self.bindings.get(node.id)
        if name and isinstance(node.ctx, ast.Load):
            self._classify(name, node)


def scan_file(path: Path, module: str, is_init: bool) -> dict[str, Any]:
    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        return {"parseError": f"{exc.msg} (line {exc.lineno})", "findings": []}
    scanner = Scanner(module, is_init)
    scanner.visit(tree)
    # One finding per kind and label on a line, named by its shortest qualified name: a
    # line with ctypes.windll.kernel32 reports "ctypes", not four overlapping prefixes. Env
    # reads keep their variable name, since two on one line are two different reads.
    best: dict[tuple[Any, ...], dict[str, Any]] = {}
    for item in scanner.findings:
        key = (
            item["kind"],
            item["label"],
            item["line"],
            item["detail"] if item["label"] == "env" else "",
        )
        current = best.get(key)
        if current is None or len(item["detail"]) < len(current["detail"]):
            best[key] = item
    findings = sorted(best.values(), key=lambda item: (item["line"], item["kind"], item["label"]))
    return {"parseError": None, "findings": findings}


def run() -> dict[str, Any]:
    web = {}
    excluded = {}
    for rel in sorted(p.as_posix() for p in (wp.PACKAGE.rglob("*.py"))):
        relative = rel[len(wp.PACKAGE.as_posix()) + 1 :]
        if "__pycache__" in relative:
            continue
        is_init = relative.endswith("__init__.py")
        module = dotted_name(relative)
        entry = scan_file(wp.PACKAGE / relative, module, is_init)
        entry["file"] = f"src/pdfeditor/{relative}"
        if wp.is_excluded(relative):
            excluded[module] = entry
        else:
            web[module] = entry

    web_names = set(wp.web_modules())
    assert set(web) == web_names, "web set differs from web_package.web_modules()"
    summary = summarize(web)
    return {
        "webModules": len(web_names),
        "excludedModules": len(excluded),
        "summary": summary,
        "web": web,
        "excluded": excluded,
    }


def summarize(web: dict[str, Any]) -> dict[str, Any]:
    breaks = []
    lazy_blocked = []
    for module, entry in web.items():
        for item in entry["findings"]:
            if item["typeOnly"]:
                continue
            if item["kind"] in ("blocked", "edge") and item["level"] == "module":
                if not item["guarded"]:
                    breaks.append(f"{module}:{item['line']} {item['label']} {item['detail']}")
                else:
                    lazy_blocked.append(f"{module}:{item['line']} guarded {item['label']}")
            elif item["kind"] == "blocked":
                lazy_blocked.append(f"{module}:{item['line']} in function {item['label']}")
    return {
        "moduleLevelBreaks": breaks,
        "guardedOrLazyBlocked": lazy_blocked,
        "modulesWithFindings": sum(1 for e in web.values() if e["findings"]),
        "parseErrors": [m for m, e in web.items() if e["parseError"]],
    }


def write_inputs() -> None:
    """The zip and the module list the runtime audit loads (same lists as the static scan)."""
    DIST.mkdir(parents=True, exist_ok=True)
    zip_path = wp.build_zip(DIST / "pdfeditor-web.zip")
    # Re-read every member: a damaged zip must fail here, not inside the Pyodide run.
    with zipfile.ZipFile(zip_path) as zf:
        bad = zf.testzip()
    if bad is not None:
        raise SystemExit(f"{zip_path} is damaged at {bad}; rebuild it")
    (DIST / "audit-input.json").write_text(
        json.dumps(
            {
                "modules": wp.web_modules(),
                "blocked": list(wp.BLOCKED),
                "excluded": list(wp.EXCLUDED),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def main() -> int:
    result = run()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "audit-static.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    write_inputs()
    s = result["summary"]
    print(
        f"static: {result['webModules']} web modules, {result['excludedModules']} excluded, "
        f"{s['modulesWithFindings']} web modules with findings"
    )
    for line in s["moduleLevelBreaks"]:
        print(f"  BREAKS IMPORT: {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
