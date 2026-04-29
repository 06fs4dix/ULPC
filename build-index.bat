@echo off
cd /d "%~dp0extract"
echo Building index.json...
node build-index.js
if %errorlevel% neq 0 ( echo FAILED: build-index.js & pause & exit /b 1 )
echo Done!
pause
