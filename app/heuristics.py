"""Bank-statement-aware helpers: date/amount detection and column labelling."""

from __future__ import annotations

import re

# Common date formats seen in statements: 01/02/2024, 1-Feb-24, 2024-02-01, etc.
_DATE_RE = re.compile(
    r"""^(
        \d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}        # 01/02/2024
        | \d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}        # 2024-02-01
        | \d{1,2}[\-\s][A-Za-z]{3,9}[\-\s]\d{2,4} # 01-Feb-2024
        | [A-Za-z]{3,9}\s\d{1,2},?\s?\d{2,4}      # Feb 01, 2024
    )$""",
    re.VERBOSE,
)

# Amount with optional currency, thousands separators, sign and CR/DR suffix.
_AMOUNT_RE = re.compile(
    r"""^[\(\-+]?\s*
        (?:[€£$₹]|Rs\.?|USD|EUR|GBP|INR)?\s*
        \d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?
        \s*(?:[\)]|CR|DR|Cr|Dr)?$""",
    re.VERBOSE,
)


def is_date(token: str) -> bool:
    return bool(_DATE_RE.match(token.strip()))


def is_amount(token: str) -> bool:
    t = token.strip()
    if not t or not any(ch.isdigit() for ch in t):
        return False
    return bool(_AMOUNT_RE.match(t))


def clean_amount(token: str) -> str:
    """Normalize an amount cell to a plain signed number string.

    Parentheses and a trailing ``DR`` mark a negative; a trailing ``CR`` is
    positive.  Returns the original token unchanged if it is not amount-like.
    """
    t = token.strip()
    if not t:
        return t
    raw = t
    negative = False
    if t.startswith("(") and t.endswith(")"):
        negative = True
        t = t[1:-1]
    upper = t.upper()
    if upper.endswith("DR"):
        negative = True
        t = t[:-2]
    elif upper.endswith("CR"):
        t = t[:-2]
    t = re.sub(r"[€£$₹]|Rs\.?|USD|EUR|GBP|INR", "", t, flags=re.IGNORECASE)
    t = t.replace(",", "").replace(" ", "").strip()
    if t.startswith("-"):
        negative = True
        t = t[1:]
    if t.startswith("+"):
        t = t[1:]
    try:
        val = float(t)
    except ValueError:
        return raw
    if negative:
        val = -val
    # Keep integers tidy, money to 2 dp.
    return f"{val:.2f}" if "." in raw or val != int(val) else str(int(val))


# Keywords that frequently appear in statement header rows.
_HEADER_KEYWORDS = {
    "date",
    "value",
    "description",
    "narration",
    "particulars",
    "details",
    "transaction",
    "ref",
    "reference",
    "cheque",
    "chq",
    "debit",
    "credit",
    "withdrawal",
    "deposit",
    "amount",
    "balance",
    "type",
}


def header_score(cells: list[str]) -> int:
    score = 0
    for c in cells:
        for token in re.split(r"[\s/]+", c.lower()):
            if token in _HEADER_KEYWORDS:
                score += 1
    return score


def guess_labels(cells: list[str]) -> list[str]:
    """Turn a detected header row into clean, unique column labels."""
    labels: list[str] = []
    seen: dict[str, int] = {}
    for i, c in enumerate(cells):
        name = re.sub(r"\s+", " ", c).strip() or f"Column {i + 1}"
        key = name.lower()
        if key in seen:
            seen[key] += 1
            name = f"{name} {seen[key]}"
        else:
            seen[key] = 1
        labels.append(name)
    return labels
