@echo off
cd /d "%~dp0"
if not exist "dist\main\main.js" (
  call npm run build
)
start "" "node_modules\electron\dist\electron.exe" "dist\main\main.js"
