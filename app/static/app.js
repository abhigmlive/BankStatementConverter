"use strict";

/* ----------------------------------------------------------------------- *
 * Bank Statement Converter — frontend
 * Pages are rendered to PNG by the backend; a canvas overlay drives the
 * manual area/column/row mapping. All overlay geometry is stored normalized
 * (0..1) so it is independent of the displayed image size.
 * ----------------------------------------------------------------------- */

const API = {
  upload: "/api/upload",
  page: (sid, p, dpi = 150) => `/api/page/${sid}/${p}.png?dpi=${dpi}`,
  auto: "/api/auto-extract",
  manual: "/api/manual-extract",
  export: "/api/export",
};

const COLORS = ["#2563eb", "#16a34a", "#db2777", "#d97706", "#7c3aed", "#0891b2", "#ca8a04", "#dc2626", "#0d9488", "#9333ea"];

const state = {
  session: null,          // { session_id, filename, page_count, pages: [...] }
  page: 0,                // current manual page (0-based)
  img: { w: 0, h: 0 },    // natural size of displayed page image
  tmpl: { region: null, cols: [], rows: [] },
  colNames: [],
  lastTables: [],         // last extraction result for export
};

let tool = "area";
let dragging = null;      // { x0, y0 } during area drag

/* ----------------------------- DOM helpers ----------------------------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

function toast(msg, isError = false, ms = 3200) {
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

async function jpost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

/* ------------------------------- Upload -------------------------------- */
function initUpload() {
  const dz = $("#dropzone");
  const input = $("#file-input");
  $("#browse-btn").addEventListener("click", (e) => { e.stopPropagation(); input.click(); });
  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", () => input.files[0] && uploadFile(input.files[0]));

  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) uploadFile(f);
  });

  $("#new-file-btn").addEventListener("click", () => input.click());
}

async function uploadFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) return toast("Please choose a PDF file.", true);
  const status = $("#upload-status");
  status.hidden = false;
  status.className = "status";
  status.textContent = `Uploading ${file.name}…`;
  spinner(true, "Reading PDF…");
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(API.upload, { method: "POST", body: fd });
    if (!res.ok) {
      let d = res.statusText;
      try { d = (await res.json()).detail || d; } catch (_) {}
      throw new Error(d);
    }
    state.session = await res.json();
    status.hidden = true;
    onSessionReady();
  } catch (err) {
    status.className = "status error";
    status.textContent = "Upload failed: " + err.message;
  } finally {
    spinner(false);
  }
}

function onSessionReady() {
  const s = state.session;
  $("#upload-section").hidden = true;
  $("#workspace").hidden = false;
  $("#results").hidden = true;
  $("#file-name").textContent = s.filename;
  $("#file-pages").textContent = `${s.page_count} page${s.page_count > 1 ? "s" : ""}`;
  const scanned = s.pages.filter((p) => p.is_scanned).length;
  const kind = $("#file-kind");
  if (scanned === 0) { kind.textContent = "Text PDF"; kind.className = "badge"; }
  else if (scanned === s.page_count) { kind.textContent = "Scanned · OCR"; kind.className = "badge scan"; }
  else { kind.textContent = `${scanned}/${s.page_count} scanned`; kind.className = "badge scan"; }

  // Pre-tick force-OCR if the whole document is scanned.
  $("#auto-ocr").checked = scanned === s.page_count;
  state.page = 0;
  state.tmpl = { region: null, cols: [], rows: [] };
  state.colNames = [];
  loadManualPage();
}

/* -------------------------------- Tabs --------------------------------- */
function initTabs() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("#tab-" + t.dataset.tab).classList.add("active");
    }));
}

/* ---------------------------- Automatic mode --------------------------- */
function initAuto() {
  $("#auto-run").addEventListener("click", async () => {
    if (!state.session) return;
    spinner(true, "Extracting tables…");
    try {
      const out = await jpost(API.auto, {
        session_id: state.session.session_id,
        force_ocr: $("#auto-ocr").checked,
        merge: $("#auto-merge").checked,
      });
      if (!out.tables.length) return toast("No tables detected. Try the Manual tab.", true);
      showResults(out.tables, "Automatic extraction");
    } catch (err) {
      toast("Extraction failed: " + err.message, true);
    } finally {
      spinner(false);
    }
  });
}

