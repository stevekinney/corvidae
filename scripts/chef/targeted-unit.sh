#!/usr/bin/env bash
set -eo pipefail
read -r -a paths <<< "$UNIT_PATHS"
reporter=(--reporter=junit "--reporter-outfile=$RUNNER_TEMP/ci-replay-junit-raw.xml")

if [ "$UNIT_WORKSPACE" = . ]; then
  bun scripts/bun-test.ts "${reporter[@]}" "${paths[@]}"
  exit
fi
if [ "$UNIT_WORKSPACE" = scripts/browser-fixtures ]; then
  bun scripts/browser-fixtures/scripts/prepare-manifest.ts
  (cd "$UNIT_WORKSPACE" && bun test "${reporter[@]}" --conditions browser --conditions svelte "${paths[@]}")
  bun scripts/browser-fixtures/scripts/verify-curated-build.ts
  exit
fi
cd "$UNIT_WORKSPACE"
config=()
if [ -z "$UNIT_CONFIG" ] && [ "$UNIT_WORKSPACE" = applications/interborough ]; then
  host=0
  for path in "${paths[@]}"; do
    case "$path" in src/host|src/host/*|fixtures|fixtures/*) host=1 ;; esac
  done
  if [ "$host" = 0 ]; then UNIT_CONFIG=./bunfig.ui.toml; fi
  if [ "$host" = 1 ]; then echo "::notice::host-lane paths run under the default bunfig; dispatch UI tests separately with unit_config=./bunfig.ui.toml"; fi
fi
if [ -n "$UNIT_CONFIG" ]; then config=("--config=$UNIT_CONFIG"); fi
conditions=(--conditions browser --conditions svelte)
if [ -z "$UNIT_CONFIG" ] && [ "$UNIT_WORKSPACE" = applications/interborough ]; then
  conditions=()
fi
if [ "$UNIT_WORKSPACE" = applications/playground ]; then
  bun test "${reporter[@]}" --isolate "${config[@]}" "${conditions[@]}" "${paths[@]}"
  exit
fi
bun test "${reporter[@]}" "${config[@]}" "${conditions[@]}" "${paths[@]}"
