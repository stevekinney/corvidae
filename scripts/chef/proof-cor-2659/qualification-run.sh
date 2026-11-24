#!/usr/bin/env bash
set -euo pipefail
# Draft only. Run on an isolated hosted checkout after review, not on the shared host.
: "${RUNNER_TEMP:?}" "${GITHUB_SHA:?}" "${QUALIFICATION_BASE:?}"
command -v tesseract >/dev/null
command -v bun >/dev/null
command -v git >/dev/null
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
git cat-file -e "$QUALIFICATION_BASE^{commit}"
root="$RUNNER_TEMP/cor-2659"
mkdir -m 700 "$root"
test ! -e applications/interborough/tests/e2e/credential-qualification.spec.ts
test ! -e scripts/chef/qualification-scan.ts
test ! -e applications/interborough/qualification.config.ts
cp "$QUALIFICATION_RECIPE/credential-qualification.spec.ts" applications/interborough/tests/e2e/credential-qualification.spec.ts
cp "$QUALIFICATION_RECIPE/qualification-scan.ts" scripts/chef/qualification-scan.ts
cp "$QUALIFICATION_RECIPE/qualification.config.ts" applications/interborough/qualification.config.ts
trap 'rm -f applications/interborough/tests/e2e/credential-qualification.spec.ts scripts/chef/qualification-scan.ts applications/interborough/qualification.config.ts' EXIT
export QUALIFICATION_MARKER="$(bun -e 'process.stdout.write(`CONTROL${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`)')"
bun -e 'import { chromium } from "@playwright/test"; const browser = await chromium.launch(); try { const page = await browser.newPage({ viewport: { width: 1800, height: 200 } }); await page.setContent("<body style=\"font: bold 48px sans-serif\"></body>"); await page.locator("body").evaluate((element, value) => { element.textContent = value; }, process.env.QUALIFICATION_MARKER); await page.screenshot({path: process.argv[1]}); } finally { await browser.close(); }' "$root/positive.png"
export PLAYWRIGHT_JUNIT_OUTPUT_FILE="$RUNNER_TEMP/ci-replay-junit-raw.xml"
export CI_REPLAY_NO_CREDENTIALS=true
export CI_REPLAY_SELECTION=applications/interborough/tests/e2e/credential-qualification.spec.ts
export CI_REPLAY_COMMAND='env QUALIFICATION_LANE=failure QUALIFICATION_EXPECTED_FAILURE=1 bun --bun playwright test --config applications/interborough/qualification.config.ts applications/interborough/tests/e2e/credential-qualification.spec.ts --project=chromium --trace=on --reporter=line,junit'
export QUALIFICATION_LANE=success
bun scripts/chef/ci-replay.ts run -- bun --bun playwright test --config applications/interborough/qualification.config.ts applications/interborough/tests/e2e/credential-qualification.spec.ts --project=chromium --trace=on --reporter=line,junit >"$root/success.log" 2>&1
cp "$PLAYWRIGHT_JUNIT_OUTPUT_FILE" "$root/success-junit.xml"
export QUALIFICATION_LANE=failure
export QUALIFICATION_EXPECTED_FAILURE=1
set +e
bun scripts/chef/ci-replay.ts run -- env QUALIFICATION_LANE=failure QUALIFICATION_EXPECTED_FAILURE=1 bun --bun playwright test --config applications/interborough/qualification.config.ts applications/interborough/tests/e2e/credential-qualification.spec.ts --project=chromium --trace=on --reporter=line,junit >"$root/log.txt" 2>&1
status=$?
set -e
test "$status" -eq 1
test -f "$RUNNER_TEMP/ci-replay-record.json"
bun -e 'const record = await Bun.file(process.argv[1]).json(); if (record.command !== process.env.CI_REPLAY_COMMAND || record.assertion?.matcher !== "toBe") process.exit(1)' "$RUNNER_TEMP/ci-replay-record.json"
bun scripts/chef/qualification-scan.ts "$root/staged" "$root/positive.png" "$root/success" "$root/failure" "$root/log.txt" "$PLAYWRIGHT_JUNIT_OUTPUT_FILE" "$RUNNER_TEMP/ci-replay-record.json" "$QUALIFICATION_BASE" "$root/success.log" "$root/success-junit.xml"
# A reviewed workflow may upload only $root/staged after this script exits zero.
