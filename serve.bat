@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" "http://localhost:8766/"
powershell.exe -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
