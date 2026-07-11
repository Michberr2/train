#!/bin/sh
# Install the Nalu training flywheel as a launchd job (macOS) — runs every 6h.
#   ./install-flywheel.sh           install + start
#   ./install-flywheel.sh remove    stop + uninstall
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.nalu.flywheel.plist"
NODE_BIN="$(command -v node)"

if [ "$1" = "remove" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "flywheel unscheduled"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nalu.flywheel</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$HERE/flywheel.mjs</string>
  </array>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$HERE/flywheel.log</string>
  <key>StandardErrorPath</key><string>$HERE/flywheel.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "flywheel scheduled: every 6h via launchd (com.nalu.flywheel)"
echo "log: $HERE/flywheel.log · state: $HERE/.flywheel-state.json"
echo "run a cycle now:  node $HERE/flywheel.mjs"
