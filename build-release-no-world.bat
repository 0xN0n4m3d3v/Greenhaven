@echo off
setlocal EnableExtensions

cd /d "%~dp0"
call "%~dp0build-release.bat" --no-world --all %*
exit /b %errorlevel%
