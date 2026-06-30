"""End-to-end checks for the extraction engine on the generated samples."""

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app.auto import extract_document, merge_tables  # noqa: E402
from app.exporter import to_csv, to_excel  # noqa: E402
from app.manual import PageTemplate, apply_templates  # noqa: E402
from app.pdfdoc import PdfDocument  # noqa: E402
from app.words import Region  # noqa: E402

SAMPLES = os.path.join(ROOT, "samples")
TEXT_PDF = os.path.join(SAMPLES, "text_statement.pdf")
SCANNED_PDF = os.path.join(SAMPLES, "scanned_statement.pdf")


@pytest.fixture(scope="module", autouse=True)
def _ensure_samples():
    # Samples are generated artifacts (not committed); build them on demand.
    if not (os.path.exists(TEXT_PDF) and os.path.exists(SCANNED_PDF)):
        from tests.make_samples import build_scanned_pdf, build_text_pdf

        build_text_pdf(TEXT_PDF)
        build_scanned_pdf(TEXT_PDF, SCANNED_PDF)


def _load(path: str):
    with open(path, "rb") as fh:
        data = fh.read()
    return data, PdfDocument(data)


def test_text_pdf_is_not_scanned():
    data, pdf = _load(TEXT_PDF)
    info = pdf.page_info(0)
    assert not info.is_scanned
    assert info.char_count > 50


def test_scanned_pdf_detected():
    data, pdf = _load(SCANNED_PDF)
    info = pdf.page_info(0)
    assert info.is_scanned


def test_auto_extract_text():
    data, pdf = _load(TEXT_PDF)
    tables = extract_document(pdf, data)
    assert tables
    table = tables[0]
    # All six statement columns are detected and the header row is recognised,
    # even though full-width title/account lines span the page above the table.
    assert table.columns == ["Date", "Description", "Ref", "Debit", "Credit", "Balance"]
    flat = " ".join(" ".join(r) for r in table.rows)
    assert "SALARY CREDIT ACME LTD" in flat
    assert "85000.00" in flat  # amount normalized (comma stripped)
    # Date and Description must not be merged into one column.
    assert table.rows[2][0] == "05/04/2024"
    assert table.rows[2][1] == "SALARY CREDIT ACME LTD"
    assert len(table.rows) >= 8


def test_auto_extract_scanned_ocr():
    data, pdf = _load(SCANNED_PDF)
    tables = extract_document(pdf, data)
    assert tables
    flat = " ".join(" ".join(r) for r in tables[0].rows).upper()
    # OCR is fuzzy; check for robust tokens.
    assert "SALARY" in flat
    assert "BALANCE" in flat or "12500" in flat.replace(",", "")


def test_manual_template_columns():
    data, pdf = _load(TEXT_PDF)
    # Column separators between the six columns (normalized x on a 595pt page).
    seps = [x / 595.0 for x in (100, 295, 355, 425, 500)]
    tmpl = PageTemplate(
        page=0,
        region=Region(0.04, 0.12, 0.98, 0.40),
        column_separators=seps,
        header_row=True,
    )
    tables = apply_templates(pdf, [tmpl])
    assert tables
    table = tables[0]
    assert len(table.columns) == 6
    # Header row should have been consumed into column names.
    assert any("Balance" in c for c in table.columns)
    flat = " ".join(" ".join(r) for r in table.rows)
    assert "ATM WITHDRAWAL MG ROAD" in flat


def test_export_roundtrip():
    data, pdf = _load(TEXT_PDF)
    tables = extract_document(pdf, data)
    csv_bytes = to_csv(tables)
    xlsx_bytes = to_excel(tables)
    assert csv_bytes and b"SALARY" in csv_bytes
    assert xlsx_bytes[:2] == b"PK"  # xlsx is a zip


def test_merge_multipage():
    data, pdf = _load(TEXT_PDF)
    tables = extract_document(pdf, data)
    merged = merge_tables(tables + tables)  # simulate two pages
    assert merged.columns[0] == "Page"
    assert len(merged.rows) == 2 * len(tables[0].rows)
