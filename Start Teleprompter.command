#!/bin/bash
# macOS counterpart of "Start Teleprompter.bat": runs the app from source,
# installing Node.js first if it isn't present.
# First time only, make it runnable:  chmod +x "Start Teleprompter.command"
# Then double-click it in Finder, or run it from Terminal.

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
        echo "Node.js is not installed. Installing via Homebrew..."
        brew install node || { echo "Could not install Node.js. Please install it from https://nodejs.org"; exit 1; }
    else
        echo "Node.js is not installed. Please install it from https://nodejs.org and run this again."
        exit 1
    fi
fi

if [ ! -d node_modules ]; then
    echo "Installing dependencies..."
    npm install
fi

echo "Starting Teleprompter..."
npx electron .
