#!/usr/bin/env bash
# Start the Bank Statement Converter locally.
#
#   ./run.sh            # serve on http://127.0.0.1:8000
#   PORT=9000 ./run.sh  # custom port
#
# Requires the system tools tesseract-ocr and poppler-utils (see README).
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"

if [ ! -d .venv ]; then
  echo "› Creating virtualenv (.venv)…"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "› Installing Python dependencies…"
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

if ! command -v tesseract >/dev/null 2>&1; then
  echo "⚠  tesseract not found — OCR on scanned PDFs will fail."
  echo "   Install it:  sudo apt-get install -y tesseract-ocr poppler-utils"
fi

echo "› Serving on http://${HOST}:${PORT}  (Ctrl+C to stop)"
exec python -m uvicorn app.main:app --host "$HOST" --port "$PORT" "$@"
