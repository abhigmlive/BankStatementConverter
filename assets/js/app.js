"use strict";
// Browser UI controller. Orchestrates PDF.js (read/render), Tesseract.js (OCR),
// the shared extraction engine, and SheetJS/CSV export — all client-side.

import { loadPdf, pageInfos, renderToCanvas, renderForOcr, textWords } from "./pdfdoc.js";
import { ocrCanvas } from "./ocr.js";
import { autoExtract, applyTemplate, mergeTables } from "./extract.js";
import { detectColumnBounds } from "./geometry.js";
import { clusterRows } from "./geometry.js";
import { downloadCsv, downloadXlsx } from "./exporter.js";

const COLORS = ["#2563eb", "#16a34a", "#db2777", "#d97706", "#7c3aed", "#0891b2", "#ca8a04", "#dc2626", "#0d9488", "#9333ea"];

const state = {
  doc: null,
  infos: [],
  filename: "statement.pdf",
  page: 0,
  img: { w: 0, h: 0 },
  tmpl: { region: null, cols: [], rows: [] },
  colNames: [],
  lastTables: [],
  lastLabel: "",
  wordsCache: new Map(), // `${page}:${ocr}` -> { words, source }
};

let tool = "area";
let dragging = null;

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};
const clamp = (v) => Math.max(0, Math.min(1, v));

function toast(msg, isError = false, ms = 3600) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
function spinner(on, text = "Working…") {
  $("#spinner-text").textContent = text;
  $("#spinner").hidden = !on;
}

/* ------------------------------- Upload -------------------------------- */
function initUpload() {
  const dz = $("#dropzone");
  const input = $("#file-input");
  $("#browse-btn").addEventListener("click", (e) => { e.stopPropagation(); input.click(); });
  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", () => input.files[0] && openFile(input.files[0]));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) openFile(f); });
  $("#new-file-btn").addEventListener("click", () => input.click());
}

async function openFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) return toast("Please choose a PDF file.", true);
  const status = $("#upload-status");
  status.hidden = false; status.className = "status"; status.textContent = `Reading ${file.name}…`;
  spinner(true, "Reading PDF…");
  try {
    const buf = await file.arrayBuffer();
    state.doc = await loadPdf(buf);
    state.filename = file.name;
    spinner(true, "Analyzing pages…");
    state.infos = await pageInfos(state.doc);
    state.wordsCache.clear();
    status.hidden = true;
    onReady();
  } catch (err) {
    status.className = "status error";
    status.textContent = "Could not open PDF: " + (err.message || err);
  } finally {
    spinner(false);
  }
}

function onReady() {
  $("#upload-section").hidden = true;
  $("#workspace").hidden = false;
  $("#results").hidden = true;
  $("#file-name").textContent = state.filename;
  const n = state.infos.length;
  $("#file-pages").textContent = `${n} page${n > 1 ? "s" : ""}`;
  const scanned = state.infos.filter((p) => p.isScanned).length;
  const kind = $("#file-kind");
  if (scanned === 0) { kind.textContent = "Text PDF"; kind.className = "badge"; }
  else if (scanned === n) { kind.textContent = "Scanned · OCR"; kind.className = "badge scan"; }
  else { kind.textContent = `${scanned}/${n} scanned`; kind.className = "badge scan"; }
  $("#auto-ocr").checked = scanned === n;
  state.page = 0;
  state.tmpl = { region: null, cols: [], rows: [] };
  state.colNames = [];
  renderColNames();
  loadManualPage();
}

/* ---------------------------- Words per page --------------------------- */
async function getWords(pageNum0, forceOcr, onProgress) {
  const scanned = state.infos[pageNum0] && state.infos[pageNum0].isScanned;
  const useOcr = forceOcr || scanned;
  const key = `${pageNum0}:${useOcr ? 1 : 0}`;
  if (state.wordsCache.has(key)) return state.wordsCache.get(key);

  let result;
  if (useOcr) {
    const canvas = await renderForOcr(state.doc, pageNum0 + 1, 200);
    const words = await ocrCanvas(canvas, onProgress);
    result = { words, source: "ocr" };
  } else {
    const words = await textWords(state.doc, pageNum0 + 1);
    if (words.length < 2) {
      const canvas = await renderForOcr(state.doc, pageNum0 + 1, 200);
      const ow = await ocrCanvas(canvas, onProgress);
      result = { words: ow, source: "ocr" };
    } else {
      result = { words, source: "text" };
    }
  }
  state.wordsCache.set(key, result);
  return result;
}