/* ----------------------------- Manual mode ----------------------------- */
function initManual() {
  const stage = $("#stage");
  const canvas = $("#overlay");

  document.querySelectorAll(".tool").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tool").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      tool = b.dataset.tool;
    }));

  $("#page-prev").addEventListener("click", () => changePage(-1));
  $("#page-next").addEventListener("click", () => changePage(1));
  $("#clear-overlay").addEventListener("click", () => {
    state.tmpl = { region: null, cols: [], rows: [] };
    syncColNames();
    draw();
  });
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
    if (tool === "area") {
      dragging = { x0: p.x, y0: p.y };
    } else if (tool === "col") {
      toggleDivider(state.tmpl.cols, p.x);
      syncColNames(); draw();
    } else if (tool === "row") {
      toggleDivider(state.tmpl.rows, p.y);
      draw();
    }
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

  window.addEventListener("resize", () => { sizeCanvas(); draw(); });
}

function clamp(v) { return Math.max(0, Math.min(1, v)); }

function toggleDivider(arr, v) {
  const near = arr.findIndex((x) => Math.abs(x - v) < 0.015);
  if (near >= 0) arr.splice(near, 1);
  else { arr.push(v); arr.sort((a, b) => a - b); }
}

function changePage(delta) {
  if (!state.session) return;
  const next = state.page + delta;
  if (next < 0 || next >= state.session.page_count) return;
  state.page = next;
  loadManualPage();
}

function loadManualPage() {
  if (!state.session) return;
  const img = $("#page-img");
  $("#page-label").textContent = `Page ${state.page + 1} / ${state.session.page_count}`;
  const pinfo = state.session.pages[state.page];
  $("#manual-ocr").checked = !!(pinfo && pinfo.is_scanned);
  img.onload = () => {
    state.img = { w: img.naturalWidth, h: img.naturalHeight };
    sizeCanvas();
    draw();
  };
  img.src = API.page(state.session.session_id, state.page, 150);
}

function sizeCanvas() {
  const img = $("#page-img");
  const canvas = $("#overlay");
  const w = img.clientWidth || img.naturalWidth;
  const h = img.clientHeight || img.naturalHeight;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
}

function draw() {
  const canvas = $("#overlay");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const reg = state.tmpl.region;
  const rx0 = reg ? Math.min(reg.x0, reg.x1) : 0;
  const ry0 = reg ? Math.min(reg.y0, reg.y1) : 0;
  const rx1 = reg ? Math.max(reg.x0, reg.x1) : 1;
  const ry1 = reg ? Math.max(reg.y0, reg.y1) : 1;

  if (reg) {
    ctx.fillStyle = "rgba(37, 99, 235, .10)";
    ctx.fillRect(rx0 * W, ry0 * H, (rx1 - rx0) * W, (ry1 - ry0) * H);
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rx0 * W, ry0 * H, (rx1 - rx0) * W, (ry1 - ry0) * H);
    ctx.setLineDash([]);
  }

  // Column dividers (clipped to region vertical span).
  ctx.lineWidth = 2;
  state.tmpl.cols.forEach((x, i) => {
    ctx.strokeStyle = COLORS[(i + 1) % COLORS.length];
    ctx.beginPath();
    ctx.moveTo(x * W, ry0 * H);
    ctx.lineTo(x * W, ry1 * H);
    ctx.stroke();
  });

  // Row dividers.
  ctx.strokeStyle = "#94a3b8";
  ctx.setLineDash([4, 4]);
  state.tmpl.rows.forEach((y) => {
    ctx.beginPath();
    ctx.moveTo(rx0 * W, y * H);
    ctx.lineTo(rx1 * W, y * H);
    ctx.stroke();
  });
  ctx.setLineDash([]);
}

function syncColNames() {
  const n = state.tmpl.cols.length + 1;
  if (state.colNames.length < n) {
    while (state.colNames.length < n) state.colNames.push("");
  } else {
    state.colNames.length = n;
  }
  renderColNames();
}

function renderColNames() {
  const box = $("#col-names");
  box.innerHTML = "";
  const n = state.tmpl.cols.length + 1;
  if (n <= 1 && state.tmpl.cols.length === 0) {
    box.appendChild(el("p", "muted small", "Add column dividers to name fields."));
    return;
  }
  for (let i = 0; i < n; i++) {
    const row = el("div", "col-name-row");
    const sw = el("span", "swatch");
    sw.style.background = COLORS[i % COLORS.length];
    const inp = el("input");
    inp.placeholder = `Column ${i + 1}`;
    inp.value = state.colNames[i] || "";
    inp.addEventListener("input", () => (state.colNames[i] = inp.value));
    row.appendChild(sw);
    row.appendChild(inp);
    box.appendChild(row);
  }
}

