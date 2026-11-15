@echo off
setlocal
cd /d "%~dp0"
echo.
echo Deriv demo read-only account snapshot
echo ------------------------------------
if not exist ".env" (
  echo ERROR: .env was not found in this folder.
  echo Copy your existing local .env file into this folder first.
  echo Never upload or share that file.
  echo.
  pause
  exit /b 1
)
node --version
if errorlevel 1 (
  echo ERROR: Node.js is not available on PATH.
  echo Install Node.js 22 or newer, then reopen this file.
  echo.
  pause
  exit /b 1
)
echo.
node scripts\demo_readonly_account_snapshot.js
echo.
echo This check is read-only. It does not place orders.
pause
