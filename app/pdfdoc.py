"""PDF wrapper: page rendering, vector-text words, and OCR words.

Both text and OCR paths return :class:`~app.words.Word` objects in *normalized*
page coordinates so downstream extraction is identical regardless of source.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from functools import lru_cache

import fitz  # PyMuPDF
import numpy as np
import pytesseract
from PIL import Image

from .words import Word

# DPI used when rasterizing a page for OCR.  300 is the tesseract sweet spot for
# document text; higher mostly costs time.
OCR_DPI = 300
# A page is treated as "scanned" (needs OCR) when it has fewer than this many
# vector characters yet clearly carries ink (an image covering the page).
MIN_CHARS_FOR_TEXT = 8


@dataclass
class PageInfo:
    index: int  # 0-based
    width_pt: float
    height_pt: float
    is_scanned: bool
    char_count: int


class PdfDocument:
    def __init__(self, data: bytes):
        self._data = data
        self.doc = fitz.open(stream=data, filetype="pdf")

    def close(self) -> None:
        try:
            self.doc.close()
        except Exception:
            pass

    @property
    def page_count(self) -> int:
        return self.doc.page_count

    # -- metadata -------------------------------------------------------------

    def page_info(self, index: int) -> PageInfo:
        page = self.doc[index]
        rect = page.rect
        text = page.get_text("text")
        char_count = len(text.strip())
        has_images = bool(page.get_images(full=True))
        is_scanned = char_count < MIN_CHARS_FOR_TEXT and (has_images or char_count == 0)
        return PageInfo(
            index=index,
            width_pt=rect.width,
            height_pt=rect.height,
            is_scanned=is_scanned,
            char_count=char_count,
        )

    def all_page_info(self) -> list[PageInfo]:
        return [self.page_info(i) for i in range(self.page_count)]

    # -- rendering ------------------------------------------------------------

    def render_png(self, index: int, dpi: int = 150) -> bytes:
        page = self.doc[index]
        zoom = dpi / 72.0
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        return pix.tobytes("png")

    def _render_image(self, index: int, dpi: int) -> Image.Image:
        page = self.doc[index]
        zoom = dpi / 72.0
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

    # -- words ----------------------------------------------------------------

    def vector_words(self, index: int) -> list[Word]:
        """Words from the PDF text layer, normalized to the page box."""
        page = self.doc[index]
        rect = page.rect
        w_pt, h_pt = rect.width or 1.0, rect.height or 1.0
        out: list[Word] = []
        # get_text("words") -> (x0, y0, x1, y1, "word", block, line, word_no)
        for x0, y0, x1, y1, text, *_ in page.get_text("words"):
            text = text.strip()
            if not text:
                continue
            out.append(
                Word(
                    text=text,
                    x0=x0 / w_pt,
                    y0=y0 / h_pt,
                    x1=x1 / w_pt,
                    y1=y1 / h_pt,
                    conf=None,
                )
            )
        return out

    def ocr_words(self, index: int, dpi: int = OCR_DPI, min_conf: float = 30.0) -> list[Word]:
        """Words produced by Tesseract OCR on a rasterized page."""
        img = self._render_image(index, dpi)
        iw, ih = img.size
        # Light preprocessing improves OCR on noisy scans.
        gray = img.convert("L")
        data = pytesseract.image_to_data(
            gray, output_type=pytesseract.Output.DICT, config="--oem 1 --psm 6"
        )
        out: list[Word] = []
        n = len(data["text"])
        for i in range(n):
            text = (data["text"][i] or "").strip()
            if not text:
                continue
            try:
                conf = float(data["conf"][i])
            except (TypeError, ValueError):
                conf = -1.0
            if conf < min_conf:
                continue
            x = data["left"][i]
            y = data["top"][i]
            w = data["width"][i]
            h = data["height"][i]
            out.append(
                Word(
                    text=text,
                    x0=x / iw,
                    y0=y / ih,
                    x1=(x + w) / iw,
                    y1=(y + h) / ih,
                    conf=conf,
                )
            )
        return out

    def words(self, index: int, force_ocr: bool = False) -> tuple[list[Word], str]:
        """Best-available words for a page.

        Returns ``(words, source)`` where source is ``"text"`` or ``"ocr"``.
        Falls back to OCR automatically when the page has no usable text layer.
        """
        info = self.page_info(index)
        if force_ocr or info.is_scanned:
            return self.ocr_words(index), "ocr"
        vw = self.vector_words(index)
        if len(vw) < 2:  # text layer exists but is unusable
            return self.ocr_words(index), "ocr"
        return vw, "text"
