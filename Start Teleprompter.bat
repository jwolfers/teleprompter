@echo off
title Teleprompter Launcher

:: Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js is not installed. Installing via winget...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo.
        echo Could not auto-install Node.js. Please install it from https://nodejs.org
        pause
        exit /b 1
    )
    echo Node.js installed. You may need to restart this script.
    pause
    exit /b 0
)

:: Navigate to script directory
cd /d "%~dp0"

:: Install dependencies if needed
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

:: Launch the app
echo Starting Teleprompter...
npx electron .
