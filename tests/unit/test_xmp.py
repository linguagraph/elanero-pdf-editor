from __future__ import annotations

import logging
import shutil
from pathlib import Path

import pytest

from pdfeditor.core.commands import SetMetadataCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.core.xmp import MAX_PACKET_BYTES, read_xmp_field, sync_xmp
from pdfeditor.model.metadata import Metadata

PDFA = """<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
  xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdfaid:part="2" pdfaid:conformance="B"
  pdf:Producer="Old producer"/>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>"""


def test_new_packet_from_info() -> None:
    xml = sync_xmp("", Metadata(title="Report", author="Ann", keywords="a, b"))
    assert xml.startswith("<?xpacket begin")
    assert read_xmp_field(xml, "dc", "title") == "Report"
    assert read_xmp_field(xml, "dc", "creator") == "Ann"
    assert read_xmp_field(xml, "pdf", "Keywords") == "a, b"
    assert sync_xmp("", Metadata()) == ""  # nothing to write: no packet


def test_existing_packet_keeps_other_properties() -> None:
    xml = sync_xmp(PDFA, Metadata(title="T", producer="New producer"))
    assert 'pdfaid:part="2"' in xml  # the PDF/A identification survives
    assert read_xmp_field(xml, "pdf", "Producer") == "New producer"  # attribute form replaced
    assert xml.count("<pdf:Producer") == 1 and "pdf:Producer=" not in xml
    assert read_xmp_field(xml, "dc", "title") == "T"
    cleared = sync_xmp(xml, Metadata(producer="New producer"))
    assert read_xmp_field(cleared, "dc", "title") == ""  # emptied fields are removed


# A packet that declares entities. The billion-laughs body nests them so each level expands
# the one below; the external entity asks the parser to read a local file.
BILLION_LAUGHS = PDFA.replace(
    "<x:xmpmeta",
    '<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">'
    '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>\n<x:xmpmeta',
).replace('pdf:Producer="Old producer"', 'pdf:Producer="&c;"')
EXTERNAL_ENTITY = PDFA.replace(
    "<x:xmpmeta",
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>\n<x:xmpmeta',
).replace('pdf:Producer="Old producer"', 'pdf:Producer="&e;"')
UTF16_DOCTYPE = '<?xml version="1.0" encoding="UTF-16"?>\n' + PDFA.replace(
    "<x:xmpmeta", '<!DOCTYPE x [<!ENTITY a "hi">]>\n<x:xmpmeta'
)
OVERSIZED = PDFA + " " * MAX_PACKET_BYTES  # over the cap by the length of the packet itself
# The UTF-16 packet read back as latin-1 (NUL bytes between the characters), and the same packet
# with a leading BOM character before its DOCTYPE.
UTF16_AS_LATIN1 = ("﻿" + UTF16_DOCTYPE).encode("utf-16").decode("latin-1")
BOM_DOCTYPE = "﻿" + UTF16_DOCTYPE
# Under the cap in characters, over it in UTF-8 bytes (3 bytes per euro sign).
OVERSIZED_UTF8 = PDFA.replace(
    "<x:xmpmeta", "<!--" + "€" * (MAX_PACKET_BYTES // 3 + 1) + "-->\n<x:xmpmeta", 1
)
UNPARSEABLE = "<x:xmpmeta><rdf:RDF"


def _assert_refused(packet: str, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="pdfeditor.core.xmp"):
        assert sync_xmp(packet, Metadata(title="T", producer="New")) == packet
    assert any("XMP packet left unchanged" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize(
    "packet", [BILLION_LAUGHS, EXTERNAL_ENTITY, UTF16_DOCTYPE, UTF16_AS_LATIN1, BOM_DOCTYPE]
)
def test_hostile_packet_is_returned_unchanged_with_a_warning(
    packet: str, caplog: pytest.LogCaptureFixture
) -> None:
    _assert_refused(packet, caplog)
    assert read_xmp_field(packet, "dc", "title") == ""


@pytest.mark.parametrize("packet", [OVERSIZED, OVERSIZED_UTF8, UNPARSEABLE])
def test_oversized_or_unparseable_packet_is_returned_unchanged_with_a_warning(
    packet: str, caplog: pytest.LogCaptureFixture
) -> None:
    _assert_refused(packet, caplog)


def test_entity_free_packet_is_still_edited() -> None:
    xml = sync_xmp(PDFA, Metadata(title="T"))
    assert read_xmp_field(xml, "dc", "title") == "T"


@pytest.mark.desktop_only  # reads the saved file with pikepdf and renders it with pypdfium2
def test_title_edit_keeps_a_hostile_packet_and_round_trips(tmp_path: Path, fixture_pdf) -> None:
    import pikepdf
    import pypdfium2 as pdfium

    seeded = tmp_path / "seeded.pdf"
    source = tmp_path / "source.pdf"
    shutil.copy2(fixture_pdf("report"), source)
    session = DocumentSession.open(source)
    session.document.set_xmp(BILLION_LAUGHS)
    session.save(seeded)
    session.close()

    edited = tmp_path / "edited.pdf"
    session = DocumentSession.open(seeded)
    session.execute(SetMetadataCommand(Metadata(title="Edited title", author="Bo")))
    session.save(edited)
    session.close()

    with pikepdf.open(edited) as pdf:
        packet = pdf.Root.Metadata.read_bytes().decode("utf-8")
        assert packet == BILLION_LAUGHS  # the hostile packet survives the title edit untouched
        assert str(pdf.docinfo["/Title"]) == "Edited title"
    pdf = pdfium.PdfDocument(edited)
    try:
        assert pdf[0].render(scale=1).to_pil().size[0] > 0
    finally:
        pdf.close()
