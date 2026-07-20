#!/usr/bin/env bash
# Build the native Tokentrail menu-bar app (prototype).
#
#   ./build.sh          → compile binary + bundle dist/Tokentrail.app
#   ./build.sh run      → build, then launch the .app
#   ./build.sh preview  → build, render the panel to a PNG (headless)
#
# Reuses docs/logo.png for the icon (same sips/iconutil path as the
# existing launcher Makefile).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
DIST="$DIR/dist"
APP="$DIST/Tokentrail.app"
BIN="$DIST/tokentrail-menubar"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.0.0)"

mkdir -p "$DIST"

echo "→ compiling (Swift $(swift --version 2>/dev/null | grep -o 'version [0-9.]*' | head -1))"
swiftc -parse-as-library -O \
  -o "$BIN" \
  "$DIR/Sources/Tokentrail.swift"

# --- bundle ---
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Tokentrail"
chmod +x "$APP/Contents/MacOS/Tokentrail"

# LSUIElement=1 → menu-bar agent, no Dock icon.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Tokentrail</string>
  <key>CFBundleDisplayName</key><string>Tokentrail</string>
  <key>CFBundleIdentifier</key><string>com.benjaminloschen.tokentrail.menubar</string>
  <key>CFBundleExecutable</key><string>Tokentrail</string>
  <key>CFBundleIconFile</key><string>Tokentrail</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# --- icon (best-effort; skip if logo missing) ---
ICON_SRC="$ROOT/docs/logo.png"
if [ -f "$ICON_SRC" ]; then
  ICONSET="$DIST/Tokentrail.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    dbl=$((size * 2))
    sips -s format png -z $size $size "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null 2>&1 || true
    sips -s format png -z $dbl $dbl "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns -o "$APP/Contents/Resources/Tokentrail.icns" "$ICONSET" >/dev/null 2>&1 || true
  rm -rf "$ICONSET"
fi

# Ad-hoc sign so Gatekeeper is happy on the local machine.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "→ built $APP (v$VERSION)"

case "${1:-}" in
  run)     open "$APP" ;;
  preview) "$APP/Contents/MacOS/Tokentrail" --render-png "$DIST/preview.png" ;;
esac
