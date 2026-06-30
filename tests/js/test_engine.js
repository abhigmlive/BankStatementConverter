// Core engine tests (Node). Verifies the same extraction code the browser runs:
// geometry clustering, bank heuristics, automatic & manual extraction, merge,
// and the PDF.js text-item -> word conversion against a real sample PDF.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { cleanAmount, isAmount, isDate } from "../../assets/js/heuristics.js";
import { autoExtract, applyTemplate, mergeTables } from "../../assets/js/extract.js";
import { textContentToWords } from "../../assets/js/pdfwords.js";
import { clusterRows, detectColumnBounds } from "../../assets/js/geometry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const TEXT_PDF = join(ROOT, "samples", "text_statement.pdf");

// --- Synthetic page mirroring a 6-column statement with two full-width header
// --- lines above the table (the case that used to merge Date+Description).
function syntheticWords() {
  const W = 595, H = 842;
  const cols = [
    { x: 40, key: "date" },
    { x: 110, key: "desc" },
    { x: 300, key: "ref" },
    { x: 360, key: "debit" },
    { x: 430, key: "credit" },
    { x: 510, key: "balance" },
  ];
  const header = ["Date", "Description", "Ref", "Debit", "Credit", "Balance"];
  const data = [
    ["01/04/2024", "Opening Balance", "OPN001", "", "", "12,500.00"],
    ["05/04/2024", "SALARY CREDIT ACME LTD", "NEFT01", "", "85,000.00", "96,201.00"],
    ["09/04/2024", "ATM WITHDRAWAL MG ROAD", "ATM772", "5,000.00", "", "91,201.00"],
    ["12/04/2024", "ELECTRICITY BILL BESCOM", "BIL334", "2,340.50", "", "88,860.50"],
    ["18/04/2024", "IMPS RENT TRANSFER", "IMPS90", "25,000.00", "", "63,860.50"],
  ];
  const words = [];
  const mk = (text, xPt, yPt) => {
    const wPt = Math.max(text.length * 4.6, 4);
    words.push({ text, x0: xPt / W, y0: yPt / H, x1: (xPt + wPt) / W, y1: (yPt + 10) / H, conf: null });
  };
  // Two full-width title/account lines above the table. Real extractors (PDF.js,
  // Tesseract) return these word-by-word, so emit individual words advancing in x.
  const mkLine = (text, yPt, startX = 40) => {
    let xPt = startX;
    for (const tok of text.split(" ")) {
      mk(tok, xPt, yPt);
      xPt += tok.length * 4.6 + 6; // word width + a space
    }
  };
  mkLine("ACME BANK Statement of Account for April 2024 Page 1", 50);
  mkLine("Account XXXX1234 Period 01-Apr-2024 to 30-Apr-2024 Branch MG Road", 70);
  // Header row.
  header.forEach((t, i) => mk(t, cols[i].x, 110));
  // Data rows. Multi-word cells advance by each word's width (as real text
  // does) so inter-word gaps don't artificially align across rows.
  data.forEach((row, r) => {
    row.forEach((cell, i) => {
      if (!cell) return;
      let xPt = cols[i].x;
      for (const tok of cell.split(" ")) {
        mk(tok, xPt, 128 + r * 16);
        xPt += tok.length * 4.6 + 5;
      }
    });
  });
  return words;
}

test("heuristics: dates and amounts", () => {
  assert.equal(isDate("01/04/2024"), true);
  assert.equal(isDate("01-Apr-2024"), true);
  assert.equal(isDate("hello"), false);
  assert.equal(isAmount("12,500.00"), true);
  assert.equal(isAmount("(123.45)"), true);
  assert.equal(isAmount("1,234.50 DR"), true);
  assert.equal(isAmount("NEFT01"), false);
});

test("heuristics: amount cleanup", () => {
  assert.equal(cleanAmount("12,500.00"), "12500.00");
  assert.equal(cleanAmount("(123.45)"), "-123.45");
  assert.equal(cleanAmount("1,000.00 DR"), "-1000.00");
  assert.equal(cleanAmount("500 CR"), "500");
  assert.equal(cleanAmount("₹ 2,340.50"), "2340.50");
});

