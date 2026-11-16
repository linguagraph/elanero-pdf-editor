"""Turn the W0.2 JSON files into the Markdown tables of docs/web/spikes/W0.2-results.md.

Spike only. Usage: python perf/report.py [out_dir]   (default: web/spike/out)

Reads out/sizes.json (M1) and every out/perf-<env>[-<browser>].json (M2-M8), and prints one
Markdown report on stdout. Budgets are checked here and marked met / missed by X. Stdlib only.
"""

from __future__ import annotations

import json
import math
import statistics
import sys
from pathlib import Path

MIB = 1024 * 1024
MB = 1_000_000
BUDGET_COLD_S = 6.0  # localhost + download at 50 Mbit/s
BUDGET_WARM_S = 2.0  # localhost, warm
BUDGET_GZIP = 40 * MB  # plan decision 10
LONG_TASK_MS = 50
# (label, start mark or None for navigation start, end mark)
PHASES = [
    ("page script and fixture fetched", None, "fixtureFetched"),
    ("worker created to worker started", "worker-created", "worker-started"),
    ("Pyodide ready", "worker-started", "pyodide-ready"),
    ("full package set loaded", "pyodide-ready", "packages-loaded"),
    ("PyMuPDF wheel loaded", "packages-loaded", "wheel-loaded"),
    ("harness and pdfeditor imported", "wheel-loaded", "pdfeditor-imported"),
    ("engine ready (get_engine)", "pdfeditor-imported", "engine-ready"),
    ("open call (file write, open)", "engine-ready-reply", "document-opened"),
    ("page 1 rendered in Python", "document-opened", "page1-rendered-python"),
    ("page 1 ImageBitmap on main thread", "page1-rendered-python", "bitmap-received"),
]


def median(xs: list[float]) -> float | None:
    return statistics.median(xs) if xs else None


