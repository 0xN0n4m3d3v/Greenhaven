@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "MODE=installer"
set "RUN_INSTALL=0"
set "CARTRIDGE_MODE=default"
set "CARTRIDGE_WORLD_PATH="
set "CARTRIDGE_WORLDS_MANIFEST="

:parse_args
if "%~1"=="" goto after_args

if /I "%~1"=="--help" goto usage
if /I "%~1"=="-h" goto usage

if /I "%~1"=="--installer" (
  set "MODE=installer"
  shift
  goto parse_args
)

if /I "%~1"=="--dir" (
  set "MODE=dir"
  shift
  goto parse_args
)

if /I "%~1"=="--all" (
  set "MODE=all"
  shift
  goto parse_args
)

if /I "%~1"=="--build-only" (
  set "MODE=build"
  shift
  goto parse_args
)

if /I "%~1"=="--install" (
  set "RUN_INSTALL=1"
  shift
  goto parse_args
)

if /I "%~1"=="--no-world" (
  set "CARTRIDGE_MODE=none"
  set "CARTRIDGE_WORLD_PATH="
  shift
  goto parse_args
)

if /I "%~1"=="--world" (
  if "%~2"=="" (
    echo ERROR: --world requires a path.
    echo.
    goto usage
  )
  set "CARTRIDGE_MODE=custom"
  set "CARTRIDGE_WORLD_PATH=%~2"
  shift
  shift
  goto parse_args
)

if /I "%~1"=="--worlds" (
  if "%~2"=="" (
    echo ERROR: --worlds requires a JSON manifest path.
    echo.
    goto usage
  )
  set "CARTRIDGE_MODE=multi"
  set "CARTRIDGE_WORLD_PATH="
  set "CARTRIDGE_WORLDS_MANIFEST=%~2"
  shift
  shift
  goto parse_args
)

echo Unknown option: %~1
echo.
goto usage

:after_args
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: node.exe was not found in PATH.
  echo Install Node.js 20+ and run this script again.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm.cmd was not found in PATH.
  echo Install npm and run this script again.
  exit /b 1
)

for /f "delims=" %%V in ('node --version') do set "NODE_VERSION=%%V"
for /f "delims=" %%V in ('npm --version') do set "NPM_VERSION=%%V"

echo GreenHaven release build
echo Root: %CD%
echo Node: %NODE_VERSION%
echo npm: %NPM_VERSION%
echo Mode: %MODE%
echo Cartridge mode: %CARTRIDGE_MODE%
if /I "%CARTRIDGE_MODE%"=="custom" echo Cartridge path: %CARTRIDGE_WORLD_PATH%
if /I "%CARTRIDGE_MODE%"=="multi" echo Cartridge manifest: %CARTRIDGE_WORLDS_MANIFEST%
echo.

if "%RUN_INSTALL%"=="1" (
  echo Running npm install...
  call npm install
  if errorlevel 1 goto fail
  echo.
)

if /I "%CARTRIDGE_MODE%"=="default" (
  echo Preparing full GreenHaven cartridge...
  call npm run prepare:greenhaven-cartridge
  if errorlevel 1 goto fail
  echo.
) else (
  echo Skipping legacy default-cartridge prebuild; desktop asset preparation owns cartridge mode "%CARTRIDGE_MODE%".
  echo.
)

echo Preparing desktop resource payload...
set "GREENHAVEN_DESKTOP_CARTRIDGE_MODE=%CARTRIDGE_MODE%"
if defined CARTRIDGE_WORLD_PATH (
  set "GREENHAVEN_DESKTOP_WORLD_PATH=%CARTRIDGE_WORLD_PATH%"
) else (
  set "GREENHAVEN_DESKTOP_WORLD_PATH="
)
if defined CARTRIDGE_WORLDS_MANIFEST (
  set "GREENHAVEN_DESKTOP_WORLDS_MANIFEST=%CARTRIDGE_WORLDS_MANIFEST%"
) else (
  set "GREENHAVEN_DESKTOP_WORLDS_MANIFEST="
)
call npm run prepare:greenhaven-desktop-assets
if errorlevel 1 goto fail
echo.

if /I not "%MODE%"=="build" (
  echo Cleaning previous desktop release output...
  if exist "packages\desktop-electron\release" rmdir /s /q "packages\desktop-electron\release"
  if errorlevel 1 goto fail
  echo.
)

if /I "%MODE%"=="build" (
  call npm run build:greenhaven-desktop:prepared
  if errorlevel 1 goto fail
  goto done
)

if /I "%MODE%"=="dir" (
  call npm run dist:greenhaven-win-dir:prepared
  if errorlevel 1 goto fail
  goto done
)

if /I "%MODE%"=="all" (
  call npm run dist:greenhaven-win-dir:prepared
  if errorlevel 1 goto fail
  call npm run dist:greenhaven-win:prepared
  if errorlevel 1 goto fail
  goto done
)

call npm run dist:greenhaven-win:prepared
if errorlevel 1 goto fail

:done
echo.
echo Release build completed.
echo Installer: packages\desktop-electron\release\GreenHaven Setup 0.0.1.exe
echo Unpacked:  packages\desktop-electron\release\win-unpacked\GreenHaven.exe
echo.
echo Runtime data and API keys are not bundled into the release.
echo Desktop runtime config lives in: %%APPDATA%%\GreenHaven\config\greenhaven.env
exit /b 0

:fail
echo.
echo ERROR: release build failed.
exit /b 1

:usage
echo Usage:
echo   build-release.bat [--installer] [--dir] [--all] [--build-only] [--install] [--no-world] [--world PATH] [--worlds MANIFEST.json]
echo.
echo Options:
echo   --installer   Build the Windows installer. This is the default.
echo   --dir         Build the unpacked Windows app directory only.
echo   --all         Build both unpacked app directory and installer.
echo   --build-only  Compile backend, frontend, and Electron code without packaging.
echo   --install     Run npm install before building.
echo   --no-world    Package the engine and UI without a bundled default world/database.
echo   --world PATH  Package PATH as the bundled default Obsidian world. PATH can be
echo                 the vault root or a world folder inside that vault.
echo   --worlds JSON Package multiple precompiled Obsidian worlds. JSON shape:
echo                 {"default":"world-id","worlds":[{"id":"world-id","path":"C:\\path","title":"World"}]}
echo   --help        Show this help.
echo.
echo Examples:
echo   build-release.bat
echo   build-release.bat --dir
echo   build-release.bat --all --install
echo   build-release.bat --no-world --dir
echo   build-release.bat --world C:\Greenhaven\GreenhavenWorld\GreenhavenNoir --all
echo   build-release.bat --worlds C:\Greenhaven\bundle-worlds.json --dir
exit /b 0
