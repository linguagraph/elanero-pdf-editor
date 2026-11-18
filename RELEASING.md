# Releasing Elanero

For a detailed, click-by-click walkthrough of building the package and submitting it in
Partner Center, see [docs/microsoft-store-submission.md](docs/microsoft-store-submission.md).

Every release ships three ways from the same source tag:

- **Microsoft Store:** `Elanero-<version>-x64.msix`. Microsoft signs it and updates users.
- **Portable:** `Elanero.exe`.
- **Installer:** `pdfeditor-<version>-setup.exe`, made with Inno Setup. It installs the app as a
  folder, which starts faster than the one-file exe because nothing is unpacked on launch.

The portable exe and the installer are unsigned until we have a code-signing certificate
(PLAN.md Phase 17 and Phase 18 S10).

## Release checklist

Follow these in order for each release. A step that says *not yet automated* has no command
yet: do it by hand as described, and don't invent one. The detailed Store steps are below.

1. **Version.** Use one `X.Y.Z` everywhere. These must all print it:

   ```sh
   grep -n '^version = ' pyproject.toml
   grep -n '__version__ = ' src/pdfeditor/__init__.py
   grep -n '"version": "' web/app/package.json web/app/package-lock.json | head -3
   grep -n 'APP_VERSION =' web/app/src/version.ts
   ```

   The lockfile has the version at the top and under `packages[""]`; edit both. The tag is
   `vX.Y.Z`, and the `version` job in `release.yml` fails if it doesn't match `__version__`.
2. **What's new.** There is no CHANGELOG file. The changelog is the "What's new in this version"
   section of `packaging/store/listing-en.md`, updated in the same PR. Pass:
   `uv run python scripts/store_listing.py` exits 0. The "must differ from the last tag" check
   runs in `release.yml` once the tag exists.
3. **Desktop checks.** Pass: every command exits 0.

   ```sh
   uv run ruff check . && uv run ruff format --check .
   uv run lint-imports && uv run mypy
   QT_QPA_PLATFORM=offscreen uv run pytest
   ```

4. **Web checks.** In `web/app`, after `npm ci`. Pass: every command exits 0.

   ```sh
   npm run typecheck && npm run lint && npm run format:check && npm run test
   npm run build && npx playwright test
   ```

   `npm run build` writes `web/app/dist`. The first `npx playwright test` needs
   `npx playwright install chromium`.
5. **Desktop exe and self-test.** Run `uv run python scripts/build_exe.py --test`. Pass: it
   prints `built ... (N MB)` with N at most 150, and the self-test report ends with
   `RESULT: OK`. Note N in the release PR.
6. **Web package.** Run `python scripts/build_web_wheel.py` (stdlib only; the command web-pytest
   runs). Pass: it exits 0, writes `dist/web/pdfeditor-web.zip` and `dist/web/manifest.json`,
   and its size check passes.
7. **Web pytest (manual run).** Run `gh workflow run web-pytest.yml --ref main`, then watch it with
   `gh run watch`. Pass: the `web-pytest` job is green. It isn't a required check, so a failure
   doesn't block the merge; fix it or record why it can wait, and note the run URL in the release PR.
8. **CI on main.** The PR's CI is green, and the last nightly run on `main` is too:
   `gh run list --workflow ci.yml --branch main --limit 5` (the nightly is a `schedule` run).
9. **Tag.** From the merged release commit on `main`:
   `git tag -a vX.Y.Z -m "Elanero X.Y.Z" && git push origin vX.Y.Z`. Pass: `release.yml` starts
   and its `version` job is green.
10. **Build, test and GitHub release (automated).** `release.yml` runs `ci` (the full test run and
    the only app build), then `github-release`, which attaches `Elanero.exe` and
    `pdfeditor-X.Y.Z-setup.exe`. Pass: release `vX.Y.Z` exists with both files. Re-run only a failed
    job.
