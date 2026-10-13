#!/bin/sh
# Vercel's Ignored Build Step for cinder.website (applications/playground/vercel.json).
# Vercel runs it from this application's directory before installing anything, and
# skips the deployment when it exits 0 and builds when it exits 1; any other exit
# fails the deployment. Build whenever there is no previous deployment to compare
# against, when the previous commit is not in the clone (a force-pushed branch), or
# when anything the static export reads changed.
if [ -z "$VERCEL_GIT_PREVIOUS_SHA" ]; then
  exit 1
fi
git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" "$VERCEL_GIT_COMMIT_SHA" -- \
  ':/applications/playground' \
  ':/components' \
  ':/packages' \
  ':/internal' \
  ':/package.json' \
  ':/bun.lock' \
  ':/bunfig.toml' \
  ':/turbo.json' \
  ':(top,glob)tsconfig*.json' \
  ':/scripts/mirror/package-map.json' && exit 0
exit 1
