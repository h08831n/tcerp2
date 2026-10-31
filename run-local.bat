@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title TCERP - Local Runner
cd /d "%~dp0"

echo.
echo ============================================
echo   TCERP - Local Runner
echo ============================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
    echo [X] Docker not in PATH. Install Docker Desktop.
    pause
    exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
    echo [..] Starting Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    set /a tries=0
    :waitdocker
    ping -n 6 127.0.0.1 >nul
    docker info >nul 2>nul
    if errorlevel 1 (
        set /a tries+=1
        if !tries! lss 30 goto waitdocker
        echo [X] Docker did not come up in 150s.
        pause
        exit /b 1
    )
)
echo [OK] Docker is up.

docker compose up -d postgres redis minio
if errorlevel 1 (
    echo [X] docker compose failed.
    pause
    exit /b 1
)

set /a tries=0
:waitpg
ping -n 4 127.0.0.1 >nul
docker inspect -f "{{.State.Health.Status}}" tcerp-postgres 2>nul | findstr healthy >nul
if errorlevel 1 (
    set /a tries+=1
    if !tries! lss 40 goto waitpg
    echo [X] PostgreSQL not healthy. logs: docker logs tcerp-postgres
    pause
    exit /b 1
)
echo [OK] PostgreSQL ready (port 5433).

if not exist "apps\backend\.env" (
    echo [..] apps\backend\.env missing - created from .env.example
    copy ".env.example" "apps\backend\.env" >nul
)

pushd apps\backend

if not exist "node_modules" (
    echo [..] npm install - backend...
    call npm install
    if errorlevel 1 (
        echo [X] backend npm install failed.
        popd
        pause
        exit /b 1
    )
)

echo [..] prisma generate...
call npx prisma generate

echo [..] migrate deploy...
call npx prisma migrate deploy
if errorlevel 1 (
    echo [X] migrate deploy failed.
    popd
    pause
    exit /b 1
)

echo [..] seed (admin user)...
call npm run db:seed

popd

for /f "tokens=5" %%p in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>nul
for /f "tokens=5" %%p in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>nul

echo [..] starting Backend on http://localhost:3001/api ...
start "TCERP Backend" cmd /k "cd /d %~dp0apps\backend && npm run start"

pushd apps\frontend

if not exist "node_modules" (
    echo [..] npm install - frontend...
    call npm install
    if errorlevel 1 (
        echo [X] frontend npm install failed.
        popd
        pause
        exit /b 1
    )
)

popd

echo [..] starting Frontend on http://localhost:3000 ...
start "TCERP Frontend" cmd /k "cd /d %~dp0apps\frontend && npm run dev"

echo [..] waiting for health...
set /a tries=0
:waithc
ping -n 4 127.0.0.1 >nul
curl -s -m 3 http://localhost:3001/api/health >nul 2>nul
if errorlevel 1 (
    set /a tries+=1
    if !tries! lss 40 goto waithc
    echo [!] health not answering - check the Backend window log.
) else (
    echo [OK] Backend health: OK
)

echo.
echo ============================================
echo   TCERP is running
echo ============================================
echo   Frontend :  http://localhost:3000
echo   Backend  :  http://localhost:3001/api
echo   Health   :  http://localhost:3001/api/health
echo   Metrics  :  http://localhost:3001/api/metrics
echo.
echo   Login:  admin  /  password from apps\backend\.env
echo           (SEED_ADMIN_PASSWORD)
echo.
echo   Stop: close both Backend/Frontend windows, then:
echo         docker compose stop
echo ============================================
echo.
pause
