# Bank Statement Converter

Convert bank-statement **PDFs into Excel (`.xlsx`) or CSV** — right in your
browser. It works on clean digital PDFs *and* on **scanned / image-only**
documents (read with OCR). There is **no server, no install, and nothing is
uploaded** — every PDF is processed locally in the browser, so your financial
data never leaves your device.

Two extraction modes, like [bankstatementconverter.com](https://bankstatementconverter.com/):

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

### Option A — open locally (easiest)
Just run the launcher for your OS — it starts a local server and opens your
browser automatically:

- **Windows:** double-click **`start.bat`**
- **macOS:** double-click **`start.command`** (or run `./start.sh`)
- **Linux:** run **`./start.sh`**

Or do it by hand (browsers block ES modules over `file://`, so use a server):

```bash
python3 -m http.server 8000   # or:  npx serve .
```
Then open **http://localhost:8000**. Nothing is uploaded — it all runs locally.

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

## Accounts & saved history (optional — Firebase)

Sign-in and a per-user **History** of saved conversions are available via
Firebase, with **no backend server** — it's all client-side SDKs. The converter
itself still works without signing in; logging in just unlocks **☁ Save** and
**🕘 History**. Only the *extracted results* are saved (never the original PDF),
so "PDFs stay in your browser" still holds.

It's wired to a Firebase project in [`assets/js/firebase-config.js`](assets/js/firebase-config.js).
To use your own project:

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com/) and add a **Web app**; paste its config into `assets/js/firebase-config.js`.
2. **Authentication → Sign-in method:** enable **Email/Password** and (optionally) **Google**.
3. **Firestore Database:** create a database (production mode).
4. **Rules:** paste [`firestore.rules`](firestore.rules) into Firestore → Rules and publish (each user can only read/write their own records).
5. **Authorized domains** (Authentication → Settings): add the domain you host on (`localhost` is allowed by default for local testing).

> The Firebase web config keys are **public by design** — security is enforced by
> Auth + the Firestore rules, not by hiding the keys. Sign-in/history need
> internet; PDF extraction and OCR still work fully offline.

If `firebase-config.js` is left unset, the app simply runs without the
account/history features — nothing breaks.

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
  cloud.js        optional Firebase auth + saved-history API (defensive)
  firebase-config.js  your Firebase project keys (public by design)
  app.js          UI controller
firestore.rules         Firestore Security Rules (per-user access)
```

## Tests

The extraction engine is covered by Node tests (the same code the browser runs),
including a check against a real sample PDF via `pdfjs-dist`. There's also a
headless-browser end-to-end test that drives the actual UI (upload → extract →
Excel download) for both a digital PDF and a scanned/OCR PDF.

Sample PDFs (`samples/text_statement.pdf`, `samples/scanned_statement.pdf`) are
committed, so the tests run against them directly.

```bash
npm install                      # dev/build-time tooling only (see package.json)

npm test                         # engine + CSV tests (no browser)

# optional full browser E2E (needs Chromium):
npm run serve &                  # serve on :8080
PW_CHROMIUM=/path/to/chrome npm run test:browser
```

## Privacy

The PDF is never uploaded — it's read, OCR'd, and converted entirely in your
browser tab. With the optional Firebase sign-in, only the *extracted results*
are saved to your account (never the source PDF).

## Limitations

- OCR accuracy depends on scan quality; the build ships English. For other
  languages, Tesseract.js can load additional language data.
- Encrypted/password-protected PDFs must be unlocked before loading.
- Sign-in and saved history need internet (Firebase); extraction and OCR work
  fully offline.
