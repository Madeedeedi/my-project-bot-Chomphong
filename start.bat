@echo off
title Spam Guard Bot
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo    Spam Guard Bot
echo ============================================
echo.

:start
call npm start
echo.
echo Bot หยุดทำงาน กำลังรีสตาร์ทใน 5 วินาที... (กด Ctrl+C เพื่อออก)
timeout /t 5 /nobreak >nul
goto start