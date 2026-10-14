#!/bin/sh
# Vercel's Ignored Build Step for cinder.website (applications/playground/vercel.json).
# Vercel runs it from this application's directory before installing anything, and
# skips the deployment when it exits 0. Build whenever there is no previous
# deployment to compare against, or when anything the static export reads changed.
#
# Vercel builds only on exit 1 and fails the deployment on any other non-zero code,
# so every outcome other than "nothing relevant changed" must exit exactly 1. The
# previous SHA is the branch's last successful deployment, and it can be absent from
# Vercel's shallow clone: a force-push after an amend or rebase orphans it, and a
# branch can fall further behind than the clone reaches. Without a commit to compare
# against, build.
if [ -z "$VERCEL_GIT_PREVIOUS_SHA" ]; then
  exit 1
fi
if ! git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA^{commit}" 2>/dev/null; then
  echo "Previous deployment commit $VERCEL_GIT_PREVIOUS_SHA is not in this clone; building." >&2
  exit 1
fi
if git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" "$VERCEL_GIT_COMMIT_SHA" -- \
  ':/applications/playground' \
  ':/components' \
  ':/packages' \
  ':/internal' \
  ':/package.json' \
  ':/bun.lock' \
  ':/bunfig.toml' \
  ':/turbo.json' \
  ':(top,glob)tsconfig*.json' \
  ':/scripts/mirror/package-map.json'; then
  exit 0
fi
exit 1
