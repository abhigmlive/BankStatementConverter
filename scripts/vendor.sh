#!/usr/bin/env bash
# Regenerate assets/vendor/ — the locally-vendored browser libraries that make
# the app fully offline (no CDN). Run after `npm install`.
#
# English OCR data comes from the system Tesseract install if present, otherwise
# you can drop any eng.traineddata into the tessdata folder and gzip it.
set -euo pipefail
cd "$(dirname "$0")/.."

V=assets/vendor
mkdir -p "$V/pdfjs" "$V/tesseract" "$V/tessdata" "$V/xlsx"

echo "› PDF.js"
cp node_modules/pdfjs-dist/build/pdf.min.mjs "$V/pdfjs/"
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs "$V/pdfjs/"

echo "› Tesseract.js (main + worker + LSTM cores)"
cp node_modules/tesseract.js/dist/tesseract.min.js "$V/tesseract/"
cp node_modules/tesseract.js/dist/worker.min.js "$V/tesseract/"
# Only the LSTM cores are needed (the app always uses OEM=1); keep SIMD + plain
# so both SIMD and non-SIMD browsers work.
for f in tesseract-core-lstm tesseract-core-simd-lstm; do
  cp "node_modules/tesseract.js-core/$f.js" "$V/tesseract/"
  cp "node_modules/tesseract.js-core/$f.wasm" "$V/tesseract/"
  cp "node_modules/tesseract.js-core/$f.wasm.js" "$V/tesseract/"
done

echo "› SheetJS"
cp node_modules/xlsx/dist/xlsx.full.min.js "$V/xlsx/"

echo "› English OCR data (eng.traineddata.gz)"
SYS_TD="$(find /usr/share/tesseract-ocr -name eng.traineddata 2>/dev/null | head -1 || true)"
if [ -n "$SYS_TD" ]; then
  gzip -c "$SYS_TD" > "$V/tessdata/eng.traineddata.gz"
  echo "  from $SYS_TD"
elif [ -f "$V/tessdata/eng.traineddata.gz" ]; then
  echo "  keeping existing $V/tessdata/eng.traineddata.gz"
else
  echo "  WARNING: no eng.traineddata found. Install tesseract-ocr-eng or place"
  echo "  eng.traineddata.gz into $V/tessdata/ manually (OCR will fail without it)."
fi

echo "Done. Vendored size:"
du -sh "$V"
