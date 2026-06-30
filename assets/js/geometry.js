// Word geometry and clustering — shared by automatic and manual extraction.
//
// A "word" is a plain object { text, x0, y0, x1, y1, conf } whose coordinates
// are NORMALIZED to the page box: each value is in [0, 1] with (0,0) at the
// top-left corner. Working in normalized space keeps extraction independent of
// the render scale and of the source (PDF text layer vs OCR).

export const cx = (w) => (w.x0 + w.x1) / 2;
export const cy = (w) => (w.y0 + w.y1) / 2;
export const wheight = (w) => Math.max(w.y1 - w.y0, 1e-6);

export function normalizeRegion(r) {
  return {
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  };
}

export function containsCenter(region, w) {
  const r = normalizeRegion(region);
  const x = cx(w);
  const y = cy(w);
  return r.x0 <= x && x <= r.x1 && r.y0 <= y && y <= r.y1;
}

export function wordsInRegion(words, region) {
  if (!region) return words.slice();
  return words.filter((w) => containsCenter(region, w));
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Group words into visual rows by vertical position. Words whose vertical
// centers fall within `tolerance` of a row's running center join that row.
// Tolerance defaults to ~60% of the median word height, tracking the font size.
export function clusterRows(words, tolerance = null) {
  if (!words.length) return [];
  const ws = words.slice().sort((a, b) => cy(a) - cy(b) || a.x0 - b.x0);
  if (tolerance == null) {
    tolerance = Math.max(median(ws.map(wheight)) * 0.6, 0.004);
  }
  const rows = [];
  let current = [ws[0]];
  let currentCy = cy(ws[0]);
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i];
    if (Math.abs(cy(w) - currentCy) <= tolerance) {
      current.push(w);
      currentCy = current.reduce((s, x) => s + cy(x), 0) / current.length;
    } else {
      rows.push(current);
      current = [w];
      currentCy = cy(w);
    }
  }
  rows.push(current);
  rows.forEach((row) => row.sort((a, b) => a.x0 - b.x0));
  return rows;
}

// Build a per-row text-density profile over x: for each fine x-bin, how many
// rows have a word covering it (each row counted at most once). Counting per row
// — rather than total ink — keeps a handful of full-width lines (titles, account
// headers, footers) from filling the real column gaps.
function densityProfile(rows, bins) {
  const coverage = new Float64Array(bins);
  for (const row of rows) {
    const mask = new Uint8Array(bins);
    for (const w of row) {
      const a = Math.min(bins - 1, Math.max(0, Math.floor(w.x0 * bins)));
      const b = Math.min(bins - 1, Math.max(0, Math.floor(w.x1 * bins)));
      for (let k = a; k <= b; k++) mask[k] = 1;
    }
    for (let k = 0; k < bins; k++) coverage[k] += mask[k];
  }
  return coverage;
}

