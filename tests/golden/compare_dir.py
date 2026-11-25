"""Compare the browser renders of web-e2e (W8.2 S3) with the page references in tests/golden/data.

The visual spec (web/app/e2e/visual-render.spec.ts) writes one RGBA PNG per case into a folder. Each
is composited over white and compared with its reference using the same tolerance as the engine
goldens. Any problem fails the run: a missing render, a render with no reference, a size change or
a mismatch. Diff images go to --out, which web-e2e.yml keeps as an artifact.

    python -m tests.golden.compare_dir web/app/test-results/visual \
        --out web/app/test-results/visual-diff

Run it from the repository root. It needs only numpy and Pillow, so the web-e2e host Python runs it.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from tests.golden.compare import Tolerance, compare, rgba_to_rgb

DATA = Path(__file__).parent / "data"

# The same tolerance as test_golden_render.TOLERANCE (a test checks the two are equal). Not imported
# from there: that module needs the desktop engine, which the web-e2e host Python does not install.
TOLERANCE = Tolerance(max_mean=1.5, max_bad_fraction=0.004)

# The engine-only redaction case: the browser render calls do not apply marks, so it has no render.
ENGINE_ONLY = {"sensitive-redacted-p0.png"}


def compare_folder(rendered: Path, out: Path) -> list[str]:
    """The problems found in ``rendered`` against the references, empty when all match."""
    references = {path.name for path in DATA.glob("*.png")} - ENGINE_ONLY
    renders = {path.name for path in rendered.glob("*.png")}
    problems = [f"{name}: no browser render in {rendered}" for name in sorted(references - renders)]
    problems += [
        f"{name}: rendered but has no reference in {DATA}" for name in sorted(renders - references)
    ]
    out.mkdir(parents=True, exist_ok=True)
    for name in sorted(references & renders):
        with Image.open(rendered / name) as image:
            actual = rgba_to_rgb(np.asarray(image.convert("RGBA")))
        problem = compare(actual, DATA / name, TOLERANCE, out)
        if problem is not None:
            problems.append(f"{problem} (browser render)")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("rendered", type=Path, help="folder of the browser renders (PNG)")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="where the actual and diff images go (default: diff/ beside the renders)",
    )
    args = parser.parse_args(argv)
    out = args.out if args.out is not None else args.rendered.parent / "visual-diff"
    problems = compare_folder(args.rendered, out)
    for problem in problems:
        sys.stderr.write(problem + "\n")
    if problems:
        sys.stderr.write(
            f"{len(problems)} browser render problem(s); see {out} for the images. "
            "Sizes or pixels that moved are a bug; a MuPDF or Pyodide skew is the same failure "
            "(docs/web/design/W8.2-visual-golden.md, D5).\n"
        )
        return 1
    sys.stdout.write(
        f"all browser renders match the references ({len(DATA.glob('*.png'))} data files)\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
