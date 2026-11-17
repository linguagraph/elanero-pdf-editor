"""The website contract (issue #129): the landing page in docs/landing, the redirect stubs and the
site assembly in scripts/build_site.py. The page is checked as text (stdlib html.parser), so no
browser or network is needed."""

from __future__ import annotations

import importlib
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from pdfeditor import DOCS_URL, PRIVACY_URL, SOURCE_URL, WEBSITE_URL, __version__

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "scripts"))
# build_site imports PyYAML, which is not in the Pyodide package set: the web run skips this module.
pytest.importorskip("yaml")
bs = importlib.import_module("build_site")

LANDING = bs.LANDING
GUIDE_IMAGES = bs.ROOT / "docs" / "guide" / "images"
# Prefix of the absolute paths the 404 page uses (GitHub Pages serves it at any unknown URL).
SITE_PREFIX = "/elanero-pdf-editor/"
# Attributes that make the browser fetch something (navigation links are checked separately).
LOAD_ATTRS = ("src", "srcset", "poster", "data")
CSS_URL = re.compile(r"""url\(\s*['"]?([^'")\s]+)""")
CSS_IMPORT = re.compile(r"""@import\s+(?:url\(\s*)?['"]?([^'";)\s]+)""")


class _Tags(HTMLParser):
    """Every start tag of a page, with its attributes."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[tuple[str, dict[str, str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append((tag, {name: value or "" for name, value in attrs}))


def _tags(name: str) -> list[tuple[str, dict[str, str]]]:
    parser = _Tags()
    parser.feed((LANDING / name).read_text(encoding="utf-8"))
    return parser.tags


def _is_canonical(tag: str, attrs: dict[str, str]) -> bool:
    return tag == "link" and "canonical" in attrs.get("rel", "").split()


def _is_absolute(url: str) -> bool:
    parts = urlsplit(url)
    return bool(parts.scheme or parts.netloc)


def _links(name: str) -> list[str]:
    """Every href of a page, navigation links and the canonical link included."""
    return [attrs["href"] for tag, attrs in _tags(name) if "href" in attrs]


def _loads(name: str) -> list[str]:
    """Every URL the page fetches on its own: stylesheets, icons, images, scripts."""
    urls: list[str] = []
    for tag, attrs in _tags(name):
        if tag in ("a", "meta") or _is_canonical(tag, attrs):
            continue
        urls.extend(attrs[attr] for attr in LOAD_ATTRS if attr in attrs)
        if "href" in attrs:
            urls.append(attrs["href"])
    return urls


def _css_urls(name: str) -> list[str]:
    text = (LANDING / name).read_text(encoding="utf-8")
    return CSS_URL.findall(text) + CSS_IMPORT.findall(text)


def _is_allowed_local(path: str) -> bool:
    """A site-internal path (no leading slash) that the contract allows and that exists."""
    if path == "":
        return True  # the site root
    if path == "landing.css":
        return (LANDING / "landing.css").is_file()
    if path in {f"assets/{name}" for _, name in bs.ASSETS}:
        return True
    if path == "guide/":
        return True
    if path.startswith("guide/images/"):
        rest = path[len("guide/images/") :]
        return "/" not in rest and (GUIDE_IMAGES / rest).is_file()
    if path.startswith("guide/") and path.endswith("/"):
        return path[len("guide/") : -1] in set(bs.nav_pages(bs.CONFIG))
    return False


def _local_problem(url: str, prefix: str = "") -> str | None:
    """Why a site-internal URL doesn't resolve, or None when it does. ``prefix`` is the site's
    absolute path (the 404 page uses one); the index page uses relative URLs."""
    parts = urlsplit(url)
    if parts.scheme or parts.netloc:
        return "absolute"
    path = parts.path
    if not path:
        return None  # a same-page #anchor, or an empty href: checked by the anchor test
    if prefix:
        if not path.startswith(prefix):
            return f"not under {prefix}"
        path = path[len(prefix) :]
    elif path.startswith("/"):
        return "root-absolute"
    return None if _is_allowed_local(path) else "does not resolve"


def _ids(name: str) -> set[str]:
    return {attrs[key] for _, attrs in _tags(name) for key in ("id", "name") if attrs.get(key)}


# --- the page's contract -------------------------------------------------------------------


def test_every_relative_link_and_resource_resolves() -> None:
    """A link to a page or file that doesn't exist would be a 404 on the live site."""
    problems = []
    for tag, attrs in _tags("index.html"):
        for attr in ("href", "src"):
            if attr not in attrs:
                continue
            url = attrs[attr]
            # Outside links are fine on <a> and the canonical link; the third-party test covers
            # everything the browser fetches.
            if (tag == "a" or _is_canonical(tag, attrs)) and _is_absolute(url):
                continue
            if url.startswith("#"):
                continue
            problem = _local_problem(url)
            if problem:
                problems.append(f"<{tag} {attr}={url!r}>: {problem}")
    assert problems == []