/* -------------------------------- Tabs --------------------------------- */
function initTabs() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("#tab-" + t.dataset.tab).classList.add("active");
      if (t.dataset.tab === "manual") loadManualPage();
    }));
}

/* ---------------------------- Automatic mode --------------------------- */
function initAuto() {
  $("#auto-run").addEventListener("click", async () => {
    if (!state.doc) return;
    const forceOcr = $("#auto-ocr").checked;
    const merge = $("#auto-merge").checked;
    const n = state.infos.length;
    spinner(true, "Extracting…");
    try {
      const tables = [];
      for (let p = 0; p < n; p++) {
        const willOcr = forceOcr || state.infos[p].isScanned;
        const { words, source } = await getWords(p, forceOcr, (prog) =>
          spinner(true, `OCR page ${p + 1}/${n} … ${Math.round(prog * 100)}%`));
        if (!willOcr) spinner(true, `Reading page ${p + 1}/${n}…`);
        const t = autoExtract(words, p + 1, source);
        if (t && t.rows.length) tables.push(t);
      }
      if (!tables.length) return toast("No tables detected. Try the Manual tab.", true);
      const out = merge && tables.length > 1 ? [mergeTables(tables)] : tables;
      showResults(out, "Automatic extraction");
    } catch (err) {
      toast("Extraction failed: " + (err.message || err), true);
    } finally {
      spinner(false);
    }
  });
}

/* ----------------------------- Manual mode ----------------------------- */
function initManual() {
  const canvas = $("#overlay");
  document.querySelectorAll(".tool").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tool").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      tool = b.dataset.tool;
    }));
  $("#page-prev").addEventListener("click", () => changePage(-1));
  $("#page-next").addEventListener("click", () => changePage(1));
  $("#clear-overlay").addEventListener("click", () => { state.tmpl = { region: null, cols: [], rows: [] }; renderColNames(); draw(); });
  $("#auto-cols").addEventListener("click", guessColumns);
  $("#manual-run").addEventListener("click", runManual);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return { x: clamp(cx / r.width), y: clamp(cy / r.height) };
  };
  const down = (e) => {
    e.preventDefault();
    const p = pos(e);
    if (tool === "area") dragging = { x0: p.x, y0: p.y };
    else if (tool === "col") { toggleDivider(state.tmpl.cols, p.x); renderColNames(); draw(); }
    else if (tool === "row") { toggleDivider(state.tmpl.rows, p.y); draw(); }
  };
  const move = (e) => {
    if (!dragging) return;
    e.preventDefault();
    const p = pos(e);
    state.tmpl.region = { x0: dragging.x0, y0: dragging.y0, x1: p.x, y1: p.y };
    draw();
  };
  const up = () => {
    if (dragging && state.tmpl.region) {
      const r = state.tmpl.region;
      if (Math.abs(r.x1 - r.x0) < 0.01 || Math.abs(r.y1 - r.y0) < 0.01) state.tmpl.region = null;
    }
    dragging = null;
    draw();
  };
  canvas.addEventListener("mousedown", down);
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  canvas.addEventListener("touchstart", down, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", up);
  window.addEventListener("resize", () => { sizeOverlay(); draw(); });
}

function toggleDivider(arr, v) {
  const near = arr.findIndex((x) => Math.abs(x - v) < 0.015);
  if (near >= 0) arr.splice(near, 1);
  else { arr.push(v); arr.sort((a, b) => a - b); }
}

function changePage(delta) {
  if (!state.doc) return;
  const next = state.page + delta;
  if (next < 0 || next >= state.infos.length) return;
  state.page = next;
  loadManualPage();
}

