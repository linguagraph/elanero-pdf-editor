"""Text from a PDF selection, made ready for a translation request (Qt-free, no I/O).

Text copied out of a PDF comes with a line break at the end of every line, so a sentence
split over three lines would be sent to the service as three fragments. ``clean_pdf_text``
joins those lines back. ``split_chunks`` then cuts the result into pieces that fit a
service's request limit, preferring sentence and word boundaries so the translator still
sees whole sentences.
"""

from __future__ import annotations

import re

_PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n+")
_SPACES = re.compile(r"[ \t]+")
# A word broken at the end of a line: "trans-" then "lation" on the next line.
_HYPHEN_BREAK = re.compile(r"([^\W\d_]+)-$")
_FIRST_WORD = re.compile(r"[^\W\d_]+")
# Soft hyphens are invisible; the Unicode and non-breaking hyphens mean a plain hyphen.
_INVISIBLE = str.maketrans({chr(0xAD): None, chr(0x2010): "-", chr(0x2011): "-"})


# After a hyphenated break these words are a separate word, so the hyphen stays: 'Ein- und'.
def _cyrillic(*codes: int) -> str:
    return "".join(chr(code) for code in codes)


_FUNCTION_WORDS = frozenset(
    [
        "und",
        "oder",
        "bzw",
        "and",
        "or",
        "nor",
        "et",
        "ou",
        "y",
        "o",
        "e",
        _cyrillic(0x438),
        _cyrillic(0x438, 0x43B, 0x438),
        _cyrillic(0x430),
        _cyrillic(0x43D, 0x43E),
    ],
)
# CJK sentences end without a space, so the punctuation alone is a boundary there.
# The ideographic and full-width stops (U+3002, U+FF01, U+FF1F).
_CJK_STOPS = "".join(chr(code) for code in (0x3002, 0xFF01, 0xFF1F))
_SENTENCE_END = re.compile(rf"(?<=[.!?])\s+|(?<=[{_CJK_STOPS}])")


def clean_pdf_text(text: str) -> str:
    """Join the hard line breaks inside each paragraph, keep the paragraph breaks.

    A line that ends with a hyphen and is followed by a line starting with a lowercase letter
    is a word split by the line break. Then:

    * if the next word is a conjunction or function word ("Ein-" / "und"), the hyphen stays
      and the break becomes a space: "Ein- und";
    * if the hyphenated word ("well-known") occurs elsewhere in the text, it's a real compound:
      the hyphen stays and the break goes: "well-known";
    * otherwise the hyphen was a line-break hyphen: it goes and the parts join: "translation".

    Any other break becomes a space.
    """
    text = text.translate(_INVISIBLE)
    # The whole text with every break as a space, to look for hyphenated words elsewhere.
    flat = " ".join(text.split())
    paragraphs: list[str] = []
    for block in _PARAGRAPH_BREAK.split(text.replace("\r\n", "\n").replace("\r", "\n")):
        out = ""
        for line in block.split("\n"):
            line = _SPACES.sub(" ", line).strip(" ")
            if not line:
                continue
            if not out:
                out = line
                continue
            broken = _HYPHEN_BREAK.search(out)
            following = _FIRST_WORD.match(line)
            if broken is None or following is None or not line[0].islower():
                out = f"{out} {line}"
                continue
            before, after = broken.group(1), following.group(0)
            if after.lower() in _FUNCTION_WORDS:
                out = f"{out} {line}"  # "Ein- und": the hyphen belongs to the first word
            elif _seen_elsewhere(before, after, flat):
                out = f"{out}{line}"  # "well-" + "known"
            else:
                out = f"{out[:-1]}{line}"  # "trans-" + "lation": a line-break hyphen
        if out:
            paragraphs.append(out)
    return "\n\n".join(paragraphs)


def _seen_elsewhere(before: str, after: str, flat: str) -> bool:
    pattern = rf"(?<![^\W\d_]){re.escape(before)}-{re.escape(after)}(?![^\W\d_])"
    return re.search(pattern, flat, re.IGNORECASE) is not None


def utf8_len(text: str) -> int:
    return len(text.encode("utf-8"))


def _fitting_prefix(text: str, max_bytes: int) -> int:
    """How many leading characters of ``text`` fit in ``max_bytes`` UTF-8 bytes. Counting
    whole characters means a multi-byte character is never cut in half."""
    used = 0
    for index, char in enumerate(text):
        used += len(char.encode("utf-8"))
        if used > max_bytes:
            return index
    return len(text)


def _cut(window: str) -> int:
    """Where to cut ``window`` (which is too long for the whole text to stay in one chunk):
    after the last sentence, else after the last whitespace, else anywhere."""
    best = 0
    for match in _SENTENCE_END.finditer(window):
        best = match.end()
    if best:
        return best
    for index in range(len(window) - 1, 0, -1):
        if window[index].isspace():
            return index + 1
    return max(1, len(window))


def split_chunks(text: str, max_bytes: int) -> list[str]:
    """Cut ``text`` into chunks of at most ``max_bytes`` UTF-8 bytes each.

    The chunks keep their trailing whitespace, so ``"".join(chunks) == text`` always holds and
    the caller can put the paragraph breaks back after translating each chunk.
    """
    if max_bytes < 4:  # one UTF-8 character is up to 4 bytes; less can't make progress
        raise ValueError("max_bytes must allow at least one character")
    chunks: list[str] = []
    rest = text
    while rest:
        fit = _fitting_prefix(rest, max_bytes)
        if fit == len(rest):
            chunks.append(rest)
            break
        cut = _cut(rest[:fit])
        chunks.append(rest[:cut])
        rest = rest[cut:]
    return chunks