def test_every_anchor_has_a_target_on_the_page() -> None:
    """A '#section' link to a missing id jumps nowhere, silently."""
    ids = _ids("index.html")
    fragment_links = [link for link in _links("index.html") if link.startswith("#")]
    assert fragment_links, "the page should link to its own sections"
    missing = [link for link in fragment_links if link[1:] not in ids]
    assert missing == []


def test_no_third_party_requests_in_the_page_css_or_404() -> None:
    """The site loads nothing from another host: no analytics, fonts or scripts, so the page
    keeps the no-telemetry promise and the privacy notes stay true."""
    failures = []
    for name in ("index.html", "404.html"):
        for tag, attrs in _tags(name):
            if tag == "script" and "src" in attrs:
                failures.append(f"{name}: <script src={attrs['src']!r}>")
        failures += [f"{name}: {url}" for url in _loads(name) if _is_absolute(url)]
    failures += [f"landing.css: {url}" for url in _css_urls("landing.css") if _is_absolute(url)]
    assert failures == []
    # The check must see the stylesheet, or it would pass on an empty list.
    assert "landing.css" in _loads("index.html")


def test_the_404_page_uses_site_absolute_paths_that_resolve() -> None:
    """The 404 page can be reached from any address, so its links are absolute to the site."""
    problems = []
    for tag, attrs in _tags("404.html"):
        for attr in ("href", "src"):
            if attr not in attrs or attrs[attr].startswith("#"):
                continue
            url = attrs[attr]
            if (tag == "a" or _is_canonical(tag, attrs)) and _is_absolute(url):
                continue
            problem = _local_problem(url, prefix=SITE_PREFIX)
            if problem:
                problems.append(f"<{tag} {attr}={url!r}>: {problem}")
    assert problems == []


def test_the_page_links_to_the_repo_downloads_store_guide_privacy_and_issues() -> None:
    links = set(_links("index.html"))
    required = {
        SOURCE_URL,
        SOURCE_URL + "/releases/latest",
        SOURCE_URL + "/releases/latest/download/Elanero.exe",
        "guide/",
        PRIVACY_URL,
        SOURCE_URL + "/issues",
    }
    assert required <= links
    # The product page, not a search: a search can list other apps first.
    assert "https://apps.microsoft.com/detail/9pldq042g3th" in links


def test_every_image_has_alt_text_and_a_size() -> None:
    """Alt text for screen readers; width and height so the layout doesn't jump while loading.

    A screenshot needs a description. The logo sits next to the name "Elanero", so it is
    decorative: its alt is present but empty, which tells a screen reader to skip it.
    """
    images = [attrs for tag, attrs in _tags("index.html") if tag == "img"]
    screenshots = [attrs for attrs in images if (attrs.get("src") or "").startswith("guide/")]
    assert screenshots, "the page shows screenshots"
    for attrs in images:
        assert "alt" in attrs, attrs
        assert attrs.get("width") and attrs.get("height"), attrs
    for attrs in screenshots:
        assert (attrs.get("alt") or "").strip(), attrs


def test_one_h1_and_english_language() -> None:
    tags = _tags("index.html")
    assert sum(1 for tag, _ in tags if tag == "h1") == 1
    html_tags = [attrs for tag, attrs in tags if tag == "html"]
    assert html_tags and html_tags[0].get("lang") == "en"


def test_the_page_has_no_version_number() -> None:
    """The page must not go stale at each release, so the version is never written in it."""
    assert __version__ not in (LANDING / "index.html").read_text(encoding="utf-8")


def test_the_canonical_link_is_the_website_root() -> None:
    canonical = [attrs["href"] for tag, attrs in _tags("index.html") if _is_canonical(tag, attrs)]
    assert canonical == [WEBSITE_URL]


# --- the addresses -------------------------------------------------------------------------


def test_the_guide_address_is_under_the_website() -> None:
    assert WEBSITE_URL.endswith("/")
    assert DOCS_URL == WEBSITE_URL + "guide/"


# --- the site assembly ---------------------------------------------------------------------


def test_assemble_writes_the_landing_page_assets_and_one_stub_per_guide_page(
    tmp_path: Path,
) -> None:
    bs.assemble(tmp_path)
    for name in ("index.html", "landing.css", "404.html"):
        assert (tmp_path / name).is_file(), name
    for _, name in bs.ASSETS:
        assert (tmp_path / "assets" / name).is_file(), name

    stems = bs.nav_pages(bs.CONFIG)
    # Only the stubs and the landing page: no other index.html should appear.
    stubs = {
        path.parent.relative_to(tmp_path).as_posix()
        for path in tmp_path.rglob("index.html")
        if path.parent != tmp_path
    }
    assert stubs == set(stems)
    for stem in stems:
        text = (tmp_path / stem / "index.html").read_text(encoding="utf-8")
        depth = "../" * (stem.count("/") + 1)
        target = f"{depth}guide/{stem}/"
        assert f'content="0; url={target}"' in text, stem
        assert f'href="{target}"' in text, stem
        # The script keeps the #anchor, so an old deep link still lands on its section.
        assert "location.replace(" in text and "location.hash" in text, stem
        assert 'name="robots" content="noindex"' in text, stem