11. **Store (approval).** `microsoft-store` waits in the `microsoft-store` environment. Read the
    What's New text, then approve it in Actions. Pass: the job uploads and submits the MSIX.
    The local MSIX and App Certification Kit checks are steps 5 and 6 under "Making a release".
12. **Web deploy.** *Not yet automated (see W9.2).* `docs.yml` publishes only the landing page and
    the user guide. `scripts/build_site.py` doesn't build the web app yet.
13. **Cache busting.** *Not yet automated (see W9.2).* Asset names aren't versioned yet.
14. **Post-release check.** Pass for each:
    - Download: `gh release download vX.Y.Z --pattern Elanero.exe --dir $env:TEMP\elanero-check`
    - Self-test: `& $env:TEMP\elanero-check\Elanero.exe --self-test --self-test-report $env:TEMP\st.txt`,
      then read the report: it must end with `RESULT: OK`.
    - Web app: *not yet automated (see W9.2).* Until it's deployed, check the site at
      https://linguagraph.github.io/elanero-pdf-editor/ (landing page and guide).
15. **Rollback.** Never force-push, and never move or delete a pushed tag: tags are the public
    source for the AGPL. To undo a bad change, run `git revert <sha>` on a branch, open a PR, and
    merge it like any other. Ship the fix as a new version and tag, since the Store needs a higher
    version. The Store job can't replace a submission still in certification, so wait for that
    to finish. Web rollback: *not yet automated (see W9.2)*; until then, ship the fix as a release.

## One-time setup

- **Windows SDK:** provides `makeappx`, `makepri`, `signtool` and the App Certification Kit
  (`appcert`), used only at build time.
- **Visual Studio Build Tools** with the "Desktop development with C++" workload, then, in the
  repository's environment:

  ```sh
  uv run python scripts/build_bootloader.py
  ```

  This compiles PyInstaller's launcher locally (issue #90). The prebuilt one in PyInstaller's
  wheel matches malware packed with PyInstaller, and the Store's security scan rejected a
  package built with it. MSIX builds stop if the local launcher is missing; run the script
  again after reinstalling or upgrading PyInstaller (`--check` reports which launcher is in
  use).
- **Store identity:** copy `packaging/msix/identity.example.json` to
  `packaging/msix/identity.json` and fill in the values from Partner Center ▸ Elanero ▸
  Product management ▸ Product identity:

  | Partner Center | `identity.json` |
  |---|---|
  | Package/Identity/Name | `name` |
  | Package/Identity/Publisher (`CN=…`) | `publisher` |
  | Package/Properties/PublisherDisplayName | `publisher_display_name` |

  Then set `"reserved": true`. `identity.json` is git-ignored and must not be pushed. Without
  it the build uses the example's test identity, which the Store rejects.

## Making a release

Pushing the tag (step 3) starts `.github/workflows/release.yml`:

- **Tests and build:** runs the whole of CI: every test on Windows and Linux, the performance
  budgets and the install tests. CI doesn't run after a merge, so this is what proves the commit.
  It also makes the release's only build of the app, and every package comes from that build.
- **GitHub release:** attaches that `Elanero.exe` and installer to a release for the tag (step 8).
  If this or the Store job fails, re-run just the failed job: nothing is built or tested again.
- **Microsoft Store:** waits for your approval in Actions (the `microsoft-store` environment),
  then packs that build as an MSIX with the Partner Center identity, uploads it, sends the listing
  from `packaging/store/listing-en.md` and submits it for certification. No visit to Partner
  Center is needed. Your approval is the last human check, so look at the What's New text before
  approving. This only works for updates: the API can't create the first submission, and it fails
  while another submission is in certification.

**Listing:** a release checks the listing before building anything. It stops if a section is
missing, a Store limit is exceeded, or **What's new in this version** is the same as in the last
tag. Update that section in the same PR that raises the version. For a release with no user-facing
changes, put `[same-whats-new]` in the tag's message. Images, pricing, age ratings and other
Partner Center settings aren't sent, and stay as they are.

