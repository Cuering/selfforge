#!/usr/bin/env bash
# selfforge one-command installer: downloads the repo and runs install.sh
set -euo pipefail

REPO="https://github.com/Cuering/selfforge.git"
TMP="$(mktemp -d)"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "selfforge remote installer"
echo "=========================="
echo "[1/2] Downloading selfforge..."
if command -v git >/dev/null 2>&1; then
  git clone --depth 1 "$REPO" "$TMP/selfforge"
else
  echo "git not found — install git and re-run." >&2
  exit 1
fi

echo "[2/2] Installing..."
bash "$TMP/selfforge/install.sh" "$TMP/selfforge"
