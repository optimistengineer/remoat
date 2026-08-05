#!/bin/bash
# Launcher to start Antigravity with a CDP debugging port
# Automatically detects and uses an available port

PORTS=(9222 9333 9444 9555 9666)
SELECTED_PORT=""

for port in "${PORTS[@]}"; do
    if ! lsof -i :$port > /dev/null 2>&1; then
        SELECTED_PORT=$port
        break
    fi
done

if [ -z "$SELECTED_PORT" ]; then
    echo "[ERROR] No available ports were found (${PORTS[*]})"
    echo "   Please stop any process using one of these ports."
    read -p "Press Enter to close..."
    exit 1
fi

echo "[INFO] Starting Antigravity on port $SELECTED_PORT..."
# Antigravity v2 may install as "Antigravity IDE.app"; probe the same four
# locations as remoat itself (pathUtils.getMacAppBundleCandidates), v2 first.
APP="Antigravity"
for bundle in "/Applications/Antigravity IDE.app" \
              "/Applications/Antigravity.app" \
              "$HOME/Applications/Antigravity IDE.app" \
              "$HOME/Applications/Antigravity.app"; do
    if [ -d "$bundle" ]; then
        APP="$(basename "$bundle" .app)"
        break
    fi
done
if open -a "$APP" --args --remote-debugging-port=$SELECTED_PORT; then
    echo "[OK] Launch complete! CDP port: $SELECTED_PORT"
    sleep 2
    exit 0
else
    echo "[ERROR] Failed to launch \"$APP\". Is Antigravity installed?"
    read -p "Press Enter to close..."
    exit 1
fi
