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
    echo [..] apps\backend\.env missing - created from apps\backend\.env.example
    copy "apps\backend\.env.example" "apps\backend\.env" >nul
    if errorlevel 1 (
        echo [X] could not create apps\backend\.env
        pause
        exit /b 1
    )
    call :patchFreshEnv
    if errorlevel 1 (
        echo [X] fresh-install password setup FAILED - removing the incomplete .env.
        del "apps\backend\.env" >nul 2>nul
        echo     Re-run run-local.bat after fixing the error reported above.
        pause
        exit /b 1
    )
    echo [OK] FRESH INSTALL: a RANDOM SEED_ADMIN_PASSWORD was written into apps\backend\.env
    echo      Open that file to read the password, or reset later via the Ops CLI.
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
if errorlevel 1 (
    echo [X] prisma generate failed.
    popd
    pause
    exit /b 1
)

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
if errorlevel 1 (
    echo [X] db:seed failed - stack will NOT start.
    popd
    pause
    exit /b 1
)

rem Password-source truth for the summary banner: the password in .env is
rem used ONLY when the admin user is FIRST created; a re-seed never resets it
rem (seed.ts) and an OLD .env without the SEED line makes seed print a RANDOM
rem password to THIS console instead - never assume .env holds it then.
findstr /B /C:"SEED_ADMIN_PASSWORD=" .env >nul 2>nul
if errorlevel 1 (
    echo [WARN] SEED_ADMIN_PASSWORD is NOT in .env - seed printed a RANDOM password above.
    echo     Reset it via Ops CLI reset-password if lost.
)

popd

rem NO auto-kill. A node.exe on 3000/3001 is NOT proof it belongs to TCERP —
rem another Node app could hold the port. If a port is occupied, report it,
rem show the safe manual command, and stop with a non-zero exit code.
call :checkPort 3001
if errorlevel 1 goto :portConflict
call :checkPort 3000
if errorlevel 1 goto :portConflict

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
    echo [WARN] health not answering - check the Backend window log.
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
echo   Login:  admin  /  password = SEED_ADMIN_PASSWORD value in apps\backend\.env
echo           fresh install: RANDOM  --  re-seed never resets it
echo           lost it: Ops CLI reset-password
echo.
echo   Stop: close both Backend/Frontend windows, then:
echo         docker compose stop
echo ============================================
echo.
pause
goto :eof

rem --- subroutines (never fall through here from main flow) ---

:patchFreshEnv
rem Fresh install only: replace the sample SEED_ADMIN_PASSWORD placeholder in
rem apps\backend\.env with a RANDOM 24-char value drawn from a CRYPTOGRAPHIC
rem generator — System.Security.Cryptography.RandomNumberGenerator with
rem rejection sampling (Get-Random is NOT cryptographically guaranteed) — plus
rem a 4-char complexity suffix. The suffix's exclamation mark is built from
rem [char]33 because a literal ! would be eaten by cmd's enabledelayedexpansion.
rem Validates the result INSIDE PowerShell (placeholder gone, value >= 20
rem chars) and exits non-zero on ANY failure — the caller must not print
rem success and must not keep a half-written .env. UTF-8 no-BOM is preserved.
rem The password is NEVER echoed — it exists only in apps\backend\.env.
rem (%% is the batch escape for one percent; PS 5.1-compatible throughout.)
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $f='apps\backend\.env'; $enc=New-Object System.Text.UTF8Encoding($false); $t=[System.IO.File]::ReadAllText($f); $pool='abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; $max=[math]::Floor(256/$pool.Length)*$pool.Length; $rng=[System.Security.Cryptography.RandomNumberGenerator]::Create(); $pw=''; $b=New-Object byte[] 1; while($pw.Length -lt 24){ $rng.GetBytes($b); if($b[0] -lt $max){ $pw+=$pool[$b[0] %% $pool.Length] } }; $rng.Dispose(); $pw += [string][char]33 + 'Aa1'; [System.IO.File]::WriteAllText($f, ($t -replace 'SEED_ADMIN_PASSWORD=.*', ('SEED_ADMIN_PASSWORD=' + $pw)), $enc); $chk=[System.IO.File]::ReadAllText($f); if($chk -match 'change-me-strong-password'){ throw 'placeholder still present after patch' }; $m=[regex]::Match($chk,'(?m)^SEED_ADMIN_PASSWORD=(.+)$'); if(-not $m.Success -or $m.Groups[1].Value.Length -lt 20){ throw 'patched password missing or too short' }"
goto :eof

:checkPort
rem %1 = port number. Refuses to continue when ANY process (TCERP or not)
rem holds the port — this script NEVER kills anything it did not start.
netstat -aon | findstr ":%1 " | findstr LISTENING >nul 2>nul
if errorlevel 1 exit /b 0
rem ^ Port FREE: return success EXPLICITLY — a bare `goto :eof` would leak
rem   findstr's errorlevel 1 and false-trigger the caller's conflict gate
rem   (observed live: free ports reported as conflicts).
echo.
echo [X] Port %1 is ALREADY IN USE by another process.
echo     TCERP did not start it in this run, so nothing was killed.
echo.
echo     Find the owning PID (look at the LAST column of the LISTENING line):
echo       netstat -aon ^| findstr ":%1 "
echo.
echo     After you VERIFY the process is yours, stop it explicitly:
echo       taskkill /f /pid PID_NUMBER
echo.
echo     (A TCERP leftover from an earlier run: close the "TCERP Backend" /
echo      "TCERP Frontend" window, or stop-local.bat.)
exit /b 1

:portConflict
echo.
echo [X] Resolve the port conflict above, then re-run run-local.bat.
pause
exit /b 1
