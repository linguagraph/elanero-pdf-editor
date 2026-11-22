# Sanitize crash on files with undeclared object numbers (design)

Status: design only, for issue #538. No production code in this change.
Scope: `MuDocument.sanitize` (`src/pdfeditor/engine/mupdf/document.py:950`) and the PyMuPDF
`Document.scrub()` call inside it. The engine is shared, so the fix applies to the desktop app and
to the web build (Pyodide) alike.

## 1. The failure, reproduced

Reproduced on this branch with the main checkout's venv (PyMuPDF 1.28.2):

```python
doc = get_engine("mupdf").open(Path("tests/fixtures/real/signed_selfsigned.pdf"))
doc.sanitize(SanitizeOptions())   # RuntimeError: code=7: cannot find object in xref (11 0 R)
```

Traceback: `sanitize` → `fz.scrub(...)` (document.py:979) → PyMuPDF's document-wide loop
`for xref in range(1, doc.xref_length()): if not doc.xref_object(xref): ...`. The loop runs only
when `javascript` or `xml_metadata` is on (both are on by default). Turning either one on is
enough to hit it.

## 2. Root cause

The sample has two cross-reference sections (MuPDF wrote the first; pyHanko appended the signature
as an incremental update):

| Section | Subsections | Trailer `/Size` |
|---|---|---|
| original (offset 1221) | `0 11` (objects 0-10) | 11 |
| update (offset 8733) | `0 2`, `4 1`, `10 1`, `12 5` (objects 0-1, 4, 10, 12-16) | 17 |

**Object number 11 is declared in no section.** The update raised `/Size` to 17 and started its
new objects at 12, so number 11 is a gap: not an in-use entry, and not a free (`f`) entry either.
It is not referenced anywhere, so the file is readable and the signature is valid (pyHanko:
intact, valid, covers the entire file).

MuPDF sizes its xref by `/Size` (`xref_length()` is 17), but for number 11 there is no entry in any
section, so `pdf_load_object` throws "cannot find object in xref". `xref_object(11)` and
`xref_get_key(11, ...)` both throw. PyMuPDF's scrub loop assumes every number below
`xref_length()` loads (its own guard, `if not doc.xref_object(xref): raise ValueError("bad xref")`,
never gets the chance), so it crashes.

Checked by experiment:

- A **declared** free entry is fine: `xref_object` returns `"null"` and `scrub()` completes. Only
  an undeclared gap fails, so "free slot" in the issue title is, more exactly, "missing slot".
- **Not signature-specific.** A hand-made one-section **unsigned** file whose xref declares
  `0 3` and `4 1` with `/Size 5` fails the same way (`cannot find object in xref (3 0 R)`).
  The desktop and web `document.sanitize` action refuses signed documents
  (`actions/security.py`, `_refuse_if_signed`), so in the app this crash is reachable **only with
  unsigned files**. The signed sample is just the file where we noticed it.
- `mupdf.pdf_object_exists(pdf, n)` returns 0 for both a gap and a declared free entry, and 1 for
  every loadable object, so it detects the gap without catching exceptions or matching messages.
- Other xref loops in the engine already tolerate this: `optimize.py:30,67` and
  `MuDocument._state_digest` (document.py:896) skip objects that fail to load. Only the loop inside
  PyMuPDF's `scrub()` does not.

## 3. Candidate fixes

Each one was tried on the signed sample: sanitize with default options, then an **incremental**
save, then pyHanko validation (`ValidationContext(allow_fetching=False)`, self-signed root).