**To stop at the draft,** for example to check a changed listing, set the repository variable
`STORE_SUBMIT` to `false`. The job then stops before committing. A draft made this way still shows
the previous package, because only the commit makes the Store process the new one, so submitting
it from Partner Center could ship the old package. Delete it there and release again with the
variable removed, or follow the manual steps below.

Its secrets live only in that environment: `MSIX_IDENTITY_JSON` (the content of
`identity.json`) and the Partner Center API credentials `MSSTORE_TENANT_ID`,
`MSSTORE_CLIENT_ID`, `MSSTORE_CLIENT_SECRET`, `MSSTORE_SELLER_ID` and `MSSTORE_PRODUCT_ID`
(issue #88). Renew the client secret in Entra ID before it expires and update
`MSSTORE_CLIENT_SECRET`. The manual steps below still apply when the workflow can't be used.

1. **Version.** Set every version as the Release checklist's step 1 lists. The Store version is
   `X.Y.Z.0`, and each upload must be higher than the last.
2. **Checks.** The PR's CI is green. The last nightly run on `main` should be too: it runs what
   pull requests skip, and it tests the merged code together.
3. **Tag.** Tag the release commit and push the tag, so every shipped build has public source
   (AGPL):

   ```sh
   git tag -a vX.Y.Z -m "Elanero X.Y.Z" && git push origin vX.Y.Z
   ```

4. **Build** from the tagged commit:

   ```sh
   uv run python scripts/build_exe.py --all --clean-env            # dist/Elanero.exe, dist/Elanero/
   uv run python scripts/build_exe.py --skip-build --msix          # dist/Elanero-X.Y.Z-x64.msix
   ```

   The MSIX step checks that every file made it into the package (makeappx sometimes skips
   freshly written files, so it retries), and fails rather than produce a short package.
5. **Test the package locally.** With Developer Mode on, unpack and register it, run the
   self-test through its alias, then remove it:

   ```powershell
   makeappx unpack /p dist\Elanero-X.Y.Z-x64.msix /d build\msix\installed /o
   Add-AppxPackage -Register build\msix\installed\AppxManifest.xml
   elanero --self-test --self-test-report $env:TEMP\st.txt; Get-Content $env:TEMP\st.txt
   Get-AppxPackage *Elanero-PDFEditor* | Remove-AppxPackage
   ```

   The report must say `channel: Microsoft Store` and end with `RESULT: OK`.
6. **Windows App Certification Kit.** In an **administrator** PowerShell (the kit needs
   elevation):

   ```powershell
   $kit = "C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe"; & $kit reset; & $kit test -appxpackagepath "$PWD\dist\Elanero-X.Y.Z-x64.msix" -reportoutputpath "$PWD\build\msix\wack.xml"
   ```

   Fix any failed test before uploading. Two results are expected and don't block
   submission: the optional "Blocked executables" test fails on text such as `cmd` and `reg`
   inside the Python, Qt and MuPDF libraries, and "High-DPI support" warns because Qt sets
   PerMonitorV2 at run time rather than in the exe's manifest.
7. **Upload.** Only for the first submission, or if the workflow can't be used. In Partner
   Center ▸ Elanero, start a submission:
   - **Packages:** upload the unsigned `.msix` from step 4 (build without `--sign-test`).
   - **Store listings:** paste from `packaging/store/listing-en.md` (its wrapped lines are one
     line each on the Store), and add the screenshots and images.
   - **Pricing:** free.
   - **Properties:** category Productivity; privacy URL from the listing file.
   - **Age ratings:** the IARC questionnaire; there's no user-generated content shared online.
   - **Submission options:** paste the certification notes from the listing file.

   The first submission goes to a private audience first; make it public once certified.
8. **GitHub release.** Attach `Elanero.exe`, the installer and the `.msix` to the release for
   the tag.

## Licensing (AGPL)

- Every build we distribute must correspond to a public tag; don't upload a build made from
  uncommitted changes.
- The package contains `LICENSE` and the third-party notices (Help ▸ About shows both, with
  the source link).
- The Store description links to the source.
