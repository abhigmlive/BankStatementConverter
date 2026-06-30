// End-to-end browser smoke test of the actual app, driven in headless Chromium
// via playwright-core. Verifies the real UI: upload -> automatic extract -> read
// the results table -> Excel download, for both a digital PDF and a scanned
// (OCR) PDF. Everything runs from vendored local assets — no CDN.
//
//   npm run vendor        # ensure assets/vendor is populated
//   python3 tests/make_samples.py   # generate sample PDFs
//   npm run serve &       # serve the app on :8080
//   npm run test:browser  # run this
//
// Chromium path: set PW_CHROMIUM to your Chromium/Chrome binary, or rely on the
// Playwright-managed install. The test skips (exit 0) if no browser is found.
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const BASE = process.env.BASE_URL || "http://localhost:8080";

function findChromium() {
  const candidates = [
    process.env.PW_CHROMIUM,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

async function run() {
  const exe = findChromium();
  if (!exe) {
    console.log("SKIP: no Chromium found (set PW_CHROMIUM=/path/to/chrome). Browser test skipped.");
    process.exit(0);
  }
  for (const f of ["text_statement.pdf", "scanned_statement.pdf"]) {
    if (!existsSync(join(ROOT, "samples", f))) {
      console.log(`SKIP: samples/${f} missing — run: python3 tests/make_samples.py`);
      process.exit(0);
    }
  }

  const browser = await chromium.launch({
    executablePath: exe,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  let failures = 0;
  const check = (cond, label) => { console.log(`${cond ? "ok  " : "FAIL"} - ${label}`); if (!cond) failures++; };
  const tableText = () => page.$eval("#result-tables", (el) => el.innerText).catch(() => "");

  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  check((await page.title()) !== "", "page loads");

  // Digital PDF -> automatic extraction -> Excel download.
  await page.setInputFiles("#file-input", join(ROOT, "samples", "text_statement.pdf"));
  await page.waitForSelector("#workspace:not([hidden])", { timeout: 15000 });
  check(/Text PDF/i.test(await page.$eval("#file-kind", (e) => e.textContent)), "text PDF detected");
  await page.click("#auto-run");
  await page.waitForFunction(() => document.querySelectorAll("#result-tables tbody tr").length > 0, { timeout: 30000 });
  const t1 = await tableText();
  check(/SALARY CREDIT ACME LTD/.test(t1), "text PDF: row content extracted");
  check(/85000\.00/.test(t1), "text PDF: amount normalized");
  const headers = () => page.$$eval("#result-tables .col-rename", (xs) => xs.map((x) => x.value));
  const h1 = await headers();
  check(["Date", "Description", "Ref", "Debit", "Credit", "Balance"].every((h) => h1.includes(h)),
    `text PDF: headers [${h1.join(", ")}]`);

  // Column editing: merge Date+Description, then split it back at the first space.
  const nCols0 = h1.length;
  await page.click("#result-tables th:first-child .col-menu-btn");
  await page.click("#col-menu button:has-text('Merge with right')");
  await page.waitForFunction((n) => document.querySelectorAll("#result-tables thead th").length === n - 1, nCols0);
  const merged = await page.$eval("#result-tables tbody tr:first-child td:first-child", (td) => td.textContent);
  check(/01\/04\/2024\s+Opening Balance/.test(merged), `merge columns -> "${merged.trim()}"`);
  await page.click("#result-tables th:first-child .col-menu-btn");
  await page.click("#col-menu button:has-text('Split at first space')");
  await page.waitForFunction((n) => document.querySelectorAll("#result-tables thead th").length === n, nCols0);
  const splitBack = await page.$eval("#result-tables tbody tr:first-child td:first-child", (td) => td.textContent);
  check(/^01\/04\/2024$/.test(splitBack.trim()), `split column back -> date isolated ("${splitBack.trim()}")`);

  const dl = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    page.click("#dl-xlsx"),
  ]).then(([d]) => d).catch(() => null);
  check(!!dl && /\.xlsx$/.test(dl.suggestedFilename()), "text PDF: Excel downloads");

  // Scanned PDF -> OCR (fully local).
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.setInputFiles("#file-input", join(ROOT, "samples", "scanned_statement.pdf"));
  await page.waitForFunction(
    () => /scan|ocr/i.test(document.querySelector("#file-kind")?.textContent || ""), { timeout: 20000 }
  ).catch(() => {});
  check(/Scanned|OCR/i.test(await page.$eval("#file-kind", (e) => e.textContent)), "scanned PDF detected");
  console.log("    (running local OCR — may take ~30-60s)");
  await page.click("#auto-run");
  await page.waitForFunction(() => document.querySelectorAll("#result-tables tbody tr").length > 0, { timeout: 150000 });
  const t2 = await tableText();
  check(/SALARY/i.test(t2), "scanned PDF: OCR extracted transaction text");
  check(/12500|85000|BALANCE/i.test(t2.replace(/,/g, "")), "scanned PDF: OCR extracted amounts/headers");

  if (errors.length) { console.log("\nPage errors:"); errors.slice(0, 8).forEach((e) => console.log("  - " + e)); }
  await browser.close();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
