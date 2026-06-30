// Browser PDF wrapper around PDF.js (vendored locally — no CDN).
// Provides page rendering, normalized text-layer words, and scanned detection.
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import { textContentToWords } from "./pdfwords.js";

// Resolve the worker relative to this module so it works at any hosting path.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url
).toString();

// A page with fewer than this many text-layer characters is treated as scanned.
const MIN_CHARS_FOR_TEXT = 8;

export async function loadPdf(arrayBuffer) {
  return pdfjsLib.getDocument({
    data: arrayBuffer,
    isEvalSupported: false,
  }).promise;
}

export async function pageInfos(doc) {
  const infos = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str || "").join("").trim();
    infos.push({
      index: i - 1,
      widthPt: viewport.width,
      heightPt: viewport.height,
      charCount: text.length,
      isScanned: text.length < MIN_CHARS_FOR_TEXT,
    });
  }
  return infos;
}

// Render a page into `canvas`, fitting `cssWidth` device-independent pixels.
export async function renderToCanvas(doc, pageNum, canvas, cssWidth = 900) {
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(0.2, cssWidth / base.width);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { width: canvas.width, height: canvas.height };
}

// Render a page to an offscreen canvas at a target DPI (for OCR).
export async function renderForOcr(doc, pageNum, dpi = 200) {
  const page = await doc.getPage(pageNum);
  const scale = dpi / 72;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// Normalized words from the PDF text layer for one page (1-based).
export async function textWords(doc, pageNum) {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return textContentToWords(tc.items, viewport.width, viewport.height);
}
