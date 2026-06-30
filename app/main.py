"""FastAPI application: upload, preview, automatic & manual extraction, export."""

from __future__ import annotations

import io
import os
import re

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .auto import ExtractedTable, extract_document, merge_tables
from .exporter import to_csv, to_excel
from .manual import PageTemplate, apply_templates
from .schemas import (
    AutoExtractIn,
    ExportIn,
    ExtractOut,
    ManualExtractIn,
    PageInfoOut,
    UploadOut,
    WordsOut,
)
from .sessions import store

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")

app = FastAPI(title="Bank Statement Converter", version=__version__)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _table_to_out(t: ExtractedTable) -> dict:
    return t.to_dict()


def _safe_filename(name: str | None, default: str, ext: str) -> str:
    base = name or default
    base = re.sub(r"[^A-Za-z0-9_.-]+", "_", base).strip("_") or default
    if base.lower().endswith(f".{ext}"):
        base = base[: -(len(ext) + 1)]
    return f"{base}.{ext}"


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": __version__}


@app.post("/api/upload", response_model=UploadOut)
async def upload(file: UploadFile = File(...)) -> UploadOut:
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported.")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (limit 50 MB).")
    if data[:5] != b"%PDF-":
        raise HTTPException(400, "Not a valid PDF file.")
    try:
        sess = store.create(file.filename, data)
    except Exception as exc:  # corrupt / encrypted PDF
        raise HTTPException(400, f"Could not open PDF: {exc}")

    infos = sess.pdf.all_page_info()
    return UploadOut(
        session_id=sess.id,
        filename=sess.filename,
        page_count=sess.pdf.page_count,
        pages=[
            PageInfoOut(
                index=i.index,
                width_pt=i.width_pt,
                height_pt=i.height_pt,
                is_scanned=i.is_scanned,
                char_count=i.char_count,
            )
            for i in infos
        ],
    )


@app.get("/api/page/{session_id}/{page}.png")
def page_image(session_id: str, page: int, dpi: int = Query(150, ge=36, le=300)) -> Response:
    sess = store.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found or expired.")
    if page < 0 or page >= sess.pdf.page_count:
        raise HTTPException(404, "Page out of range.")
    png = sess.pdf.render_png(page, dpi=dpi)
    return Response(content=png, media_type="image/png")


@app.get("/api/words/{session_id}/{page}", response_model=WordsOut)
def page_words(session_id: str, page: int, force_ocr: bool = False) -> WordsOut:
    sess = store.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found or expired.")
    if page < 0 or page >= sess.pdf.page_count:
        raise HTTPException(404, "Page out of range.")
    words, source = sess.pdf.words(page, force_ocr=force_ocr)
    return WordsOut(source=source, words=[w.to_dict() for w in words])


@app.post("/api/auto-extract", response_model=ExtractOut)
def auto_extract(req: AutoExtractIn) -> ExtractOut:
    sess = store.get(req.session_id)
    if not sess:
        raise HTTPException(404, "Session not found or expired.")
    tables = extract_document(sess.pdf, sess.data, req.pages, force_ocr=req.force_ocr)
    if req.merge and len(tables) > 1:
        tables = [merge_tables(tables)]
    return ExtractOut(tables=[_table_to_out(t) for t in tables])


@app.post("/api/manual-extract", response_model=ExtractOut)
def manual_extract(req: ManualExtractIn) -> ExtractOut:
    sess = store.get(req.session_id)
    if not sess:
        raise HTTPException(404, "Session not found or expired.")
    templates = [PageTemplate.from_dict(t.model_dump()) for t in req.templates]
    tables = apply_templates(sess.pdf, templates)
    if req.merge and len(tables) > 1:
        tables = [merge_tables(tables)]
    return ExtractOut(tables=[_table_to_out(t) for t in tables])


@app.post("/api/export")
def export(req: ExportIn) -> StreamingResponse:
    tables = [
        ExtractedTable(
            page=t.page,
            source=t.source,
            columns=t.columns,
            rows=t.rows,
            column_separators=t.column_separators,
        )
        for t in req.tables
    ]
    if not tables:
        raise HTTPException(400, "No tables to export.")
    fmt = (req.format or "xlsx").lower()
    if fmt == "csv":
        content = to_csv(tables)
        media = "text/csv"
        fname = _safe_filename(req.filename, "statement", "csv")
    elif fmt in ("xlsx", "excel"):
        content = to_excel(tables)
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        fname = _safe_filename(req.filename, "statement", "xlsx")
    else:
        raise HTTPException(400, "format must be 'csv' or 'xlsx'.")
    return StreamingResponse(
        io.BytesIO(content),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.delete("/api/session/{session_id}")
def delete_session(session_id: str) -> dict:
    store.drop(session_id)
    return {"status": "deleted"}


# --------------------------------------------------------------------------- #
# Static frontend (mounted last so /api routes take precedence)
# --------------------------------------------------------------------------- #
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
