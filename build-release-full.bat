@echo off
setlocal EnableExtensions

cd /d "%~dp0"
call "%~dp0build-release.bat" --all %*
exit /b %errorlevel%
