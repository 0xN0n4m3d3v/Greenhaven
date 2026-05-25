@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

if "%~1"=="" goto usage

set "GREENHAVEN_BUILD_WORLD=%~1"
shift

set "GREENHAVEN_BUILD_ARGS="
:collect_args
if "%~1"=="" goto run_build
set "GREENHAVEN_BUILD_ARGS=%GREENHAVEN_BUILD_ARGS% "%~1""
shift
goto collect_args

:run_build
call "%SCRIPT_DIR%build-release.bat" --world "%GREENHAVEN_BUILD_WORLD%" --all %GREENHAVEN_BUILD_ARGS%
exit /b %errorlevel%

:usage
echo Usage:
echo   build-release-with-world.bat PATH [--installer] [--dir] [--all] [--build-only] [--install]
echo.
echo PATH can be either the vault root or a world folder inside the vault.
echo Example:
echo   build-release-with-world.bat C:\Greenhaven\GreenhavenWorld\GreenhavenNoir --dir
exit /b 1