async function loadManualPage() {
  if (!state.doc) return;
  const pageCanvas = $("#page-canvas");
  $("#page-label").textContent = `Page ${state.page + 1} / ${state.infos.length}`;
  const info = state.infos[state.page];
  $("#manual-ocr").checked = !!(info && info.isScanned);
  try {
    const cssWidth = Math.min(900, ($("#stage").clientWidth || 900));
    const dims = await renderToCanvas(state.doc, state.page + 1, pageCanvas, cssWidth);
    state.img = { w: dims.width, h: dims.height };
    sizeOverlay();
    draw();
  } catch (err) {
    toast("Could not render page: " + (err.message || err), true);
  }
}

function sizeOverlay() {
  const pageCanvas = $("#page-canvas");
  const overlay = $("#overlay");
  const w = pageCanvas.clientWidth || pageCanvas.width;
  const h = pageCanvas.clientHeight || pageCanvas.height;
  overlay.width = w;
  overlay.height = h;
}

function draw() {
  const overlay = $("#overlay");
  const ctx = overlay.getContext("2d");
  const W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);
  const reg = state.tmpl.region;
  const rx0 = reg ? Math.min(reg.x0, reg.x1) : 0;
  const ry0 = reg ? Math.min(reg.y0, reg.y1) : 0;
  const rx1 = reg ? Math.max(reg.x0, reg.x1) : 1;
  const ry1 = reg ? Math.max(reg.y0, reg.y1) : 1;

  if (reg) {
    ctx.fillStyle = "rgba(37, 99, 235, .10)";
    ctx.fillRect(rx0 * W, ry0 * H, (rx1 - rx0) * W, (ry1 - ry0) * H);
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(rx0 * W, ry0 * H, (rx1 - rx0) * W, (ry1 - ry0) * H);
    ctx.setLineDash([]);
  }
  ctx.lineWidth = 2;
  state.tmpl.cols.forEach((x, i) => {
    ctx.strokeStyle = COLORS[(i + 1) % COLORS.length];
    ctx.beginPath(); ctx.moveTo(x * W, ry0 * H); ctx.lineTo(x * W, ry1 * H); ctx.stroke();
  });
  ctx.strokeStyle = "#94a3b8"; ctx.setLineDash([4, 4]);
  state.tmpl.rows.forEach((y) => {
    ctx.beginPath(); ctx.moveTo(rx0 * W, y * H); ctx.lineTo(rx1 * W, y * H); ctx.stroke();
  });
  ctx.setLineDash([]);
}

function renderColNames() {
  const box = $("#col-names");
  box.innerHTML = "";
  const n = state.tmpl.cols.length + 1;
  if (state.tmpl.cols.length === 0) {
    box.appendChild(el("p", "muted small", "Add column dividers to name fields."));
    return;
  }
  if (state.colNames.length < n) while (state.colNames.length < n) state.colNames.push("");
  else state.colNames.length = n;
  for (let i = 0; i < n; i++) {
    const row = el("div", "col-name-row");
    const sw = el("span", "swatch");
    sw.style.background = COLORS[i % COLORS.length];
    const inp = el("input");
    inp.placeholder = `Column ${i + 1}`;
    inp.value = state.colNames[i] || "";
    inp.addEventListener("input", () => (state.colNames[i] = inp.value));
    row.appendChild(sw); row.appendChild(inp); box.appendChild(row);
  }
}

async function guessColumns() {
  if (!state.doc) return;
  spinner(true, "Detecting columns…");
  try {
    const { words } = await getWords(state.page, $("#manual-ocr").checked, (p) =>
      spinner(true, `OCR … ${Math.round(p * 100)}%`));
    const rows = clusterRows(words);
    const seps = detectColumnBounds(rows);
    if (seps.length) {
      state.tmpl.cols = seps.slice();
      const t = autoExtract(words, state.page + 1, "text");
      if (t && !state.colNames.some((c) => c)) state.colNames = (t.columns || []).slice();
      renderColNames();
      draw();
      toast(`Detected ${seps.length + 1} columns.`);
    } else {
      toast("Couldn't auto-detect columns here — add them manually.", true);
    }
  } catch (err) {
    toast("Auto columns failed: " + (err.message || err), true);
  } finally {
    spinner(false);
  }
}

