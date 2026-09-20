#!/usr/bin/env bash
# scripts/install-local.sh — install the built AppImage for the CURRENT USER, no root.
#
#   scripts/package.sh --linux AppImage && scripts/install-local.sh
#   scripts/install-local.sh --uninstall
#
# Puts the AppImage in ~/.local/bin, the icon in the hicolor theme and a .desktop entry in
# ~/.local/share/applications, so "Solomon's Judgment" appears in the launcher with its icon and the
# running window is matched back to it (StartupWMClass). The system-wide alternative is the .deb:
# `sudo dpkg -i build/dist/solomons-judgment-*.deb`, which needs root and installs to /opt.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)

APP_ID=solomons-judgment
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
TARGET="$BIN_DIR/$APP_ID.AppImage"
ENTRY="$DESKTOP_DIR/$APP_ID.desktop"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$TARGET" "$ENTRY"
  for sz in 32 48 64 128 256 512; do rm -f "$ICON_DIR/${sz}x${sz}/apps/$APP_ID.png"; done
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
  echo "removed $TARGET and $ENTRY"
  exit 0
fi

image=$(ls -t "$root"/build/dist/*.AppImage 2>/dev/null | head -1 || true)
[ -n "$image" ] || { echo "install-local.sh: no AppImage in build/dist — run scripts/package.sh --linux AppImage" >&2; exit 2; }

mkdir -p "$BIN_DIR" "$DESKTOP_DIR"
install -m 755 "$image" "$TARGET"

# Icons at every size the theme looks in, so the launcher and the dock both find one.
for sz in 32 48 64 128 256; do
  src="$root/desktop/assets/icon-$sz.png"
  [ -f "$src" ] || continue
  mkdir -p "$ICON_DIR/${sz}x${sz}/apps"
  install -m 644 "$src" "$ICON_DIR/${sz}x${sz}/apps/$APP_ID.png"
done
mkdir -p "$ICON_DIR/512x512/apps"
install -m 644 "$root/desktop/assets/icon.png" "$ICON_DIR/512x512/apps/$APP_ID.png"

cat > "$ENTRY" <<ENTRY_EOF
[Desktop Entry]
Type=Application
Name=Solomon's Judgment
Comment=Claude, ChatGPT and Grok in one window, under your own logins
Exec=$TARGET %U
Icon=$APP_ID
Terminal=false
Categories=Development;
StartupWMClass=triplex-desktop
ENTRY_EOF
chmod 644 "$ENTRY"

update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
gtk-update-icon-cache -q -t -f "$ICON_DIR" 2>/dev/null || true

echo "installed:"
echo "  app    $TARGET"
echo "  entry  $ENTRY"
echo "  icons  $ICON_DIR/<size>/apps/$APP_ID.png"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "  note: $BIN_DIR is not on PATH; the launcher entry works regardless" ;; esac
