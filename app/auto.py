"""Automatic table extraction.

For text PDFs we first try pdfplumber's ruled-table detection (great when the
statement has drawn grid lines).  When that finds nothing useful — which is the
common case for bank statements that align columns with whitespace only — we
fall back to the geometry-based word clustering in :mod:`app.words`, which also
handles OCR output from scanned pages.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pdfplumber

from .heuristics import clean_amount, guess_labels, header_score, is_amount
from .pdfdoc import PdfDocument
from .words import (
    Word,
    cluster_rows,
    detect_column_bounds,
    rows_to_matrix,
)


@dataclass
class ExtractedTable:
    page: int  # 1-based for display
    source: str  # "text-grid" | "text-layout" | "ocr-layout"
    columns: list[str]
    rows: list[list[str]]
    column_separators: list[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "page": self.page,
            "source": self.source,
            "columns": self.columns,
            "rows": self.rows,
            "column_separators": [round(s, 5) for s in self.column_separators],
        }


def _clean_matrix(matrix: list[list[str]]) -> list[list[str]]:
    cleaned: list[list[str]] = []
    for row in matrix:
        new_row = [clean_amount(c) if is_amount(c) else c for c in row]
        if any(cell.strip() for cell in new_row):
            cleaned.append(new_row)
    return cleaned


def _split_header(matrix: list[list[str]]) -> tuple[list[str], list[list[str]]]:
    """Pick the most header-like of the first few rows as column labels."""
    if not matrix:
        return [], []
    best_idx, best = -1, 1  # require at least 2 keyword hits to call it a header
    for i, row in enumerate(matrix[: min(4, len(matrix))]):
        s = header_score(row)
        if s > best:
            best, best_idx = s, i
    n_cols = max(len(r) for r in matrix)
    if best_idx >= 0:
        header = matrix[best_idx] + [""] * (n_cols - len(matrix[best_idx]))
        body = matrix[best_idx + 1 :]
        return guess_labels(header), body
    return [f"Column {i + 1}" for i in range(n_cols)], matrix


def _layout_table(words: list[Word], page_1based: int, source: str) -> ExtractedTable | None:
    rows = cluster_rows(words)
    if len(rows) < 2:
        return None
    seps = detect_column_bounds(rows)
    matrix = _clean_matrix(rows_to_matrix(rows, seps))
    if not matrix:
        return None
    columns, body = _split_header(matrix)
    if not body:
        body = matrix
    return ExtractedTable(
        page=page_1based,
        source=source,
        columns=columns,
        rows=body,
        column_separators=seps,
    )


def _plumber_tables(data: bytes, index: int, page_1based: int) -> list[ExtractedTable]:
    tables: list[ExtractedTable] = []
    try:
        with _open(data) as pdf:
            page = pdf.pages[index]
            found = page.extract_tables()
    except Exception:
        return []
    for raw in found or []:
        matrix = [[(c or "").strip() for c in row] for row in raw]
        matrix = _clean_matrix(matrix)
        if len(matrix) < 2:
            continue
        columns, body = _split_header(matrix)
        tables.append(
            ExtractedTable(
                page=page_1based,
                source="text-grid",
                columns=columns,
                rows=body or matrix,
            )
        )
    return tables


def _open(data: bytes):
    import io

    return pdfplumber.open(io.BytesIO(data))


def extract_page(
    pdf: PdfDocument, data: bytes, index: int, force_ocr: bool = False
) -> ExtractedTable | None:
    """Extract the best single table from one page (0-based ``index``)."""
    page_1based = index + 1
    info = pdf.page_info(index)

    if not force_ocr and not info.is_scanned:
        # Prefer a ruled table if one is clearly present.
        grid = _plumber_tables(data, index, page_1based)
        if grid:
            # Choose the table with the most rows.
            return max(grid, key=lambda t: len(t.rows))

    words, source = pdf.words(index, force_ocr=force_ocr)
    src = "ocr-layout" if source == "ocr" else "text-layout"
    return _layout_table(words, page_1based, src)


def extract_document(
    pdf: PdfDocument, data: bytes, pages: list[int] | None = None, force_ocr: bool = False
) -> list[ExtractedTable]:
    indices = pages if pages is not None else list(range(pdf.page_count))
    out: list[ExtractedTable] = []
    for idx in indices:
        if idx < 0 or idx >= pdf.page_count:
            continue
        table = extract_page(pdf, data, idx, force_ocr=force_ocr)
        if table and table.rows:
            out.append(table)
    return out


def merge_tables(tables: list[ExtractedTable]) -> ExtractedTable:
    """Combine per-page tables into one, aligning on the widest column set.

    Useful when a statement's transaction table spans many pages; rows are
    concatenated and a ``Page`` column records their origin.
    """
    if not tables:
        return ExtractedTable(page=0, source="merged", columns=[], rows=[])
    width = max(len(t.columns) for t in tables)
    base_cols = next((t.columns for t in tables if len(t.columns) == width), tables[0].columns)
    columns = ["Page"] + list(base_cols)
    rows: list[list[str]] = []
    for t in tables:
        for r in t.rows:
            padded = list(r) + [""] * (width - len(r))
            rows.append([str(t.page)] + padded[:width])
    return ExtractedTable(page=0, source="merged", columns=columns, rows=rows)
