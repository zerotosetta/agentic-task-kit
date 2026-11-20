@echo off
setlocal
"%~dp0runtime\node.exe" "%~dp0start-atk.mjs"
exit /b %errorlevel%
