// Convert PDF.js text-layer items into normalized word boxes.
//
// PDF.js returns text "items" that may bundle several words together, in PDF
// user space (origin bottom-left). This splits each item into whitespace-
// delimited words, distributing the item's width across them by character
// offset, and converts to normalized top-left coordinates in [0, 1].
//
// Kept dependency-free so it runs both in the browser (with pdf.js from a CDN)
// and under Node for testing.
export function textContentToWords(items, viewportWidth, viewportHeight) {
  const vw = viewportWidth || 1;
  const vh = viewportHeight || 1;
  const words = [];
  for (const item of items) {
    const str = item.str || "";
    if (!str.trim()) continue;
    const t = item.transform || [1, 0, 0, 1, 0, 0];
    const x = t[4];
    const yBaseline = t[5];
    const h = item.height || Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 8;
    const width = item.width || 0;
    const total = str.length || 1;

    // Find each non-space token and its character offset within the item.
    const re = /\S+/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const token = m[0];
      const start = m.index;
      const x0 = x + (width * start) / total;
      const x1 = x + (width * (start + token.length)) / total;
      // Box spans from baseline up by the glyph height.
      const top = vh - (yBaseline + h);
      const bottom = vh - yBaseline;
      words.push({
        text: token,
        x0: x0 / vw,
        y0: top / vh,
        x1: x1 / vw,
        y1: bottom / vh,
        conf: null,
      });
    }
  }
  return words;
}

// Convert Tesseract.js word output (pixel boxes) into normalized words.
export function tesseractWordsToWords(tWords, imgWidth, imgHeight, minConf = 30) {
  const iw = imgWidth || 1;
  const ih = imgHeight || 1;
  const out = [];
  for (const w of tWords || []) {
    const text = (w.text || "").trim();
    if (!text) continue;
    if (typeof w.confidence === "number" && w.confidence < minConf) continue;
    const b = w.bbox || {};
    out.push({
      text,
      x0: (b.x0 ?? 0) / iw,
      y0: (b.y0 ?? 0) / ih,
      x1: (b.x1 ?? 0) / iw,
      y1: (b.y1 ?? 0) / ih,
      conf: typeof w.confidence === "number" ? w.confidence : null,
    });
  }
  return out;
}