test("auto extract: isolates the Date column despite full-width title lines", () => {
  // Regression guard for the bug where full-width title/account lines filled the
  // Date|Description gap and merged the two columns. The Date column must be
  // detected as its own column. (Full 6-column separation — including sparse
  // debit/credit columns — is asserted end-to-end on the real PDF below.)
  const table = autoExtract(syntheticWords(), 1, "text");
  assert.ok(table, "should produce a table");
  assert.equal(table.columns[0], "Date");
  const salary = table.rows.find((r) => r.join(" ").includes("SALARY"));
  assert.ok(salary, "salary row present");
  assert.equal(salary[0], "05/04/2024", "date stays isolated in column 0");
  assert.ok(salary[1].startsWith("SALARY CREDIT ACME LTD"), "description starts in column 1");
});

// Dense statement where long descriptions extend toward the amount columns, so
// no inter-column gap is ever fully empty. The old empty-corridor detector
// collapsed this to a single column; the valley detector must still split it.
function denseWords() {
  const W = 1;
  const charW = 0.0065;
  const words = [];
  const mk = (text, x0, y) => words.push({ text, x0, y0: y, x1: x0 + text.length * charW, y1: y + 0.012, conf: null });
  const mkRight = (text, xr, y) => mk(text, xr - text.length * charW, y);
  for (let i = 0; i < 20; i++) {
    const y = 0.12 + i * 0.04;
    mk(`0${(i % 9) + 1}/04/2024`, 0.04, y); // Date column
    // Description: alternating short and long (long ones reach toward the amounts).
    const desc = i % 2
      ? `UPI PAYMENT TO MERCHANT SERVICES PRIVATE LIMITED REF ${1000 + i}`
      : `ATM CASH ${100 + i}`;
    let dx = 0.16;
    for (const tok of desc.split(" ")) { mk(tok, dx, y); dx += tok.length * charW + 0.006; }
    // Right-aligned amount columns (one of debit/credit per row, balance always).
    if (i % 2) mkRight("1,250.00", 0.70, y);
    else mkRight("3,400.00", 0.83, y);
    mkRight(`${(50000 + i * 137)}.00`, 0.985, y);
  }
  return words;
}

test("auto extract: dense layout with bridging descriptions still splits columns", () => {
  const words = denseWords();
  const rows = clusterRows(words);
  const seps = detectColumnBounds(rows);
  // Must find at least Date|Desc, Desc|Debit, Debit|Credit, Credit|Balance.
  assert.ok(seps.length >= 4, `expected >=4 separators, got ${seps.length}: ${JSON.stringify(seps.map((s) => +s.toFixed(2)))}`);
  const table = autoExtract(words, 1, "text");
  assert.ok(table.columns.length >= 5, `expected >=5 columns, got ${table.columns.length}`);
  // A long-description row: date stays in col 0, full description in col 1.
  const longRow = table.rows.find((r) => r.join(" ").includes("MERCHANT SERVICES"));
  assert.ok(longRow, "long-description row present");
  assert.match(longRow[0], /^0\d\/04\/2024$/); // date isolated
  assert.match(longRow[1], /UPI PAYMENT TO MERCHANT SERVICES PRIVATE LIMITED/); // whole description together
});

test("manual template: explicit columns and names", () => {
  const seps = [100, 295, 355, 425, 500].map((x) => x / 595);
  const table = applyTemplate(syntheticWords(), "text", {
    page: 0,
    region: { x0: 0.04, y0: 0.12, x1: 0.98, y1: 0.5 },
    columnSeparators: seps,
    columnNames: ["Date", "Description", "Ref", "Debit", "Credit", "Balance"],
  });
  assert.equal(table.columns.length, 6);
  const flat = table.rows.map((r) => r.join(" ")).join(" | ");
  assert.match(flat, /ATM WITHDRAWAL MG ROAD/);
});

test("merge tables across pages", () => {
  const t = autoExtract(syntheticWords(), 1, "text");
  const merged = mergeTables([t, { ...t, page: 2 }]);
  assert.equal(merged.columns[0], "Page");
  assert.equal(merged.rows.length, t.rows.length * 2);
});

test("PDF.js text path on the real sample PDF", async (t) => {
  if (!existsSync(TEXT_PDF)) {
    t.skip("sample PDF missing; run: python tests/make_samples.py");
    return;
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(TEXT_PDF));
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const words = textContentToWords(tc.items, viewport.width, viewport.height);
  assert.ok(words.length > 20, "should extract many words");
  const table = autoExtract(words, 1, "text");
  assert.ok(table, "should extract a table from the real PDF");
  assert.deepEqual(table.columns, ["Date", "Description", "Ref", "Debit", "Credit", "Balance"]);
  const flat = table.rows.map((r) => r.join(" ")).join(" | ");
  assert.match(flat, /SALARY CREDIT ACME LTD/);
  assert.match(flat, /85000\.00/);
});
