@echo off
cd /d "%~dp0"
if not exist "dist\main\main.js" (
  call npm run build
)
if not exist "node_modules\electron\dist\winAtmo.exe" (
  node scripts\brand-exe.mjs
)
start "" "node_modules\electron\dist\winAtmo.exe" "dist\main\main.js"
