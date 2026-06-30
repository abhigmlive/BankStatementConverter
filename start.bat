@echo off
REM Double-click to open the Bank Statement Converter in your browser.
REM Serves this folder locally and opens http://localhost:8080. Nothing is uploaded.
cd /d "%~dp0"
set PORT=8080
echo Bank Statement Converter is running at: http://localhost:%PORT%
echo Your browser should open automatically. Close this window to stop.
start "" "http://localhost:%PORT%"
python -m http.server %PORT% 2>nul && goto :eof
py -m http.server %PORT% 2>nul && goto :eof
npx --yes serve -l %PORT% .
echo.
echo Could not find Python or Node. Install Python from https://www.python.org/ and try again.
pause
