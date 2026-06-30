"""Export extracted tables to CSV or Excel (xlsx)."""

from __future__ import annotations

import io

import pandas as pd

from .auto import ExtractedTable


def _to_frame(table: ExtractedTable) -> pd.DataFrame:
    n_cols = len(table.columns)
    rows = [list(r) + [""] * (n_cols - len(r)) for r in table.rows]
    rows = [r[:n_cols] for r in rows]
    return pd.DataFrame(rows, columns=table.columns or None)


def to_csv(tables: list[ExtractedTable]) -> bytes:
    buf = io.StringIO()
    for i, table in enumerate(tables):
        if i:
            buf.write("\n")
        if len(tables) > 1:
            buf.write(f"# Page {table.page} ({table.source})\n")
        _to_frame(table).to_csv(buf, index=False)
    return buf.getvalue().encode("utf-8-sig")


def to_excel(tables: list[ExtractedTable]) -> bytes:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        used: set[str] = set()
        for i, table in enumerate(tables):
            name = f"Page {table.page}" if table.page else f"Table {i + 1}"
            name = name[:31]
            base, k = name, 1
            while name in used:
                k += 1
                suffix = f" ({k})"
                name = base[: 31 - len(suffix)] + suffix
            used.add(name)
            _to_frame(table).to_excel(writer, sheet_name=name, index=False)
    return buf.getvalue()
