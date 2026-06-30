"""Unified word model and geometric clustering used by both extraction modes.

All coordinates in this module are *normalized* to the page box, i.e. each of
``x0, y0, x1, y1`` lies in ``[0, 1]`` where ``(0, 0)`` is the top-left corner of
the page and ``(1, 1)`` is the bottom-right.  Working in normalized space keeps
the extraction logic independent of the render DPI and of the scale the browser
happens to use to display the page.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import numpy as np


@dataclass
class Word:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    # OCR confidence in 0..100 (None for vector text, which is exact).
    conf: float | None = None

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2.0

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2.0

    @property
    def height(self) -> float:
        return max(self.y1 - self.y0, 1e-6)

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "x0": round(self.x0, 5),
            "y0": round(self.y0, 5),
            "x1": round(self.x1, 5),
            "y1": round(self.y1, 5),
            "conf": None if self.conf is None else round(self.conf, 1),
        }


@dataclass
class Region:
    """A normalized rectangle the user (or auto-detector) selected on a page."""

    x0: float
    y0: float
    x1: float
    y1: float

    def normalized(self) -> "Region":
        return Region(
            min(self.x0, self.x1),
            min(self.y0, self.y1),
            max(self.x0, self.x1),
            max(self.y0, self.y1),
        )

    def contains_center(self, w: Word) -> bool:
        r = self.normalized()
        return r.x0 <= w.cx <= r.x1 and r.y0 <= w.cy <= r.y1


def words_in_region(words: Iterable[Word], region: Region | None) -> list[Word]:
    if region is None:
        return list(words)
    return [w for w in words if region.contains_center(w)]


def cluster_rows(words: list[Word], tolerance: float | None = None) -> list[list[Word]]:
    """Group words into visual rows by vertical position.

    Words whose vertical centers are within ``tolerance`` of a row's running
    center join that row.  ``tolerance`` defaults to ~60% of the median word
    height, which tracks the font size of the page automatically.
    """
    if not words:
        return []

    ws = sorted(words, key=lambda w: (w.cy, w.x0))
    if tolerance is None:
        median_h = float(np.median([w.height for w in ws]))
        tolerance = max(median_h * 0.6, 0.004)

    rows: list[list[Word]] = []
    current: list[Word] = [ws[0]]
    current_cy = ws[0].cy
    for w in ws[1:]:
        if abs(w.cy - current_cy) <= tolerance:
            current.append(w)
            current_cy = float(np.mean([x.cy for x in current]))
        else:
            rows.append(current)
            current = [w]
            current_cy = w.cy
    rows.append(current)

    for row in rows:
        row.sort(key=lambda w: w.x0)
    return rows


def detect_column_bounds(rows: list[list[Word]], max_cols: int = 24) -> list[float]:
    """Infer vertical column separators from the "whitespace rivers" in the text.

    Returns a sorted list of normalized x positions (separators); ``n``
    separators produce ``n + 1`` columns.

    Rather than requiring a gap to be completely empty — which fails whenever a
    few long descriptions bridge it — this finds the *valleys* in the per-row
    text-density profile: a column boundary is a local minimum whose density is
    well below the busy columns on either side (topographic prominence) and which
    is wider than the thin whitespace between two words.  Per-row counting keeps
    full-width lines (titles, account headers, footers) from filling real gaps.
    """
    if not rows:
        return []

    bins = 1000
    coverage = np.zeros(bins, dtype=np.float64)
    for row in rows:
        row_mask = np.zeros(bins, dtype=bool)
        for w in row:
            a = int(np.clip(w.x0 * bins, 0, bins - 1))
            b = int(np.clip(w.x1 * bins, 0, bins - 1))
            row_mask[a : b + 1] = True
        coverage += row_mask

    nz = np.nonzero(coverage)[0]
    if nz.size < 5:
        return []
    lo, hi = int(nz[0]), int(nz[-1])
    if hi - lo < 4:
        return []

    # Smooth to suppress per-character jitter (~0.4% of width).
    win = max(2, round(bins * 0.004))
    sm = np.zeros(bins, dtype=np.float64)
    for i in range(lo, hi + 1):
        a = max(lo, i - win)
        b = min(hi, i + win)
        sm[i] = coverage[a : b + 1].mean()
    global_max = float(sm[lo : hi + 1].max())
    if global_max <= 0:
        return []

    # Walk the profile recording alternating peaks/valleys with a noise margin.
    noise = max(global_max * 0.08, 0.5)
    extrema: list[tuple[int, float, str]] = []  # (pos, val, kind)
    direction = 0
    ext_pos, ext_val = lo, sm[lo]
    for i in range(lo + 1, hi + 1):
        v = sm[i]
        if direction >= 0 and v >= ext_val:
            ext_val, ext_pos = v, i
            if direction == 0 and v > sm[lo]:
                direction = 1
        elif direction <= 0 and v <= ext_val:
            ext_val, ext_pos = v, i
            if direction == 0 and v < sm[lo]:
                direction = -1
        if direction == 1 and v < ext_val - noise:
            extrema.append((ext_pos, ext_val, "peak"))
            direction, ext_val, ext_pos = -1, v, i
        elif direction == -1 and v > ext_val + noise:
            extrema.append((ext_pos, ext_val, "valley"))
            direction, ext_val, ext_pos = 1, v, i
    extrema.append((ext_pos, ext_val, "peak" if direction == 1 else "valley"))

    # Anchor a peak at each content edge so a valley next to the first/last
    # column has a neighbouring peak.
    if not extrema or extrema[0][2] == "valley":
        extrema.insert(0, (lo, float(sm[lo]), "peak"))
    if extrema[-1][2] == "valley":
        extrema.append((hi, float(sm[hi]), "peak"))

    prom_floor = global_max * 0.22
    min_gap_width = 0.01
    candidates: list[tuple[float, float]] = []  # (center, prominence)
    for k, (pos, val, kind) in enumerate(extrema):
        if kind != "valley":
            continue
        lp = next((extrema[j][1] for j in range(k - 1, -1, -1) if extrema[j][2] == "peak"), 0.0)
        rp = next((extrema[j][1] for j in range(k + 1, len(extrema)) if extrema[j][2] == "peak"), 0.0)
        if lp <= 0 or rp <= 0:
            continue
        prom = min(lp, rp) - val
        if prom < prom_floor:
            continue
        half = val + 0.5 * prom
        a = pos
        while a > lo and sm[a - 1] <= half:
            a -= 1
        b = pos
        while b < hi and sm[b + 1] <= half:
            b += 1
        if (b - a) / bins < min_gap_width:
            continue
        candidates.append(((a + b) / 2.0 / bins, prom))

    candidates.sort(key=lambda c: c[1], reverse=True)
    min_gap = 0.018
    chosen: list[float] = []
    for center, _ in candidates:
        if all(abs(c - center) >= min_gap for c in chosen):
            chosen.append(center)
        if len(chosen) >= max_cols - 1:
            break
    return sorted(chosen)


def assign_to_columns(row: list[Word], separators: list[float]) -> list[str]:
    """Bucket a row's words into cells delimited by ``separators``."""
    n_cols = len(separators) + 1
    cells: list[list[Word]] = [[] for _ in range(n_cols)]
    for w in row:
        col = 0
        while col < len(separators) and w.cx > separators[col]:
            col += 1
        cells[col].append(w)
    out: list[str] = []
    for cell in cells:
        cell.sort(key=lambda w: w.x0)
        out.append(" ".join(w.text for w in cell).strip())
    return out


def rows_to_matrix(rows: list[list[Word]], separators: list[float]) -> list[list[str]]:
    return [assign_to_columns(row, separators) for row in rows]
