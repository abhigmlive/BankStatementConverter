#!/usr/bin/env bash
# Double-click or run this to open the Bank Statement Converter in your browser.
# It serves the current folder locally and opens http://localhost:8080.
# Needs Python (preinstalled on macOS/Linux) or Node. Nothing is uploaded.
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
URL="http://localhost:$PORT"

if command -v python3 >/dev/null 2>&1; then SERVE=(python3 -m http.server "$PORT")
elif command -v python  >/dev/null 2>&1; then SERVE=(python  -m http.server "$PORT")
elif command -v npx     >/dev/null 2>&1; then SERVE=(npx --yes serve -l "$PORT" .)
else echo "Please install Python (python.org) or Node (nodejs.org), then run this again."; read -r _; exit 1; fi

# Open the default browser shortly after the server starts.
( sleep 1.5
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) >/dev/null 2>&1 &

echo "Bank Statement Converter is running at:  $URL"
echo "Your browser should open automatically. Press Ctrl+C here to stop."
exec "${SERVE[@]}"
