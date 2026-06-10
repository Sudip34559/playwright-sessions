#!/bin/bash

# ===================================================
#        Starting Proctoring Test Launcher...
# ===================================================

echo "==================================================="
echo "       Starting Proctoring Test Launcher..."
echo "==================================================="
echo

# Get current script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Install Node Packages if missing
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo "[Setup 1/3] Installing background packages..."
    npm install --silent
fi

# 2. Install Playwright Browsers locally if missing
if [ ! -d "$SCRIPT_DIR/pw-browsers" ]; then
    echo "[Setup 2/3] Downloading web browser for tests..."
    echo "This may take a few minutes depending on your internet speed."
    # Tell Playwright to store browsers locally
    export PLAYWRIGHT_BROWSERS_PATH="$SCRIPT_DIR/pw-browsers"
    npx playwright install chromium
fi

# Start the Node.js server
echo
echo "Starting the test."
npx playwright test