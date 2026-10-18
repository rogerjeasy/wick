#!/usr/bin/env bash
# Draws docs/architecture/architecture-{light,dark}.png from architecture.html,
# at twice the size, with Chrome headless. Run from the repository root.
set -euo pipefail
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PAGE="file://$(pwd)/docs/architecture/architecture.html"
for theme in light dark; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1600,1000 --virtual-time-budget=2000 \
    --screenshot="docs/architecture/architecture-$theme.png" "$PAGE?theme=$theme" >/dev/null 2>&1
done
echo "wrote docs/architecture/architecture-light.png and architecture-dark.png"
