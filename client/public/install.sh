#!/bin/sh
# Nalu CLI installer — usage:  curl -fsSL https://n4lu.com/install.sh | sh
# Installs the Nalu terminal agent (single-file, Node 18+) to ~/.nalu/bin and
# puts a `nalu` command on your PATH. Re-run any time to update (or: nalu update).
set -e

BASE="${NALU_INSTALL_URL:-https://n4lu.com}"
DIR="$HOME/.nalu/bin"

# ── Node.js 18+ is the only requirement ──
if ! command -v node >/dev/null 2>&1; then
  echo "Nalu CLI needs Node.js 18+ and it was not found."
  echo "  macOS:  brew install node        (or download from https://nodejs.org)"
  echo "  Linux:  use your package manager (or https://nodejs.org)"
  echo "Then re-run:  curl -fsSL $BASE/install.sh | sh"
  exit 1
fi
MAJOR=$(node -e 'process.stdout.write(String(process.versions.node).split(".")[0])' 2>/dev/null || true)
case "$MAJOR" in
  ''|*[!0-9]*)
    echo "Could not determine your Node.js version (node -v failed). Reinstall Node.js 18+: https://nodejs.org"
    exit 1
    ;;
esac
if [ "$MAJOR" -lt 18 ]; then
  echo "Nalu CLI needs Node.js 18+ (found $(node -v)). Please upgrade: https://nodejs.org"
  exit 1
fi

# ── download the CLI ──
mkdir -p "$DIR"
echo "Downloading Nalu CLI from $BASE/nalu.mjs …"
curl -fsSL "$BASE/nalu.mjs" -o "$DIR/nalu.mjs.tmp"
head -c 100 "$DIR/nalu.mjs.tmp" | grep -q "env node" || { echo "download failed: unexpected file contents"; rm -f "$DIR/nalu.mjs.tmp"; exit 1; }
mv "$DIR/nalu.mjs.tmp" "$DIR/nalu.mjs"

# launcher wrapper so `nalu` works everywhere
cat > "$DIR/nalu" <<'EOF'
#!/bin/sh
exec node "$HOME/.nalu/bin/nalu.mjs" "$@"
EOF
chmod +x "$DIR/nalu"

# ── put `nalu` on PATH ──
LINKED=""
for TARGET in /opt/homebrew/bin /usr/local/bin; do
  if [ -d "$TARGET" ] && [ -w "$TARGET" ]; then
    ln -sf "$DIR/nalu" "$TARGET/nalu" && LINKED="$TARGET/nalu" && break
  fi
done
if [ -z "$LINKED" ]; then
  mkdir -p "$HOME/.local/bin"
  ln -sf "$DIR/nalu" "$HOME/.local/bin/nalu"
  LINKED="$HOME/.local/bin/nalu"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *)
      case "$(basename "${SHELL:-sh}")" in
        zsh)  PROFILE="$HOME/.zshrc" ;;
        # macOS bash login shells read .bash_profile, not .bashrc
        bash) if [ "$(uname)" = "Darwin" ]; then PROFILE="$HOME/.bash_profile"; else PROFILE="$HOME/.bashrc"; fi ;;
        *)    PROFILE="$HOME/.profile" ;;
      esac
      if ! grep -qs '\.local/bin' "$PROFILE"; then
        printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$PROFILE"
      fi
      echo "Added ~/.local/bin to your PATH in $PROFILE — open a new terminal, or run:"
      echo '  export PATH="$HOME/.local/bin:$PATH"'
      ;;
  esac
fi

VER=$(node "$DIR/nalu.mjs" --version) || { echo "Install verification failed — $DIR/nalu.mjs did not run. Please retry."; exit 1; }
echo ""
echo "$VER installed  ->  $LINKED"
echo ""
echo "Start it with:   nalu"
echo "One-shot mode:   nalu -p \"your question\""
echo ""
echo "Model: auto — Nalu routes every request to the best Nalu model by itself."
