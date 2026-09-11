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
  echo  VoxHF requires Node.js 24 or newer.
  echo  Install it with: winget install OpenJS.NodeJS.LTS
  echo  If Winget is unavailable, download Node.js LTS from https://nodejs.org
  echo  Close and reopen VoxHF after installation.
  pause
  exit /b 1
)

:: Fail early on an unsupported runtime, including when node_modules already
:: exists and npm's engine check would otherwise be skipped.
node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)"
if errorlevel 1 (
  echo  [ERROR] VoxHF requires Node.js 24 or newer.
  echo  Current version:
  node --version
  echo  Update it with: winget upgrade OpenJS.NodeJS.LTS
  echo  If Winget cannot update this installation, use https://nodejs.org or your Node version manager.
  echo  Close and reopen VoxHF after updating.
  pause
  exit /b 1
)

:: ffmpeg is used for Speex decoding/encoding. VoxHF only calls the ffmpeg
:: executable from PATH; it does not bundle ffmpeg binaries.
where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
  echo  [ERROR] ffmpeg was not found in PATH.
  echo  Install it with: winget install Gyan.FFmpeg
  echo  Close and reopen VoxHF after installation.
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
