#!/usr/bin/env bash
set -eo pipefail
printf '%s\n' /usr/lib/postgresql/*/bin | tail -n 1 >> "$GITHUB_PATH"
