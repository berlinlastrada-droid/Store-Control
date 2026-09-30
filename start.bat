@echo off
title StoreControl Pro 2.0 - Zentraler Laden-, Umsatz- & Kostenmanager
echo ========================================================
echo   StoreControl Pro 2.0 - Zentraler Server
echo ========================================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [OK] Node.js gefunden. Starte zentralen Server...
    start /min "StoreControl Server" node "%~dp0server\index.js"
    timeout /t 2 /nobreak >nul
    echo Oeffne zentrale StoreControl Cloud-App...
    start "" "https://store-control-7jzt.onrender.com"
) else (
    echo [HINWEIS] Node.js nicht gefunden. Starte lokalen Offline-Modus...
    start "" "%~dp0index.html"
)

exit
