// Table extraction from normalized words — automatic and manual (template)
// modes. Both reduce a page's words to a { page, source, columns, rows,
// columnSeparators } table. Pure logic, runs identically in the browser and in
// Node tests.

import {
  clusterRows,
  detectColumnBounds,
  rowsToMatrix,
  assignToColumns,
  rowsByLines,
  wordsInRegion,
} from "./geometry.js";
import {
  cleanAmount,
  isAmount,
  headerScore,
  guessLabels,
} from "./heuristics.js";

function cleanMatrix(matrix) {
  const out = [];
  for (const row of matrix) {
    const newRow = row.map((c) => (isAmount(c) ? cleanAmount(c) : c));
    if (newRow.some((c) => c && c.trim())) out.push(newRow);
  }
  return out;
}

// Pick the most header-like of the first few rows as column labels.
function splitHeader(matrix) {
  if (!matrix.length) return { columns: [], body: [] };
  let bestIdx = -1;
  let best = 1; // need at least 2 keyword hits to call something a header
  const probe = Math.min(4, matrix.length);
  for (let i = 0; i < probe; i++) {
    const s = headerScore(matrix[i]);
    if (s > best) {
      best = s;
      bestIdx = i;
    }
  }
  const nCols = Math.max(...matrix.map((r) => r.length));
  if (bestIdx >= 0) {
    const header = matrix[bestIdx].concat(Array(Math.max(0, nCols - matrix[bestIdx].length)).fill(""));
    return { columns: guessLabels(header), body: matrix.slice(bestIdx + 1) };
  }
  return {
    columns: Array.from({ length: nCols }, (_, i) => `Column ${i + 1}`),
    body: matrix,
  };
}

// Automatic: cluster rows, detect columns from layout, label header.
export function autoExtract(words, page, source) {
  const rows = clusterRows(words);
  if (rows.length < 2) return null;
  const seps = detectColumnBounds(rows);
  const matrix = cleanMatrix(rowsToMatrix(rows, seps));
  if (!matrix.length) return null;
  let { columns, body } = splitHeader(matrix);
  if (!body.length) body = matrix;
  return {
    page,
    source: source === "ocr" ? "ocr-layout" : "text-layout",
    columns,
    rows: body,
    columnSeparators: seps,
  };
}

// Manual: apply a user template (region + column/row dividers + names).
export function applyTemplate(words, source, tmpl) {
  let ws = wordsInRegion(words, tmpl.region || null);
  const rows = (tmpl.rowLines && tmpl.rowLines.length)
    ? rowsByLines(ws, tmpl.rowLines)
    : clusterRows(ws);

  const seps = (tmpl.columnSeparators || []).slice().sort((a, b) => a - b);
  const matrix = [];
  for (const row of rows) {
    let cells = assignToColumns(row, seps);
    cells = cells.map((c) => (isAmount(c) ? cleanAmount(c) : c));
    if (cells.some((c) => c && c.trim())) matrix.push(cells);
  }

  const nCols = seps.length + 1;
  let columns;
  let body;
  const names = (tmpl.columnNames || []).filter((c) => c && c.trim());
  if (names.length) {
    columns = (tmpl.columnNames || []).slice(0, nCols);
    while (columns.length < nCols) columns.push(`Column ${columns.length + 1}`);
    body = matrix;
  } else if (tmpl.headerRow && matrix.length) {
    columns = guessLabels(matrix[0]);
    while (columns.length < nCols) columns.push(`Column ${columns.length + 1}`);
    body = matrix.slice(1);
  } else {
    columns = Array.from({ length: nCols }, (_, i) => `Column ${i + 1}`);
    body = matrix;
  }

  return {
    page: tmpl.page + 1,
    source: source === "ocr" ? "ocr-manual" : "text-manual",
    columns,
    rows: body,
    columnSeparators: seps,
  };
}

// Concatenate per-page tables into one, aligning on the widest column set and
// recording each row's origin page.
export function mergeTables(tables) {
  if (!tables.length) return { page: 0, source: "merged", columns: [], rows: [], columnSeparators: [] };
  const width = Math.max(...tables.map((t) => t.columns.length));
  const base = (tables.find((t) => t.columns.length === width) || tables[0]).columns;
  const columns = ["Page"].concat(base);
  const rows = [];
  for (const t of tables) {
    for (const r of t.rows) {
      const padded = r.concat(Array(Math.max(0, width - r.length)).fill("")).slice(0, width);
      rows.push([String(t.page)].concat(padded));
    }
  }
  return { page: 0, source: "merged", columns, rows, columnSeparators: [] };
}
