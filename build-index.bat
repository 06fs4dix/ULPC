@echo off
cd /d "%~dp0extract"
echo Building index.json for all projects...
node build-index.js %*
if %errorlevel% neq 0 ( echo FAILED & pause & exit /b 1 )
echo Done!
pause
