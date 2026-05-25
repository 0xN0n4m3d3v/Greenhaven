@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

if "%~1"=="" goto usage

set "GREENHAVEN_BUILD_WORLDS=%~1"
shift

set "GREENHAVEN_BUILD_ARGS="
:collect_args
if "%~1"=="" goto run_build
set "GREENHAVEN_BUILD_ARGS=%GREENHAVEN_BUILD_ARGS% "%~1""
shift
goto collect_args

:run_build
call "%SCRIPT_DIR%build-release.bat" --worlds "%GREENHAVEN_BUILD_WORLDS%" --all %GREENHAVEN_BUILD_ARGS%
exit /b %errorlevel%

:usage
echo Usage:
echo   build-release-with-worlds.bat MANIFEST.json [--installer] [--dir] [--all] [--build-only] [--install]
echo.
echo MANIFEST.json example:
echo   {"default":"greenhaven-noir","worlds":[{"id":"greenhaven-noir","path":"C:\\Greenhaven\\GreenhavenWorld\\GreenhavenNoir","title":"Greenhaven Noir"}]}
exit /b 1
