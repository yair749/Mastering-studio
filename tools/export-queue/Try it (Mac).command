#!/bin/bash
# Double-click to try the export queue on this Mac without InDesign (simulation).
# Close this Terminal window to stop it.
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"   # fallback places for Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is needed for the demo. Opening its download page: install the LTS version, then double-click this file again."
    open "https://nodejs.org/en/download"
    read -r -p "Press Return to close. "
    exit 1
fi
if [ ! -f node_modules/express/package.json ]; then
    echo "Installing the web server library, one time only. This needs the internet..."
    if ! npm ci --omit=dev --no-audit --no-fund --no-update-notifier; then
        echo "The web server library could not be installed. Is this Mac online?"
        read -r -p "Press Return to close. "
        exit 1
    fi
fi
node scripts/try-demo.js
