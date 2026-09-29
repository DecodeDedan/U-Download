#!/usr/bin/env bash
#
# install-macos.sh: install or reinstall the latest U-Download on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/DecodeDedan/U-Download/main/scripts/install-macos.sh | bash
#
# Why this exists: U-Download is ad-hoc signed, not signed with an Apple
# Developer ID or notarized. A DMG opened from a browser download carries the
# com.apple.quarantine flag, and Gatekeeper rejects any quarantined app that
# is not notarized ("Apple could not verify ... is free of malware", with
# Move to Bin). curl does not set that flag, so an app installed from a
# curl-fetched DMG is never put to Gatekeeper. That is how it runs on a
# developer's own Mac, and the in-app updater downloads the same way, so later
# updates arrive without the dialog too.
#
# What it does: picks the DMG for this Mac's CPU (Apple Silicon or Intel) from
# the latest GitHub release, checks it against the sha256 GitHub publishes for
# that asset, and copies U-Download.app into /Applications (or ~/Applications
# if /Applications is not writable). Nothing else on the system is changed.
#
# Environment:
#   INSTALL_DIR  install somewhere other than /Applications (does not launch)
#   DMG_FILE     install from a DMG already fetched with curl, skipping the
#                download; its sha256 is still checked against the release

set -euo pipefail

REPO="DecodeDedan/U-Download"
APP_NAME="U-Download.app"
API_URL="https://api.github.com/repos/$REPO/releases/latest"
CURL_ARGS=(--fail --silent --show-error --location --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20)

log()  { printf '==> %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. See https://github.com/$REPO/releases/latest for other platforms."

# A shell running under Rosetta reports x86_64 on Apple Silicon; the native
# build is the one to install there.
dmg_arch() {
  if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    echo "aarch64"
    return
  fi
  case "$(uname -m)" in
    arm64)  echo "aarch64" ;;
    x86_64) echo "x64" ;;
    *)      fail "Unsupported CPU architecture: $(uname -m)" ;;
  esac
}

# Prints "<download url> <sha256>" for the latest-release asset ending in $1.
# JavaScript for Automation ships with every macOS, so no jq/python needed.
resolve_asset() {
  local suffix="$1" json out
  json="$(curl "${CURL_ARGS[@]}" -H "Accept: application/vnd.github+json" "$API_URL")" \
    || fail "Could not reach GitHub to find the latest release."
  if ! out="$(RELEASE_JSON="$json" SUFFIX="$suffix" osascript -l JavaScript -e '
    const env = $.NSProcessInfo.processInfo.environment;
    const read = (k) => ObjC.unwrap(env.objectForKey(k));
    const release = JSON.parse(read("RELEASE_JSON"));
    const asset = (release.assets || []).find((a) => a.name.endsWith(read("SUFFIX")));
    if (!asset) throw new Error("no asset ending in " + read("SUFFIX") + " in " + release.tag_name);
    if (!/^sha256:[0-9a-f]{64}$/.test(asset.digest || "")) throw new Error("GitHub published no sha256 for " + asset.name);
    asset.browser_download_url + " " + asset.digest.slice("sha256:".length);
  ' 2>&1)"; then
    fail "Could not find a macOS download in the latest release: $out"
  fi
  echo "$out"
}

ARCH="$(dmg_arch)"
log "Mac CPU: $([ "$ARCH" = "aarch64" ] && echo "Apple Silicon" || echo "Intel")"

read -r DMG_URL DMG_SHA256 <<<"$(resolve_asset "_${ARCH}.dmg")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/u-download-install.XXXXXX")"
MOUNT="$WORK/mnt"
cleanup() {
  if [ -d "$MOUNT" ]; then hdiutil detach -quiet "$MOUNT" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -n "${DMG_FILE:-}" ]; then
  [ -f "$DMG_FILE" ] || fail "DMG_FILE does not exist: $DMG_FILE"
  DMG="$DMG_FILE"
  log "Using $DMG"
else
  DMG="$WORK/$(basename "$DMG_URL")"
  log "Downloading $(basename "$DMG_URL")"
  curl "${CURL_ARGS[@]}" --progress-bar -o "$DMG" "$DMG_URL" || fail "Download failed: $DMG_URL"
fi

ACTUAL_SHA256="$(shasum -a 256 "$DMG" | awk '{print $1}')"
[ "$ACTUAL_SHA256" = "$DMG_SHA256" ] \
  || fail "Checksum mismatch for $(basename "$DMG_URL"): expected $DMG_SHA256, got $ACTUAL_SHA256. Not installing."
log "Checksum OK"

if [ -n "${INSTALL_DIR:-}" ]; then
  DEST_DIR="$INSTALL_DIR"
elif [ -w /Applications ]; then
  DEST_DIR="/Applications"
else
  DEST_DIR="$HOME/Applications"
fi
mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/$APP_NAME"

mkdir -p "$MOUNT"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" || fail "Could not open the disk image."
[ -d "$MOUNT/$APP_NAME" ] || fail "$APP_NAME not found inside the disk image."
codesign --verify --deep --strict "$MOUNT/$APP_NAME" 2>/dev/null \
  || fail "$APP_NAME in the disk image failed its code-signature check. Not installing."

# Replacing a running app leaves the old process on deleted files.
if pgrep -xq "u-download"; then
  log "Quitting the running U-Download"
  osascript -e 'tell application "U-Download" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq "u-download" || break; sleep 1; done
  if pgrep -xq "u-download"; then
    fail "U-Download is still running. Quit it from the tray icon and run this again."
  fi
fi

# Stage beside the destination and swap, so a failed copy never leaves the
# user with no app at all.
STAGED="$DEST_DIR/.$APP_NAME.installing"
rm -rf "$STAGED"
ditto "$MOUNT/$APP_NAME" "$STAGED"
rm -rf "$DEST"
mv "$STAGED" "$DEST"

VERSION="$(defaults read "$DEST/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "unknown")"
log "Installed U-Download $VERSION to $DEST"
if [ -z "${INSTALL_DIR:-}" ]; then
  open "$DEST"
fi