async function runManual() {
  if (!state.doc) return;
  const hasNames = state.colNames.some((c) => (c || "").trim());
  const base = {
    region: state.tmpl.region ? { ...normRegion(state.tmpl.region) } : null,
    columnSeparators: state.tmpl.cols.slice(),
    rowLines: state.tmpl.rows.slice(),
    columnNames: hasNames ? state.colNames.map((c) => (c || "").trim()) : [],
    headerRow: $("#manual-header").checked,
  };
  if (base.columnSeparators.length === 0 && !base.region) {
    return toast("Draw a table area or add column dividers first.", true);
  }
  const allPages = $("#manual-allpages").checked;
  const forceOcrManual = $("#manual-ocr").checked;
  spinner(true, "Extracting…");
  try {
    const tables = [];
    const pages = allPages ? state.infos.map((_, i) => i) : [state.page];
    for (const p of pages) {
      const { words, source } = await getWords(p, forceOcrManual, (prog) =>
        spinner(true, `OCR page ${p + 1} … ${Math.round(prog * 100)}%`));
      tables.push(applyTemplate(words, source, { ...base, page: p }));
    }
    const out = allPages && tables.length > 1 ? [mergeTables(tables)] : tables;
    if (!out.length || out.every((t) => !t.rows.length)) return toast("Nothing extracted from this template.", true);
    showResults(out, allPages ? "Manual template · all pages" : `Manual template · page ${state.page + 1}`);
  } catch (err) {
    toast("Extraction failed: " + (err.message || err), true);
  } finally {
    spinner(false);
  }
}

