# Bank Statement Converter

Convert bank-statement **PDFs into Excel (`.xlsx`) or CSV** — right in your
browser. It works on clean digital PDFs *and* on **scanned / image-only**
documents (read with OCR). There is **no server, no install, and nothing is
uploaded** — every PDF is processed locally in the browser, so your financial
data never leaves your device.

Two extraction modes:

- **⚡ Automatic** — one click. The transaction table is detected on every page,
  columns are inferred from the layout, amounts are normalized, and multi-page
  statements are merged into one table.
- **🎯 Manual mapping** — draw the table **area**, drop **column** dividers and
  optional **row** dividers right on the page, name the fields, and (optionally)
  apply the same template to **every page**.

It's a static web app: `index.html` + `assets/`. All three engines (PDF.js,
Tesseract.js, SheetJS) and the OCR language data are **vendored locally** under
`assets/vendor/`, so it runs **fully offline with no CDN** — host it anywhere
static (GitHub Pages, Netlify, an S3 bucket, an internal server) or serve the
folder locally. Verified end-to-end in a real browser (see `npm run test:browser`).

---

## Run it

### Option A — open locally
Because browsers restrict ES modules loaded from `file://`, serve the folder
with any tiny static server:

```bash
# from the project root, pick one:
python3 -m http.server 8000
#   or:  npx serve .
```
Then open **http://localhost:8000**.

### Option B — host on GitHub Pages (free, public URL)
1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick your branch and `/ (root)`, Save.
3. Your converter is live at `https://<user>.github.io/<repo>/`.

No build step, no network at runtime. The engines are vendored under
`assets/vendor/` — there is nothing for you or your users to install or download:

| Library | Role | Vendored at |
|---------|------|-------------|
| [PDF.js](https://mozilla.github.io/pdf.js/) | render pages & read the text layer | `assets/vendor/pdfjs/` |
| [Tesseract.js](https://tesseract.projectnaptha.com/) | OCR for scanned/image pages | `assets/vendor/tesseract/` |
| English OCR data | `eng.traineddata.gz` | `assets/vendor/tessdata/` |
| [SheetJS](https://sheetjs.com/) | write the `.xlsx` file | `assets/vendor/xlsx/` |

> Because everything is local, OCR works with no internet at all. To re-generate
> the vendored files (e.g. to update a library), run `npm install && npm run vendor`.

## How to use

1. Drop a statement PDF on the page (or click to browse).
2. **Automatic tab** → *Extract automatically* → review → **CSV** or **Excel**.
   Tick *Force OCR* for scanned pages (auto-enabled when the file looks scanned).
3. **Manual tab** → *Area* to drag a box around the table, *Column* to click in
   vertical dividers (*Auto columns* guesses them), name the fields, optionally
   *Apply template to every page* → *Extract with this template*.
4. **Fix columns in the result** — in the results table, rename a column inline,
   or use its **⋯** menu to **split** a column (at the first/last space, or by any
   text), **merge** it with the neighbour on the left/right, or **delete** it. This
   lets you correct a stray boundary without re-doing the extraction; CSV/Excel
   export reflects your edits.

## How it works

Both modes reduce a page to **words with normalized coordinates** — from the PDF
text layer (PDF.js) for digital PDFs, or from OCR (Tesseract.js) for scanned
pages. Words are clustered into rows by vertical position; columns come from the
automatic corridor detector (which ignores full-width titles/headers/footers) or
from the dividers you drew. Amounts and dates are recognized and cleaned
(`1,234.50`, `(123.45)`, `123.45 DR/CR` → plain signed numbers).

```
index.html              the app
assets/css/styles.css   styling
assets/js/
  geometry.js     normalized word model + row/column clustering
  heuristics.js   date/amount detection, header labelling, amount cleanup
  extract.js      automatic + manual (template) extraction
  pdfwords.js     PDF.js / Tesseract output -> normalized words
  pdfdoc.js       PDF.js wrapper (render, text words, scanned detection)
  ocr.js          Tesseract.js wrapper
  exporter.js     tables -> CSV / XLSX (download)
  app.js          UI controller
```

## Tests

The extraction engine is covered by Node tests (the same code the browser runs),
including a check against a real sample PDF via `pdfjs-dist`. There's also a
headless-browser end-to-end test that drives the actual UI (upload → extract →
Excel download) for both a digital PDF and a scanned/OCR PDF.

```bash
npm install                      # dev/build-time tooling only (see package.json)
python3 tests/make_samples.py    # generate sample PDFs (needs Python + PyMuPDF)

npm test                         # 7 engine + CSV tests (no browser)

# optional full browser E2E (needs Chromium):
npm run serve &                  # serve on :8080
PW_CHROMIUM=/path/to/chrome npm run test:browser
```

## Privacy

Nothing is uploaded. There is no backend. PDFs are read, OCR'd, and converted
entirely in your browser tab; closing the tab discards everything.

## Optional: Python server edition

A self-hostable FastAPI version (heavier-duty server-side OCR via system
Tesseract) also lives in this repo under [`app/`](app/), with its own tests in
[`tests/`](tests/). It is **not required** for the browser app — see
[`app/`](app/) and `run.sh` if you want a server deployment instead. Start it
with `./run.sh` (needs Python 3.10+ and `tesseract-ocr`).

## Limitations

- OCR accuracy depends on scan quality; the browser build ships English. For
  other languages, Tesseract.js can load additional language data.
- Encrypted/password-protected PDFs must be unlocked before loading.
- Very large scanned statements OCR slower in-browser than on a server — use the
  Python edition for heavy batch workloads.
