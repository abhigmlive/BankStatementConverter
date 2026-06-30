"""Generate sample bank-statement PDFs for testing.

Produces:
  samples/text_statement.pdf   -- a vector-text statement (no ruled lines)
  samples/scanned_statement.pdf -- the same content rasterized (image-only),
                                   simulating a scanned document for OCR.
"""

import os

import fitz

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, "samples")
os.makedirs(SAMPLES, exist_ok=True)

HEADER = ["Date", "Description", "Ref", "Debit", "Credit", "Balance"]
ROWS = [
    ["01/04/2024", "Opening Balance", "", "", "", "12,500.00"],
    ["03/04/2024", "UPI/AMAZON RETAIL", "P2402", "1,299.00", "", "11,201.00"],
    ["05/04/2024", "SALARY CREDIT ACME LTD", "NEFT01", "", "85,000.00", "96,201.00"],
    ["09/04/2024", "ATM WITHDRAWAL MG ROAD", "ATM77", "5,000.00", "", "91,201.00"],
    ["12/04/2024", "ELECTRICITY BILL BESCOM", "BIL334", "2,340.50", "", "88,860.50"],
    ["18/04/2024", "IMPS/RENT TRANSFER", "IMPS90", "25,000.00", "", "63,860.50"],
    ["22/04/2024", "INTEREST CREDIT", "INT", "", "412.18", "64,272.68"],
    ["28/04/2024", "POS SWIGGY BANGALORE", "POS112", "742.00", "", "63,530.68"],
]

# Column x positions (points) for a 595pt-wide A4 page.
COL_X = [40, 110, 300, 360, 430, 510]


def build_text_pdf(path: str) -> None:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((40, 50), "ACME BANK — Statement of Account", fontsize=14, fontname="helv")
    page.insert_text((40, 70), "Account: XXXX1234   Period: 01-Apr-2024 to 30-Apr-2024", fontsize=9)

    y = 110
    for x, label in zip(COL_X, HEADER):
        page.insert_text((x, y), label, fontsize=9, fontname="hebo")
    y += 18
    for row in ROWS:
        for x, cell in zip(COL_X, row):
            page.insert_text((x, y), cell, fontsize=8.5)
        y += 16
    doc.save(path)
    doc.close()


def build_scanned_pdf(text_path: str, out_path: str) -> None:
    """Rasterize the text PDF into an image-only PDF (no text layer)."""
    src = fitz.open(text_path)
    out = fitz.open()
    for page in src:
        pix = page.get_pixmap(matrix=fitz.Matrix(150 / 72, 150 / 72))
        rect = page.rect
        new_page = out.new_page(width=rect.width, height=rect.height)
        new_page.insert_image(rect, stream=pix.tobytes("jpg", jpg_quality=80))
    out.save(out_path)
    src.close()
    out.close()


if __name__ == "__main__":
    text_pdf = os.path.join(SAMPLES, "text_statement.pdf")
    scanned_pdf = os.path.join(SAMPLES, "scanned_statement.pdf")
    build_text_pdf(text_pdf)
    build_scanned_pdf(text_pdf, scanned_pdf)
    print("wrote", text_pdf)
    print("wrote", scanned_pdf)
