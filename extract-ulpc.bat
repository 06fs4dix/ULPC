@echo off
cd /d "%~dp0extract"
echo Extracting sprites...
node --max-old-space-size=4096 --expose-gc extract-ulpc.js
if %errorlevel% neq 0 ( echo FAILED: extract-ulpc.js & pause & exit /b 1 )
echo Done!
pause
