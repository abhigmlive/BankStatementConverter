"""Pydantic request/response models for the HTTP API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class PageInfoOut(BaseModel):
    index: int
    width_pt: float
    height_pt: float
    is_scanned: bool
    char_count: int


class UploadOut(BaseModel):
    session_id: str
    filename: str
    page_count: int
    pages: list[PageInfoOut]


class AutoExtractIn(BaseModel):
    session_id: str
    pages: list[int] | None = Field(
        default=None, description="0-based page indices; null means all pages"
    )
    force_ocr: bool = False
    merge: bool = True


class RegionIn(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float


class PageTemplateIn(BaseModel):
    page: int
    region: RegionIn | None = None
    column_separators: list[float] = Field(default_factory=list)
    row_lines: list[float] = Field(default_factory=list)
    column_names: list[str] = Field(default_factory=list)
    header_row: bool = False
    force_ocr: bool = False


class ManualExtractIn(BaseModel):
    session_id: str
    templates: list[PageTemplateIn]
    merge: bool = False


class TableOut(BaseModel):
    page: int
    source: str
    columns: list[str]
    rows: list[list[str]]
    column_separators: list[float] = Field(default_factory=list)


class ExtractOut(BaseModel):
    tables: list[TableOut]


class WordsOut(BaseModel):
    source: str
    words: list[dict]


class ExportIn(BaseModel):
    tables: list[TableOut]
    format: str = "xlsx"  # "xlsx" | "csv"
    filename: str | None = None
