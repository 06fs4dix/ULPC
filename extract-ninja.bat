@echo off
cd /d "%~dp0extract"
echo Extracting NinjaAdventure sprites...
node --max-old-space-size=4096 extract-ninja.js
if %errorlevel% neq 0 ( echo FAILED: extract-ninja.js & pause & exit /b 1 )
echo.
echo Building index...
node build-index.js
if %errorlevel% neq 0 ( echo FAILED: build-index.js & pause & exit /b 1 )
echo Done!
pause