function normRegion(r) {
  return { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
}

/* ------------------------------- Results ------------------------------- */
// Ensure a table's columns array and every row have the same width.
function normalizeTable(t) {
  const n = Math.max(t.columns.length, ...t.rows.map((r) => r.length), 1);
  while (t.columns.length < n) t.columns.push("");
  t.columns = t.columns.slice(0, n);
  t.rows = t.rows.map((r) => {
    const row = r.slice(0, n);
    while (row.length < n) row.push("");
    return row;
  });
}

// --- post-extraction column edits (operate on state.lastTables[ti]) ---
function mergeColumns(ti, col) {
  const t = state.lastTables[ti];
  if (!t || col < 0 || col >= t.columns.length - 1) return;
  normalizeTable(t);
  t.columns[col] = (t.columns[col] || "") || t.columns[col + 1] || "";
  t.columns.splice(col + 1, 1);
  t.rows.forEach((r) => { r[col] = [r[col], r[col + 1]].filter((c) => c && c.trim()).join(" "); r.splice(col + 1, 1); });
  rerenderResults();
}

function splitColumn(ti, col, mode, sep) {
  const t = state.lastTables[ti];
  if (!t || col < 0 || col >= t.columns.length) return;
  normalizeTable(t);
  const cut = (cell) => {
    const s = cell || "";
    let i = -1;
    if (mode === "first") i = s.indexOf(" ");
    else if (mode === "last") i = s.lastIndexOf(" ");
    else if (mode === "sep") i = sep ? s.indexOf(sep) : -1;
    if (i < 0) return [s, ""];
    const w = mode === "sep" ? (sep ? sep.length : 1) : 1;
    return [s.slice(0, i).trim(), s.slice(i + w).trim()];
  };
  t.columns.splice(col + 1, 0, "");
  t.rows.forEach((r) => { const [a, b] = cut(r[col]); r[col] = a; r.splice(col + 1, 0, b); });
  rerenderResults();
}

function deleteColumn(ti, col) {
  const t = state.lastTables[ti];
  if (!t || t.columns.length <= 1) return;
  normalizeTable(t);
  t.columns.splice(col, 1);
  t.rows.forEach((r) => r.splice(col, 1));
  rerenderResults();
}

function rerenderResults() {
  closeColMenu();
  showResults(state.lastTables, state.lastLabel, true);
}

// Floating action menu for a column header.
function closeColMenu() {
  const m = document.getElementById("col-menu");
  if (m) m.remove();
}
function openColMenu(anchor, ti, col, nCols) {
  closeColMenu();
  const menu = el("div");
  menu.id = "col-menu";
  menu.className = "col-menu";
  const item = (label, fn, disabled) => {
    const b = el("button", null, label);
    if (disabled) b.disabled = true;
    else b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    menu.appendChild(b);
  };
  item("✂ Split at first space", () => splitColumn(ti, col, "first"));
  item("✂ Split at last space", () => splitColumn(ti, col, "last"));
  item("✂ Split by text…", () => {
    const sep = window.prompt("Split each cell at the first occurrence of:", " - ");
    if (sep != null && sep !== "") splitColumn(ti, col, "sep", sep);
  });
  item("⇤ Merge with left", () => mergeColumns(ti, col - 1), col === 0);
  item("⇥ Merge with right", () => mergeColumns(ti, col), col >= nCols - 1);
  item("✕ Delete column", () => deleteColumn(ti, col), nCols <= 1);
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${window.scrollY + r.bottom + 4}px`;
  menu.style.left = `${window.scrollX + Math.min(r.left, window.innerWidth - 220)}px`;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("#col-menu") && !e.target.closest(".col-menu-btn")) closeColMenu();
});

function showResults(tables, label, keepScroll) {
  state.lastTables = tables;
  state.lastLabel = label;
  const wrap = $("#result-tables");
  wrap.innerHTML = "";
  let totalRows = 0;
  tables.forEach((t, ti) => {
    if (!t.columns.length && t.rows.length) t.columns = (t.rows[0] || []).map((_, i) => `Column ${i + 1}`);
    normalizeTable(t);
    totalRows += t.rows.length;
    const cols = t.columns;
    const div = el("div", "result-table-wrap");
    const table = el("table", "data");
    table.appendChild(el("caption", null, `Page ${t.page || "—"} · ${t.source} · ${t.rows.length} rows × ${cols.length} cols · edit columns below ↓`));
    const thead = el("thead"); const htr = el("tr");
    cols.forEach((c, ci) => {
      const th = el("th");
      const head = el("div", "th-head");
      const inp = el("input", "col-rename");
      inp.value = c;
      inp.placeholder = `Column ${ci + 1}`;
      inp.title = "Rename column";
      inp.addEventListener("input", () => { state.lastTables[ti].columns[ci] = inp.value; });
      const btn = el("button", "col-menu-btn", "⋯");
      btn.title = "Split / merge / delete column";
      btn.addEventListener("click", (e) => { e.stopPropagation(); openColMenu(btn, ti, ci, cols.length); });
      head.appendChild(inp); head.appendChild(btn);
      th.appendChild(head);
      htr.appendChild(th);
    });
    thead.appendChild(htr); table.appendChild(thead);
    const tbody = el("tbody");
    t.rows.forEach((r) => {
      const tr = el("tr");
      for (let i = 0; i < cols.length; i++) tr.appendChild(el("td", null, r[i] != null ? r[i] : ""));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); div.appendChild(table); wrap.appendChild(div);
  });
  $("#result-meta").textContent = `· ${label} · ${tables.length} table(s), ${totalRows} rows`;
  $("#results").hidden = false;
  if (!keepScroll) $("#results").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function initExport() {
  const base = () => (state.filename || "statement").replace(/\.pdf$/i, "");
  $("#dl-csv").addEventListener("click", () => {
    if (!state.lastTables.length) return;
    try { downloadCsv(state.lastTables, base() + ".csv"); }
    catch (e) { toast("CSV export failed: " + (e.message || e), true); }
  });
  $("#dl-xlsx").addEventListener("click", () => {
    if (!state.lastTables.length) return;
    try { downloadXlsx(state.lastTables, base() + ".xlsx"); }
    catch (e) { toast("Excel export failed: " + (e.message || e), true); }
  });
}

/* -------------------------------- Boot --------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  initUpload(); initTabs(); initAuto(); initManual(); initExport();
});
