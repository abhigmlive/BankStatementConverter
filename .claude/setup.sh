#!/usr/bin/env bash
# SessionStart hook: prepare the environment so tests and the app can run.
# Installs the OCR/PDF system tools (not in the base image) and Python deps.
# Safe to run repeatedly; stays quiet on success.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 0

if ! command -v tesseract >/dev/null 2>&1 || ! command -v pdftoppm >/dev/null 2>&1; then
  sudo apt-get update -qq >/dev/null 2>&1 || true
  sudo apt-get install -y -qq tesseract-ocr poppler-utils ghostscript >/dev/null 2>&1 || true
fi

if [ ! -d .venv ]; then
  python3 -m venv .venv >/dev/null 2>&1 || true
fi
if [ -d .venv ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install --quiet --upgrade pip >/dev/null 2>&1 || true
  pip install --quiet -r requirements.txt pytest >/dev/null 2>&1 || true
fi

echo "Bank Statement Converter env ready (tesseract: $(command -v tesseract >/dev/null 2>&1 && echo yes || echo no))."