| # | Fix | Works? | Signature after sanitize + incremental save | Effect on files without gaps |
|---|---|---|---|---|
| A | **Own tolerant loop.** Call `scrub(javascript=False, xml_metadata=False)`, then run the same document-wide JS/XMP pass ourselves, skipping numbers where `pdf_object_exists` is 0 | yes (simulated by skipping the gap in both calls the loop makes) | original 9094 bytes kept byte for byte; pyHanko `intact=True, valid=True`, coverage `ENTIRE_REVISION` | none: same objects touched in the same order with the same new values |
| B | **Fill the gaps** before scrub: `update_object(n, "<<>>")` for each missing number (`"null"` does not work: MuPDF leaves the entry missing) | yes | original bytes kept; `intact=True, valid=True` | none for gap-free files; gap files gain empty objects that no one references |
| C | **Skip the JS/XMP pass** when the file has gaps | yes | intact | none, but gap files keep JavaScript actions and XMP streams: a silent sanitize failure. Rejected |
| D | **Pre-rewrite via a copy** (what the test does now: pikepdf save, or a MuPDF full rewrite/repair, then sanitize) | yes | **broken**: a full rewrite of the sample, even with no edits, gives pyHanko `intact=False` (coverage "contiguous block from start", modification level OTHER). The current test still passes only because it compares the `/ByteRange` and `/Contents` values, not the digest | renumbers or rewrites every file; would also invalidate `_loaded_xrefs` and the snapshot font bookkeeping, and pikepdf is not available in Pyodide. Rejected |
| E | Upstream fix in PyMuPDF (`scrub()` skipping missing objects) | n/a | n/a | n/a. Worth reporting, but we pin PyMuPDF (`test_version_is_the_locked_pymupdf`) and can't wait for a release |

For A and B the signature validates as **intact** (the signed bytes are untouched and the digest
matches); pyHanko reports modification level OTHER, which is right: sanitize changes content, the
Info dictionary and form values after signing. That is a property of sanitizing a signed file, not
of the fix, and it is why the app refuses it.

## 4. Recommendation: fix A

Fix A is the only one that changes nothing for files without gaps, adds nothing to files with
gaps, and does no full rewrite. It is a small, local copy of 20 lines of PyMuPDF logic, in
`engine/mupdf/sanitize.py`, the module that already holds the sanitizing steps `scrub()` misses.

Shape (illustrative):

```python
def scrub_objects(fz: pymupdf.Document, javascript: bool, xmp: bool) -> None:
    """PyMuPDF's document-wide JS/XMP pass from scrub(), skipping object numbers that no xref
    section declares (scrub() raises on them; see design/sanitize-signed-crash.md)."""
    if not (javascript or xmp):
        return
    if xmp:
        fz.del_xml_metadata()
    pdf = pymupdf._as_pdf_document(fz)  # as document.py:864 already does
    for xref in range(1, fz.xref_length()):
        if not pymupdf.mupdf.pdf_object_exists(pdf, xref):
            continue  # an undeclared gap or a free entry: nothing to scrub
        ...  # the same /S /JavaScript, /Type /Metadata and /Metadata steps as scrub()
```

