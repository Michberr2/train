#!/bin/sh
# Source of the browser companion installer; publish through cli/publish.sh.
set -eu
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 22 or newer from https://nodejs.org, then run this command again.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<22){console.error("Node.js 22 or newer is required.");process.exit(1)}'
command -v curl >/dev/null 2>&1 || { echo 'curl is required.' >&2; exit 1; }
NALU_BROWSER_INSTALL="$HOME/.nalu/browser-device"
NALU_BROWSER_TMP="$(mktemp -d)"
trap 'rm -rf "$NALU_BROWSER_TMP"' EXIT HUP INT TERM
umask 077
mkdir -p "$NALU_BROWSER_INSTALL"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://n4lu.com/nalu-browser-device.cjs -o "$NALU_BROWSER_TMP/browser-device.cjs"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://n4lu.com/nalu-browser-device.sha256 -o "$NALU_BROWSER_TMP/checksum"
node -e 'const fs=require("fs"),crypto=require("crypto");const expected=fs.readFileSync(process.argv[2],"utf8").trim();const actual=crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");if(!/^[a-f0-9]{64}$/.test(expected)||actual!==expected){console.error("Browser download did not pass verification.");process.exit(1)}' "$NALU_BROWSER_TMP/browser-device.cjs" "$NALU_BROWSER_TMP/checksum"
mv "$NALU_BROWSER_TMP/browser-device.cjs" "$NALU_BROWSER_INSTALL/browser-device.cjs"
cat > "$NALU_BROWSER_INSTALL/start" <<'START'
#!/bin/sh
set -eu
if [ -z "${CHROMIUM_EXECUTABLE:-}" ]; then
  for candidate in '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
    if [ -x "$candidate" ]; then CHROMIUM_EXECUTABLE="$candidate"; break; fi
  done
fi
[ -n "${CHROMIUM_EXECUTABLE:-}" ] || { echo 'Install Google Chrome or Microsoft Edge, then start the Nalu browser companion again.' >&2; exit 1; }
export CHROMIUM_EXECUTABLE
BROWSER_DATA_DIR="$HOME/.nalu/browser-device/data"
export BROWSER_DATA_DIR
umask 077
mkdir -p "$BROWSER_DATA_DIR"
exec node "$HOME/.nalu/browser-device/browser-device.cjs"
START
chmod 700 "$NALU_BROWSER_INSTALL/start"
echo 'Nalu browser companion installed. To start it later: ~/.nalu/browser-device/start'
echo 'Keep this terminal open while Nalu works. Press Control-C to stop.'
exec "$NALU_BROWSER_INSTALL/start"
