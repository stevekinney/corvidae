#!/bin/sh
# Vercel's Ignored Build Step for cinder.website (applications/playground/vercel.json).
# Vercel runs it from this application's directory before installing anything; it
# skips the deployment on exit 0, builds on exit 1, and fails the deployment on any
# other code. ignore-build.ts makes the decision. This wrapper only guarantees that
# every way that script can fail, including Bun missing from the build image, ends
# in a build rather than a failed deployment or a wrongly skipped one.
command -v bun >/dev/null 2>&1 || exit 1
if bun "$(dirname "$0")/ignore-build.ts"; then
  exit 0
fi
exit 1