// Infer vertical column separators from the "whitespace rivers" between columns.
// Returns sorted normalized x positions; `n` separators produce `n + 1` columns.
//
// Rather than requiring a gap to be completely empty (which fails whenever a few
// long descriptions bridge it), this finds the *valleys* in the text-density
// profile: a column boundary is a local minimum whose density is well below the
// busy columns on either side (topographic prominence). This correctly splits
// statements whose columns are separated by thin or partially-filled gaps.
export function detectColumnBounds(rows, maxCols = 24) {
  if (!rows.length) return [];
  const bins = 1000;
  const coverage = densityProfile(rows, bins);

  // Content extent (ignore outer margins).
  let lo = 0;
  while (lo < bins && coverage[lo] === 0) lo++;
  let hi = bins - 1;
  while (hi > 0 && coverage[hi] === 0) hi--;
  if (hi - lo < 4) return [];

  // Smooth to suppress per-character jitter (~0.4% of width).
  const win = Math.max(2, Math.round(bins * 0.004));
  const sm = new Float64Array(bins);
  let globalMax = 0;
  for (let i = lo; i <= hi; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(lo, i - win); j <= Math.min(hi, i + win); j++) { s += coverage[j]; c++; }
    sm[i] = s / c;
    if (sm[i] > globalMax) globalMax = sm[i];
  }
  if (globalMax <= 0) return [];

  // Walk the profile, recording alternating peaks/valleys with a noise margin so
  // tiny wiggles inside a column don't register as boundaries.
  const noise = Math.max(globalMax * 0.08, 0.5);
  const extrema = []; // { pos, val, type }
  let dir = 0; // 1 rising, -1 falling
  let extPos = lo;
  let extVal = sm[lo];
  for (let i = lo + 1; i <= hi; i++) {
    const v = sm[i];
    if (dir >= 0 && v >= extVal) { extVal = v; extPos = i; if (dir === 0 && v > sm[lo]) dir = 1; }
    else if (dir <= 0 && v <= extVal) { extVal = v; extPos = i; if (dir === 0 && v < sm[lo]) dir = -1; }
    if (dir === 1 && v < extVal - noise) { extrema.push({ pos: extPos, val: extVal, type: "peak" }); dir = -1; extVal = v; extPos = i; }
    else if (dir === -1 && v > extVal + noise) { extrema.push({ pos: extPos, val: extVal, type: "valley" }); dir = 1; extVal = v; extPos = i; }
  }
  extrema.push({ pos: extPos, val: extVal, type: dir === 1 ? "peak" : "valley" });

  // The content range begins and ends inside a column, so anchor a peak at each
  // edge — otherwise a valley adjacent to the first/last column has no
  // neighbouring peak and would be wrongly discarded.
  if (!extrema.length || extrema[0].type === "valley") {
    extrema.unshift({ pos: lo, val: sm[lo], type: "peak" });
  }
  if (extrema[extrema.length - 1].type === "valley") {
    extrema.push({ pos: hi, val: sm[hi], type: "peak" });
  }

  // Each interior valley qualifies as a column boundary when it is (a) deep
  // enough relative to its neighbouring columns (prominence) and (b) wide enough
  // to be a real column gap rather than the thin whitespace between two words.
  const promFloor = globalMax * 0.22;
  const minGapWidth = 0.01; // ~1% of page width; inter-word gaps are narrower
  const candidates = [];
  for (let k = 0; k < extrema.length; k++) {
    if (extrema[k].type !== "valley") continue;
    let lp = 0;
    for (let j = k - 1; j >= 0; j--) if (extrema[j].type === "peak") { lp = extrema[j].val; break; }
    let rp = 0;
    for (let j = k + 1; j < extrema.length; j++) if (extrema[j].type === "peak") { rp = extrema[j].val; break; }
    if (lp <= 0 || rp <= 0) continue; // valley at an outer edge, not between columns
    const valley = extrema[k];
    const prom = Math.min(lp, rp) - valley.val;
    if (prom < promFloor) continue;
    // Width of the low region around the valley (below half the prominence).
    const half = valley.val + 0.5 * prom;
    let a = valley.pos;
    while (a > lo && sm[a - 1] <= half) a--;
    let b = valley.pos;
    while (b < hi && sm[b + 1] <= half) b++;
    if ((b - a) / bins < minGapWidth) continue; // too thin — an inter-word space
    candidates.push({ center: ((a + b) / 2) / bins, prom });
  }

  // Keep the most prominent boundaries, enforcing a minimum column spacing.
  candidates.sort((a, b) => b.prom - a.prom);
  const minGap = 0.018;
  const chosen = [];
  for (const cand of candidates) {
    if (chosen.every((c) => Math.abs(c - cand.center) >= minGap)) chosen.push(cand.center);
    if (chosen.length >= maxCols - 1) break;
  }
  chosen.sort((a, b) => a - b);
  return chosen;
}

// Bucket a row's words into cells delimited by `separators`.
export function assignToColumns(row, separators) {
  const nCols = separators.length + 1;
  const cells = Array.from({ length: nCols }, () => []);
  for (const w of row) {
    let col = 0;
    while (col < separators.length && cx(w) > separators[col]) col++;
    cells[col].push(w);
  }
  return cells.map((cell) => {
    cell.sort((a, b) => a.x0 - b.x0);
    return cell.map((w) => w.text).join(" ").trim();
  });
}

export function rowsToMatrix(rows, separators) {
  return rows.map((row) => assignToColumns(row, separators));
}

// Split words into rows using explicit horizontal separators (manual mode).
export function rowsByLines(words, rowLines) {
  const lines = rowLines.slice().sort((a, b) => a - b);
  const buckets = Array.from({ length: lines.length + 1 }, () => []);
  for (const w of words) {
    let idx = 0;
    while (idx < lines.length && cy(w) > lines[idx]) idx++;
    buckets[idx].push(w);
  }
  return buckets.filter((b) => b.length).map((b) => b.sort((a, c) => a.x0 - c.x0));
}