def test_the_stubs_and_branding_assets_match_their_sources(tmp_path: Path) -> None:
    bs.assemble(tmp_path)
    for source, name in bs.ASSETS:
        assert (tmp_path / "assets" / name).read_bytes() == source.read_bytes()


def test_assemble_refuses_a_landing_entry_named_like_a_stub(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A folder named like a stub would be overwritten by it, so the site refuses to build."""
    landing = tmp_path / "landing"
    (landing / "signing").mkdir(parents=True)
    (landing / "signing" / "index.html").write_text("x", encoding="utf-8")
    (landing / "index.html").write_text("x", encoding="utf-8")
    monkeypatch.setattr(bs, "LANDING", landing)
    with pytest.raises(ValueError, match="signing"):
        bs.assemble(tmp_path / "site")


@pytest.mark.parametrize("name", ["guide", "assets"])
def test_assemble_refuses_a_landing_entry_named_like_a_site_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    """The guide and the assets folders belong to the build, so a landing entry can't take them."""
    landing = tmp_path / "landing"
    (landing / name).mkdir(parents=True)
    (landing / "index.html").write_text("x", encoding="utf-8")
    monkeypatch.setattr(bs, "LANDING", landing)
    with pytest.raises(ValueError, match=name):
        bs.assemble(tmp_path / "site")


def test_no_real_landing_entry_collides_with_a_guide_page_or_site_folder() -> None:
    reserved = {stem.split("/")[0] for stem in bs.nav_pages(bs.CONFIG)} | {"guide", "assets"}
    names = {entry.name for entry in LANDING.iterdir()}
    assert names & reserved == set()


def test_every_stub_leads_to_a_page_the_guide_builds() -> None:
    """A stub for a page MkDocs doesn't build would redirect into a 404."""
    stems = bs.nav_pages(bs.CONFIG)
    assert stems
    assert [s for s in stems if not (bs.ROOT / "docs" / "guide" / f"{s}.md").is_file()] == []


def test_the_build_deletes_only_an_empty_folder_or_an_earlier_build(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The output folder is removed first: a mistyped --site-dir must not cost anyone files."""
    precious = tmp_path / "documents"
    precious.mkdir()
    (precious / "thesis.txt").write_text("years of work", encoding="utf-8")
    with pytest.raises(SystemExit):
        bs.main(["--site-dir", str(precious), "--skip-guide"])
    assert (precious / "thesis.txt").read_text(encoding="utf-8") == "years of work"
    assert "would be deleted" in capsys.readouterr().err

    for folder in (bs.ROOT, bs.ROOT / "docs", bs.ROOT.parent):
        assert not bs._replaceable(folder), folder

    site = tmp_path / "site"
    assert bs.main(["--site-dir", str(site), "--skip-guide"]) == 0
    (site / "stale.html").write_text("left over", encoding="utf-8")
    # An earlier build is replaced, leftovers and all.
    assert bs.main(["--site-dir", str(site), "--skip-guide"]) == 0
    assert (site / "index.html").is_file() and not (site / "stale.html").exists()


def test_the_build_runs_mkdocs_strictly_into_the_guide_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """--strict makes broken links and pages missing from the nav fail the build."""
    commands: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(bs.subprocess, "run", fake_run)
    monkeypatch.setattr(bs, "check_landing", lambda *args, **kwargs: None)
    monkeypatch.setattr(bs, "assemble", lambda site_dir: None)
    site = tmp_path / "site"
    assert bs.main(["--site-dir", str(site)]) == 0
    (command,) = commands
    assert command[:4] == [sys.executable, "-m", "mkdocs", "build"]
    assert "--strict" in command
    assert command[command.index("--site-dir") + 1] == str(site / "guide")


def test_a_failed_guide_build_stops_the_site_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A broken guide must fail the whole site, and no half-built site is assembled."""
    monkeypatch.setattr(
        bs.subprocess,
        "run",
        lambda command, **_: subprocess.CompletedProcess(command, 3),
    )
    monkeypatch.setattr(bs, "check_landing", lambda *args, **kwargs: None)
    assembled: list[Path] = []
    monkeypatch.setattr(bs, "assemble", lambda site_dir: assembled.append(site_dir))
    assert bs.main(["--site-dir", str(tmp_path / "site")]) == 3
    assert assembled == []
