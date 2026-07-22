@echo off
cd /d "%~dp0"

echo Updating submodule: external/Artgine

git submodule sync -- external/Artgine
if errorlevel 1 goto :error

git -C external/Artgine reset --hard
if errorlevel 1 goto :error

git -C external/Artgine clean -fdx
if errorlevel 1 goto :error

git submodule update --init --remote --force -- external/Artgine
if errorlevel 1 goto :error

echo.
echo Done. Current commit:
git -C external/Artgine log -1 --oneline
goto :end

:error
echo.
echo Failed to update submodule external/Artgine.
exit /b 1

:end
pause