def p95(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[max(0, math.ceil(0.95 * len(s)) - 1)]


def fmt(value: float | None, digits: int = 0) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def spread(values: list[float], digits: int = 0) -> str:
    """Median, then the min and max across runs, in brackets."""
    if not values:
        return "n/a"
    lo, hi = fmt(min(values), digits), fmt(max(values), digits)
    return f"{fmt(median(values), digits)} ({lo}-{hi})"


def mib(n: float | None) -> str:
    return "n/a" if n is None else f"{n / MIB:.1f}"


def verdict(value: float | None, budget: float, unit: str, scale: float) -> str:
    """met, or missed by how much; both in the unit the budget is written in."""
    if value is None:
        return "n/a"
    got, want = value / scale, budget / scale
    if value <= budget:
        return f"met ({got:.2f} {unit} <= {want:g} {unit})"
    return f"missed by {got - want:.2f} {unit} ({got:.2f} vs {want:g} {unit})"


def load(path: Path) -> dict | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def cold_phases(run: dict) -> dict[str, float]:
    """Phase durations (ms) of one scenario, from its marks (worker clock, same origin)."""
    marks = run.get("marks", {})
    nav = run["env"]["navigationStart"]
    rel = {name: t - nav for name, t in marks.items()}
    out: dict[str, float] = {}
    for label, start, end in PHASES:
        if end in rel:
            out[label] = rel[end] - (rel.get(start, 0.0) if start else 0.0)
    out["total, localhost"] = rel.get("bitmap-received", float("nan"))
    return out


def download_ms(total_bytes: int, mbit: float) -> float:
    return total_bytes * 8 / (mbit * MB) * 1000


def section_m1(sizes: dict) -> list[str]:
    lines = [
        f"Brotli source: {sizes.get('brotliSource')}. Budget: full set gzip <= 40 MB.",
        "",
        "| Set | Raw (MB) | gzip -9 (MB) | brotli -q 11 (MB) |",
        "|---|---:|---:|---:|",
    ]
    for key, label in (("viewerSet", "viewer"), ("fullSet", "full")):
        t = sizes[key]["totals"]
        brotli = fmt(None if t["brotli"] is None else t["brotli"] / MB, 2)
        lines.append(f"| {label} | {fmt(t['raw'] / MB, 2)} | {fmt(t['gzip'] / MB, 2)} | {brotli} |")
    d = sizes["data"]
    return [
        *lines,
        "",
        f"- M1 budget: {verdict(sizes['fullSet']['totals']['gzip'], BUDGET_GZIP, 'MB', MB)}",
        f"- `data/` in the zip: {d['files']} files, {d['raw'] / MB:.2f} MB raw, "
        f"{d['gzip'] / MB:.2f} MB gzip.",
        "",
    ]


def section_m2_m3(report: dict, full_gzip: int | None) -> list[str]:
    lines: list[str] = []
    runs = [r for r in report["runs"] if r["cold"].get("phase") == "done"]
    for fixture in sorted({r["fixture"] for r in runs}):
        group = [r for r in runs if r["fixture"] == fixture]
        cold = [cold_phases(r["cold"]) for r in group]
        warm = [cold_phases(r["warm"]) for r in group]
        lines += [
            f"**{fixture}** ({len(group)} runs; cold = new browser context, warm = reload)",
            "",
            "| Phase (ms) | Cold: median (min-max) | Warm: median (min-max) |",
            "|---|---:|---:|",
        ]
        for key in cold[0]:
            c = [p[key] for p in cold if key in p]
            w = [p[key] for p in warm if key in p]
            lines.append(f"| {key} | {spread(c)} | {spread(w)} |")
        cold_total = median([p["total, localhost"] for p in cold]) or 0.0
        warm_total = median([p["total, localhost"] for p in warm]) or 0.0
        lines.append("")
        if full_gzip is not None:
            lines += [
                "| Link | Download of full-set gzip | Cold localhost + download |",
                "|---|---:|---:|",
            ]
            for mbit in (20, 50, 100):
                dl = download_ms(full_gzip, mbit)
                lines.append(
                    f"| {mbit} Mbit/s | {dl / 1000:.2f} s | {(cold_total + dl) / 1000:.2f} s |"
                )
            cold_50 = (cold_total + download_ms(full_gzip, 50)) / 1000
            lines += [
                "",
                f"- M2 budget (localhost + 50 Mbit/s <= 6 s): "
                f"{verdict(cold_50, BUDGET_COLD_S, 's', 1)}",
            ]
        lines += [
            f"- M3 budget (warm localhost <= 2 s): "
            f"{verdict(warm_total / 1000, BUDGET_WARM_S, 's', 1)}",
            "",
        ]
    return lines


def section_m4(report: dict) -> list[str]:
    runs = [r for r in report["runs"] if r["warm"].get("m4")]
    if not runs:
        return ["No M4 data.", ""]
    m4 = [r["warm"]["m4"] for r in runs]
    engine_heap = [r["warm"]["heap"].get("afterOpen") for r in runs]
    return [
        "Warm: the engine worker is ready, then a second worker boots and opens perf_mixed_200.",
        "",
        "| Metric | Median (min-max) |",
        "|---|---:|",
        f"| job worker, spawn to opened (ms) | {spread([m['totalMs'] for m in m4])} |",
        f"| of which bootstrap to engine ready (ms) | {spread([m['bootMs'] for m in m4])} |",
        f"| of which open call in Python (ms) | {spread([m['openMs'] for m in m4], 1)} |",
        f"| job worker wasm heap after open (MiB) | "
        f"{mib(median([m['jobHeapBytes'] for m in m4]))} |",
        f"| engine worker wasm heap after open (MiB) | "
        f"{mib(median([h for h in engine_heap if h]))} |",
        "",
    ]


def section_m5(report: dict) -> list[str]:
    lines = [
        "Cold runs, pooled over the runs (30 renders per scale: pages 1-10, then 20 random).",
        "",
        "| Fixture | Scale | Python render (ms): median / p95 | "
        "End-to-end (ms): median / p95 | n |",
        "|---|---:|---:|---:|---:|",
    ]
    for fixture in sorted({r["fixture"] for r in report["runs"]}):
        group = [r for r in report["runs"] if r["fixture"] == fixture]
        for scale in (1.0, 2.0):
            samples = [s for r in group for s in r["cold"].get("m5", []) if s["scale"] == scale]
            if not samples:
                continue
            py = [s["pythonMs"] for s in samples]
            e2e = [s["endToEndMs"] for s in samples]
            lines.append(
                f"| {fixture} | {scale:g} | {fmt(median(py), 1)} / {fmt(p95(py), 1)} | "
                f"{fmt(median(e2e), 1)} / {fmt(p95(e2e), 1)} | {len(samples)} |"
            )
    return [*lines, ""]


def section_m6_m7(report: dict) -> list[str]:
    ops = [
        "| Fixture | Open (ms) | Text page, median of pages 1-10 (ms) | "
        "Search for one LOREM word (ms, hits) | Save (ms) | Close + gc (ms) |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    heap = [
        "| Fixture | After ready | After open | After renders | After save | After close | "
        "Grew on close? |",
        "|---|---:|---:|---:|---:|---:|---|",
    ]
    for fixture in sorted({r["fixture"] for r in report["runs"]}):
        group = [r["cold"] for r in report["runs"] if r["fixture"] == fixture]
        group = [c for c in group if c.get("phase") == "done"]
        if not group:
            continue
        m6 = [c["m6"] for c in group]
        ops.append(
            f"| {fixture} | {spread([m['openMs'] for m in m6], 1)} | "
            f"{spread([m['textPageMedianMs'] for m in m6], 1)} | "
            f"{spread([m['search']['ms'] for m in m6], 1)} ({m6[0]['search']['hits']}) | "
            f"{spread([m['save']['ms'] for m in m6], 1)} | "
            f"{spread([m['close']['closeMs'] + m['close']['gcMs'] for m in m6], 1)} |"
        )
        heaps = [c["heap"] for c in group]
        after_save = median([h["afterSave"] for h in heaps])
        after_close = median([h["afterClose"] for h in heaps])
        grew = "yes" if after_close > (after_save or 0) else "no"
        heap.append(
            f"| {fixture} | {mib(median([h['afterReady'] for h in heaps]))} | "
            f"{mib(median([h['afterOpen'] for h in heaps]))} | "
            f"{mib(median([h['afterRenders'] for h in heaps]))} | "
            f"{mib(after_save)} | {mib(after_close)} | {grew} |"
        )
    return [*ops, "", "M7 wasm heap, MiB (median over runs):", "", *heap, ""]


def section_m8(report: dict) -> list[str]:
    lines = [
        "| Fixture | Long tasks in scenario (count, longest ms) | "
        "Startup tasks (count, longest ms) | Over 50 ms in scenario |",
        "|---|---:|---:|---:|",
    ]
    for fixture in sorted({r["fixture"] for r in report["runs"]}):
        group = [r["cold"] for r in report["runs"] if r["fixture"] == fixture]
        group = [c for c in group if c.get("m8")]
        if not group:
            continue
        if not group[0]["m8"]["supported"]:
            lines.append(f"| {fixture} | not supported by this browser | n/a | n/a |")
            continue
        scenario = [t for c in group for t in c["m8"]["scenario"]]
        startup = [t for c in group for t in c["m8"]["startup"]]
        over = sum(1 for t in scenario if t > LONG_TASK_MS)
        lines.append(
            f"| {fixture} | {len(scenario)}, {fmt(max(scenario, default=None), 1)} | "
            f"{len(startup)}, {fmt(max(startup, default=None), 1)} | {over} |"
        )
    return [*lines, ""]


def env_block(report: dict) -> list[str]:
    m = report["machine"]
    lines = [
        f"### {report['env']}, {report['browser']} {report['browserVersion']}",
        "",
        f"- CPU: {m['cpu'].strip()} ({m['cores']} logical cores), "
        f"RAM {m['ramBytes'] / 1024**3:.0f} GiB, {m['platform']}",
        f"- Runs requested per fixture: {report['runsRequested']}",
    ]
    if report.get("cpuThrottle"):
        # The throttle reaches the page's main thread (perf.spec.ts). The calibration loop shows the
        # slowdown there, and whether a dedicated worker was slowed too.
        throttles = [r["throttle"] for r in report["runs"] if r.get("throttle")]
        refused = sorted({w for t in throttles for w in t["workers"]})
        cal = [t["calibration"] for t in throttles if t.get("calibration")]
        lines.append(
            f"- CPU throttle: {report['cpuThrottle']}x on the page; dedicated workers: "
            f"{', '.join(refused) or 'none started'}"
        )
        if cal:
            lines.append(
                f"- Calibration loop, median of {len(cal)} runs: main thread "
                f"{fmt(median([c['mainMs'] for c in cal]), 1)} ms, dedicated worker "
                f"{fmt(median([c['workerMs'] for c in cal]), 1)} ms"
            )
    return [*lines, ""]


def main(out_dir: Path) -> int:
    sizes = load(out_dir / "sizes.json")
    full_gzip = sizes["fullSet"]["totals"]["gzip"] if sizes else None
    lines = ["# W0.2 measured tables (generated by perf/report.py)", ""]
    if sizes:
        lines += ["## M1: first-load bytes", "", *section_m1(sizes)]
    for path in sorted(out_dir.glob("perf-*.json")):
        report = load(path)
        if not report:
            continue
        lines += [*env_block(report), "#### M2 and M3: cold and warm start", ""]
        lines += section_m2_m3(report, full_gzip)
        lines += ["#### M4: job worker", "", *section_m4(report)]
        lines += ["#### M5: render", "", *section_m5(report)]
        lines += ["#### M6 and M7: operations and memory", "", *section_m6_m7(report)]
        lines += ["#### M8: main-thread long tasks", "", *section_m8(report)]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    default = Path(__file__).resolve().parents[1] / "out"
    sys.exit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else default))