and in `MuDocument.sanitize`: pass `javascript=False, xml_metadata=False` to `fz.scrub(...)`,
then call `scrub.scrub_objects(fz, options.javascript, options.xmp)` right after it (before
`reset_form_values`, matching where scrub's loop ran). The existing catalog/page trigger removal
(document.py:999-1008) stays as is.

The loop keeps PyMuPDF's `bad xref` guard for an object that *exists* but loads as empty, so a
truly damaged object still fails loudly, as today.

## 5. Verifying that signatures still validate

On `signed_selfsigned.pdf` after `sanitize(SanitizeOptions())` and
`save(options=SaveOptions(incremental=True))`:

1. The first 9094 bytes of the saved file equal the original file (the signed revision is
   untouched; verified for A and B).
2. pikepdf: `Root.AcroForm.Fields[0]` is still `/FT /Sig` with a `/V` dictionary of `/Type /Sig`,
   and `/ByteRange` and `/Contents` equal the original values.
3. pyHanko through the existing `signature_status` fixture (`tests/conftest.py:156`): every status
   `intact` and `valid`. (Do not assert `docmdp_ok` or the modification level: sanitize is a
   post-signing change by design.)
4. pypdfium2 renders page 0 (round-trip rule); `record("render_size_pdfium", ...)` as the current
   test does.

## 6. Test changes

In `tests/engine/test_mupdf_sanitize.py`:

- **Remove the pikepdf workaround** from `test_form_reset_keeps_a_signature_value`: open `SIGNED`
  (copied to `tmp_path`) directly, and drop the comment pointing at the issue.
- Change that test's save to `SaveOptions(incremental=True)` and add checks 1 and 3 above. The
  current `garbage=4` full save gives a signature that pyHanko reports as not intact, so the test
  proves less than its name says.
- **New** `test_default_sanitize_on_the_signed_sample` (desktop_only, it reads with pikepdf and
  pyHanko): `sanitize(SanitizeOptions())` does not raise, then checks 1-4 of section 5.
- **New fixture** `xref_gap.pdf` in `scripts/make_fixtures.py`: an unsigned one-page file written
  byte by byte with an undeclared object number, an `/OpenAction` JavaScript action object above
  the gap, and an XMP `/Metadata` stream. **New** test (not desktop_only, so it also runs under
  Pyodide; reading through `tests.hostcheck.record` host checks, no module-level pikepdf):
  default sanitize does not raise, the JS action object's script is empty, there is no XMP, and the
  saved file opens and renders through host checks. This guards the loop running *past* the gap.
- **New** equivalence test on an existing gap-free fixture with JavaScript and XMP: sanitize with
  the new code and, on a second copy, call PyMuPDF's own `scrub()` with the same flags; the
  `tobytes(garbage=0)` outputs are equal. This is the "no effect on unsigned files" guarantee and
  will also flag a future PyMuPDF change to the scrub loop.

## 7. Effect on unsigned files

None for files without gaps: same objects, same values, same order (the equivalence test pins
it). Unsigned files with gaps go from a crash to a full sanitize. The action-level refusal of
signed documents and `require_full_save = True` after sanitize are unchanged.

## 8. Desktop and web impact

- Desktop: no UI, dialog, string or `docs/guide/` change; the Sanitize dialog simply stops failing
  on such files. No new dependency, nothing for the frozen build or the self-test.
- Web: the same engine code runs in the Pyodide worker, so the fix ships through
  `scripts/web_package.py` with no change. No RPC, type or i18n change.
- No `PLAN.md` item to tick (a bug fix, not a roadmap item).

## 9. Files and line estimate

| File | Change | Lines |
|---|---|---|
| `src/pdfeditor/engine/mupdf/sanitize.py` | `scrub_objects()` | ~40 |
| `src/pdfeditor/engine/mupdf/document.py` | scrub flags, the new call | ~6 |
| `scripts/make_fixtures.py` | `xref_gap.pdf` | ~35 |
| `tests/engine/test_mupdf_sanitize.py` | workaround removed, three tests | ~90 (tests) |

About 80 changed lines outside tests, well under 400.

## 10. Risks

- **Drift from PyMuPDF.** The copied loop no longer follows upstream changes to `scrub()`. The
  equivalence test catches a divergence on gap-free files at the next PyMuPDF bump.
- **Private helper.** `pymupdf._as_pdf_document` is private; the engine already depends on it
  (document.py:864), and the locked-version test makes a bump deliberate.
- **Other `scrub()` steps** (`clean_pages`, `hidden_text` redactions) work per page and did not hit
  the gap on the sample. A gap that a page's resources *reference* would be a different, damaged
  file; out of scope here.
- **Signed files stay refused in the app.** This fix does not make sanitizing a signed file a
  feature; it only makes the engine safe on such files.

## Questions for the maintainer

1. **Fix A (own loop with `pdf_object_exists`) rather than B (fill gaps with empty objects)?**
   Recommended: A. B writes unreferenced objects into users' files and differs from today's
   output; A has no output change.
2. **Should the signature test switch from a `garbage=4` full save to an incremental save and
   assert pyHanko `intact`?** Recommended: yes. The full save already breaks the digest today,
   so the test should check what users rely on.
3. **Report the gap crash upstream to PyMuPDF?** Recommended: yes, with the hand-made gap file
   (unsigned, no project data), and keep fix A regardless; remove it only after the equivalence
   test shows upstream behaves the same.
4. **Keep refusing sanitize on signed documents in the action layer?** Recommended: yes, unchanged.
   Sanitize always changes the document after signing (pyHanko: modification level OTHER), so the
   refusal is still right; this issue is about the crash only.