async function guessColumns() {
  if (!state.session) return;
  spinner(true, "Detecting columns…");
  try {
    // Run an automatic extraction on this single page to reuse the column
    // detector, then adopt its separators.
    const out = await jpost(API.auto, {
      session_id: state.session.session_id,
      pages: [state.page],
      force_ocr: $("#manual-ocr").checked,
      merge: false,
    });
    const t = out.tables[0];
    if (t && t.column_separators && t.column_separators.length) {
      state.tmpl.cols = t.column_separators.slice();
      if (!state.colNames.some((c) => c)) state.colNames = (t.columns || []).slice();
      syncColNames();
      draw();
      toast(`Detected ${t.column_separators.length + 1} columns.`);
    } else {
      toast("Couldn't auto-detect columns here — add them manually.", true);
    }
  } catch (err) {
    toast("Auto columns failed: " + err.message, true);
  } finally {
    spinner(false);
  }
}

async function runManual() {
  if (!state.session) return;
  const base = {
    region: state.tmpl.region ? normRegion(state.tmpl.region) : null,
    column_separators: state.tmpl.cols.slice(),
    row_lines: state.tmpl.rows.slice(),
    column_names: state.colNames.map((c) => (c || "").trim()).filter((_, i, a) => a.some((x) => x)) ,
    header_row: $("#manual-header").checked,
  };
  // Keep column_names only if the user actually typed any.
  if (!state.colNames.some((c) => (c || "").trim())) base.column_names = [];

  const allPages = $("#manual-allpages").checked;
  const templates = [];
  if (allPages) {
    for (let p = 0; p < state.session.page_count; p++) {
      templates.push({ ...base, page: p, force_ocr: state.session.pages[p].is_scanned || $("#manual-ocr").checked });
    }
  } else {
    templates.push({ ...base, page: state.page, force_ocr: $("#manual-ocr").checked });
  }

  if (base.column_separators.length === 0 && !base.region) {
    return toast("Draw a table area or add column dividers first.", true);
  }

  spinner(true, "Extracting…");
  try {
    const out = await jpost(API.manual, {
      session_id: state.session.session_id,
      templates,
      merge: allPages,
    });
    if (!out.tables.length) return toast("Nothing extracted from this template.", true);
    showResults(out.tables, allPages ? "Manual template · all pages" : `Manual template · page ${state.page + 1}`);
  } catch (err) {
    toast("Extraction failed: " + err.message, true);
  } finally {
    spinner(false);
  }
}

function normRegion(r) {
  return {
    x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1),
  };
}

/* ------------------------------- Results ------------------------------- */
function showResults(tables, label) {
  state.lastTables = tables;
  const wrap = $("#result-tables");
  wrap.innerHTML = "";
  let totalRows = 0;
  tables.forEach((t) => {
    totalRows += t.rows.length;
    const div = el("div", "result-table-wrap");
    const table = el("table", "data");
    const cap = el("caption", null,
      `Page ${t.page || "—"} · ${t.source} · ${t.rows.length} rows × ${t.columns.length || (t.rows[0] || []).length} cols`);
    table.appendChild(cap);
    const thead = el("thead");
    const htr = el("tr");
    const cols = t.columns.length ? t.columns : (t.rows[0] || []).map((_, i) => `Column ${i + 1}`);
    cols.forEach((c) => htr.appendChild(el("th", null, c)));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el("tbody");
    t.rows.forEach((r) => {
      const tr = el("tr");
      for (let i = 0; i < cols.length; i++) tr.appendChild(el("td", null, r[i] != null ? r[i] : ""));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    div.appendChild(table);
    wrap.appendChild(div);
  });
  $("#result-meta").textContent = `· ${label} · ${tables.length} table(s), ${totalRows} rows`;
  $("#results").hidden = false;
  $("#results").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function initExport() {
  $("#dl-csv").addEventListener("click", () => downloadExport("csv"));
  $("#dl-xlsx").addEventListener("click", () => downloadExport("xlsx"));
}

async function downloadExport(format) {
  if (!state.lastTables.length) return;
  spinner(true, "Building file…");
  try {
    const base = (state.session.filename || "statement").replace(/\.pdf$/i, "");
    const res = await fetch(API.export, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tables: state.lastTables, format, filename: base }),
    });
    if (!res.ok) {
      let d = res.statusText;
      try { d = (await res.json()).detail || d; } catch (_) {}
      throw new Error(d);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.${format === "csv" ? "csv" : "xlsx"}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast("Download failed: " + err.message, true);
  } finally {
    spinner(false);
  }
}

/* -------------------------------- Boot --------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  initUpload();
  initTabs();
  initAuto();
  initManual();
  initExport();
});
