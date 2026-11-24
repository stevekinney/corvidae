#!/usr/bin/env bash
set -eo pipefail
affected="$(bunx turbo ls --affected --output=json | jq -r '.packages.items[].name')"
workflow=false
if git diff --name-only "$TURBO_SCM_BASE...HEAD" | grep -qx '.github/workflows/browser-suites.yml'; then
  workflow=true
fi
reaches() { [ "$workflow" = true ] || grep -qx "$1" <<< "$affected"; }
if reaches @lostgradient/browser-fixtures; then fixtures=true; else fixtures=false; fi
if reaches @lostgradient/interborough; then interborough=true; else interborough=false; fi
echo "fixtures=$fixtures" >> "$GITHUB_OUTPUT"
echo "interborough=$interborough" >> "$GITHUB_OUTPUT"
echo "Chromium fixtures: $fixtures; Interborough end-to-end: $interborough"
