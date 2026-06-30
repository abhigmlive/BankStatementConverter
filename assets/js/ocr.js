// Browser OCR wrapper around Tesseract.js (loaded globally as `window.Tesseract`
// from a CDN in index.html). Returns normalized word boxes so OCR output drops
// straight into the same extraction pipeline as the PDF text layer.
import { tesseractWordsToWords } from "./pdfwords.js";

let workerPromise = null;

async function getWorker(onProgress) {
  if (!window.Tesseract) {
    throw new Error("OCR engine not loaded (Tesseract.js unavailable).");
  }
  if (!workerPromise) {
    // All engine + language assets are vendored locally, resolved relative to
    // this module so OCR works fully offline at any hosting path.
    const tessBase = new URL("../vendor/tesseract/", import.meta.url).toString();
    const langBase = new URL("../vendor/tessdata/", import.meta.url).toString();
    workerPromise = window.Tesseract.createWorker("eng", 1, {
      workerPath: tessBase + "worker.min.js",
      corePath: tessBase,
      langPath: langBase,
      gzip: true,
      logger: (m) => {
        if (onProgress && m.status === "recognizing text") {
          onProgress(m.progress);
        }
      },
    });
  }
  return workerPromise;
}

// OCR a rendered page canvas -> normalized words.
export async function ocrCanvas(canvas, onProgress) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(canvas);
  const words =
    data.words && data.words.length
      ? data.words
      : (data.lines || []).flatMap((l) => l.words || []);
  return tesseractWordsToWords(words, canvas.width, canvas.height);
}

export async function terminateOcr() {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}
