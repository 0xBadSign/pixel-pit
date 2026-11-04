#!/usr/bin/env bash
# LAYOUT test (§5.11): the compiled storage layout must equal docs/storage-layout.json.
# Usage: script/check-layout.sh          -> diff, exit 1 on drift
#        script/check-layout.sh --regen  -> rewrite docs/storage-layout.json from the current build
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--regen" ]; then
  forge inspect PixelPit storage-layout --json > docs/storage-layout.json
  echo "regenerated docs/storage-layout.json"
  exit 0
fi
forge inspect PixelPit storage-layout --json | diff - docs/storage-layout.json && echo "LAYOUT OK: storage layout matches docs/storage-layout.json"
