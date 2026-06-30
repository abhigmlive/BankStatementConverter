// Export extracted tables to CSV or Excel, entirely in the browser.
// CSV is built directly; Excel uses SheetJS (`window.XLSX`, loaded in index.html).

function tableToAoa(table) {
  const nCols = table.columns.length || Math.max(0, ...table.rows.map((r) => r.length));
  const header = table.columns.length
    ? table.columns
    : Array.from({ length: nCols }, (_, i) => `Column ${i + 1}`);
  const body = table.rows.map((r) => {
    const row = r.slice(0, nCols);
    while (row.length < nCols) row.push("");
    return row;
  });
  return [header, ...body];
}

function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tablesToCsv(tables) {
  const parts = [];
  tables.forEach((t, i) => {
    if (i) parts.push("");
    if (tables.length > 1) parts.push(`# Page ${t.page} (${t.source})`);
    for (const row of tableToAoa(t)) parts.push(row.map(csvField).join(","));
  });
  return "﻿" + parts.join("\r\n"); // BOM for Excel-friendly UTF-8
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadCsv(tables, filename = "statement.csv") {
  triggerDownload(new Blob([tablesToCsv(tables)], { type: "text/csv;charset=utf-8" }), filename);
}

export function downloadXlsx(tables, filename = "statement.xlsx") {
  if (!window.XLSX) throw new Error("Excel engine not loaded (SheetJS unavailable).");
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  const used = new Set();
  tables.forEach((t, i) => {
    let name = (t.page ? `Page ${t.page}` : `Table ${i + 1}`).slice(0, 31);
    let base = name;
    let k = 1;
    while (used.has(name)) {
      k++;
      const suffix = ` (${k})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name);
    const ws = XLSX.utils.aoa_to_sheet(tableToAoa(t));
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  XLSX.writeFile(wb, filename);
}
