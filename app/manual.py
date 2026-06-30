"""Manual / template-based extraction.

The user defines a *template* for one or more pages in the browser:

* an optional ``region`` rectangle that bounds the table area,
* a list of ``column_separators`` (normalized x positions) that split the area
  into columns,
* optional ``row_lines`` (normalized y positions) to force explicit row breaks
  instead of automatic vertical clustering,
* optional ``column_names`` and a ``header_row`` flag.

All coordinates are normalized (0..1) exactly as produced by the frontend, so
the same template works whether the page is read from the text layer or via OCR.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .auto import ExtractedTable
from .heuristics import clean_amount, guess_labels, is_amount
from .pdfdoc import PdfDocument
from .words import (
    Region,
    Word,
    assign_to_columns,
    cluster_rows,
    words_in_region,
)


@dataclass
class PageTemplate:
    page: int  # 0-based
    region: Region | None = None
    column_separators: list[float] = field(default_factory=list)
    row_lines: list[float] = field(default_factory=list)
    column_names: list[str] = field(default_factory=list)
    header_row: bool = False
    force_ocr: bool = False

    @staticmethod
    def from_dict(d: dict) -> "PageTemplate":
        region = None
        if d.get("region"):
            r = d["region"]
            region = Region(float(r["x0"]), float(r["y0"]), float(r["x1"]), float(r["y1"]))
        return PageTemplate(
            page=int(d["page"]),
            region=region,
            column_separators=[float(x) for x in d.get("column_separators", [])],
            row_lines=[float(y) for y in d.get("row_lines", [])],
            column_names=[str(c) for c in d.get("column_names", [])],
            header_row=bool(d.get("header_row", False)),
            force_ocr=bool(d.get("force_ocr", False)),
        )


def _rows_by_lines(words: list[Word], row_lines: list[float]) -> list[list[Word]]:
    """Split words into rows using explicit horizontal separators."""
    lines = sorted(row_lines)
    buckets: list[list[Word]] = [[] for _ in range(len(lines) + 1)]
    for w in words:
        idx = 0
        while idx < len(lines) and w.cy > lines[idx]:
            idx += 1
        buckets[idx].append(w)
    rows = [sorted(b, key=lambda w: w.x0) for b in buckets if b]
    return rows


def apply_template(pdf: PdfDocument, tmpl: PageTemplate) -> ExtractedTable:
    words, source = pdf.words(tmpl.page, force_ocr=tmpl.force_ocr)
    words = words_in_region(words, tmpl.region)

    if tmpl.row_lines:
        rows = _rows_by_lines(words, tmpl.row_lines)
    else:
        rows = cluster_rows(words)

    seps = sorted(tmpl.column_separators)
    matrix: list[list[str]] = []
    for row in rows:
        cells = assign_to_columns(row, seps)
        cells = [clean_amount(c) if is_amount(c) else c for c in cells]
        if any(c.strip() for c in cells):
            matrix.append(cells)

    n_cols = len(seps) + 1
    if tmpl.column_names:
        columns = list(tmpl.column_names)[:n_cols]
        columns += [f"Column {i + 1}" for i in range(len(columns), n_cols)]
        body = matrix
    elif tmpl.header_row and matrix:
        columns = guess_labels(matrix[0])
        columns += [f"Column {i + 1}" for i in range(len(columns), n_cols)]
        body = matrix[1:]
    else:
        columns = [f"Column {i + 1}" for i in range(n_cols)]
        body = matrix

    src = "ocr-manual" if source == "ocr" else "text-manual"
    return ExtractedTable(
        page=tmpl.page + 1,
        source=src,
        columns=columns,
        rows=body,
        column_separators=seps,
    )


def apply_templates(pdf: PdfDocument, templates: list[PageTemplate]) -> list[ExtractedTable]:
    out: list[ExtractedTable] = []
    for tmpl in templates:
        if 0 <= tmpl.page < pdf.page_count:
            out.append(apply_template(pdf, tmpl))
    return out
