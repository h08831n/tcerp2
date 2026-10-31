# ============================================================
#  TCERP — توقف کامل (اختیاری)
#  اجرا: stop-local.bat
# ============================================================
@echo off
chcp 65001 >nul
title TCERP — Stop
echo [..] توقف سرورها...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>nul
for /f "tokens=5" %%p in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>nul
docker compose stop
echo [OK] متوقف شد.
pause
