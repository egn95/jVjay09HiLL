@echo off
title AKTA IAT Server
echo.
echo  ========================================
echo    AKTA IAT - Sistem Manajemen Audit
echo  ========================================
echo.

:: Refresh PATH supaya node ditemukan
set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"

:: Cek apakah node tersedia
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Node.js tidak ditemukan!
    echo  Silakan install Node.js dari https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Pindah ke direktori aplikasi
cd /d "%~dp0"

:: Install dependencies jika node_modules belum ada
if not exist "node_modules" (
    echo  Menginstall dependencies...
    npm install
    echo.
)

echo  Menjalankan server di http://localhost:3000
echo  Tekan Ctrl+C untuk menghentikan server
echo.

:: Buka browser secara otomatis setelah 2 detik
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Jalankan server
node server.js

pause
