@echo off
:: Start VoxHF from the folder where this file lives. This makes the launcher
:: work even when it is double-clicked from Explorer.
cd /d "%~dp0"


:: Add the user PATH from the registry because winget updates it after login.
:: This helps Windows find node/ffmpeg immediately after a winget install.
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "PATH=%PATH%;%%b"

:: Node.js runs the proxy and hosts the local webapp.
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo  [ERROR] Node.js was not found.
  echo  Download it from https://nodejs.org
  pause
  exit /b 1
)

:: ffmpeg is used for Speex decoding/encoding. VoxHF only calls the ffmpeg
:: executable from PATH; it does not bundle ffmpeg binaries.
where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
  echo  [ERROR] ffmpeg was not found in PATH.
  echo  Install it with: winget install Gyan.FFmpeg
  pause
  exit /b 1
)

:: Install the exact locked runtime dependencies only on first launch. Existing
:: node_modules is left untouched to avoid changing a working setup.
if not exist node_modules (
  echo  Installing dependencies...
  call npm ci --omit=dev
  if errorlevel 1 (
    echo  [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
  echo.
)

:: A first-run wizard creates the local configuration with the tested audio
:: defaults. Existing installations skip it and keep their current settings.
if not exist config.json (
  echo  First run: opening VoxHF setup...
  node scripts\setup.js local
  if errorlevel 1 (
    echo  [ERROR] Setup did not complete.
    pause
    exit /b 1
  )
  echo.
)

:: Start the proxy. When it exits, pause keeps the console visible so startup
:: errors can be read instead of disappearing immediately.
node proxy.js
pause
