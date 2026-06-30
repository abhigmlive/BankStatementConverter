// Bank-statement-aware helpers: date/amount detection, amount cleanup, and
// header labelling. Pure functions, no DOM dependencies.

const DATE_RE = new RegExp(
  "^(" +
    "\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{2,4}" + // 01/02/2024
    "|\\d{4}[/\\-.]\\d{1,2}[/\\-.]\\d{1,2}" + // 2024-02-01
    "|\\d{1,2}[\\-\\s][A-Za-z]{3,9}[\\-\\s]\\d{2,4}" + // 01-Feb-2024
    "|[A-Za-z]{3,9}\\s\\d{1,2},?\\s?\\d{2,4}" + // Feb 01, 2024
    ")$"
);

const AMOUNT_RE = new RegExp(
  "^[\\(\\-+]?\\s*" +
    "(?:[€£$₹]|Rs\\.?|USD|EUR|GBP|INR)?\\s*" +
    "\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d{1,2})?" +
    "\\s*(?:[\\)]|CR|DR|Cr|Dr)?$"
);

export function isDate(token) {
  return DATE_RE.test((token || "").trim());
}

export function isAmount(token) {
  const t = (token || "").trim();
  if (!t || !/\d/.test(t)) return false;
  return AMOUNT_RE.test(t);
}

// Normalize an amount cell to a plain signed number string. Parentheses and a
// trailing "DR" mean negative; a trailing "CR" is positive. Returns the token
// unchanged if it is not amount-like.
export function cleanAmount(token) {
  let t = (token || "").trim();
  if (!t) return t;
  const raw = t;
  let negative = false;
  if (t.startsWith("(") && t.endsWith(")")) {
    negative = true;
    t = t.slice(1, -1);
  }
  const upper = t.toUpperCase();
  if (upper.endsWith("DR")) {
    negative = true;
    t = t.slice(0, -2);
  } else if (upper.endsWith("CR")) {
    t = t.slice(0, -2);
  }
  t = t.replace(/[€£$₹]|Rs\.?|USD|EUR|GBP|INR/gi, "");
  t = t.replace(/,/g, "").replace(/\s/g, "").trim();
  if (t.startsWith("-")) {
    negative = true;
    t = t.slice(1);
  }
  if (t.startsWith("+")) t = t.slice(1);
  const val = Number(t);
  if (!Number.isFinite(val) || t === "") return raw;
  const signed = negative ? -val : val;
  if (raw.includes(".") || signed !== Math.trunc(signed)) return signed.toFixed(2);
  return String(Math.trunc(signed));
}

const HEADER_KEYWORDS = new Set([
  "date", "value", "description", "narration", "particulars", "details",
  "transaction", "ref", "reference", "cheque", "chq", "debit", "credit",
  "withdrawal", "deposit", "amount", "balance", "type",
]);

export function headerScore(cells) {
  let score = 0;
  for (const c of cells) {
    for (const token of c.toLowerCase().split(/[\s/]+/)) {
      if (HEADER_KEYWORDS.has(token)) score++;
    }
  }
  return score;
}

// Turn a detected header row into clean, unique column labels.
export function guessLabels(cells) {
  const labels = [];
  const seen = new Map();
  cells.forEach((c, i) => {
    let name = (c || "").replace(/\s+/g, " ").trim() || `Column ${i + 1}`;
    const key = name.toLowerCase();
    if (seen.has(key)) {
      const n = seen.get(key) + 1;
      seen.set(key, n);
      name = `${name} ${n}`;
    } else {
      seen.set(key, 1);
    }
    labels.push(name);
  });
  return labels;
}
